/**
 * Meeting Sync — extracts knowledge from Fireflies transcripts into memory.
 *
 * Three tiers (mirroring Drive sync):
 *   Tier 1 (Index): meeting metadata — stored during sync scan
 *   Tier 2 (Summary): Fireflies AI summary + action items → memory
 *   Tier 3 (Deep Read): full transcript → chunked extraction → memory
 *
 * Delta detection: check memories table for existing fireflies:{id}:* entries.
 * Meetings are immutable after recording — no "modified" state to track.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getPrompts } from '../prompts.js';
import { FirefliesClient, formatMeetingDate, type TranscriptSummary } from './api.js';
import {
  insertMemory,
  findDuplicates,
  supersedeMemory,
  deleteEmbedding,
  hasVectorSupport,
  insertEmbedding,
} from '../memory/store.js';
import { contentSimilarity } from '../memory/extractor.js';
import { embedBatch } from '../memory/embeddings.js';

// ── Types ──

export interface MeetingSyncResult {
  meetingsScanned: number;
  newMeetings: number;
  skippedMeetings: number;
  factsExtracted: number;
  commitmentsExtracted: number;
  peopleExtracted: number;
}

// ── Sync engine ──

/**
 * Sync recent meetings from Fireflies into long-term memory.
 * Tier 2 (summary) extraction happens for all new meetings.
 */
export async function syncMeetings(
  client: FirefliesClient,
  db: Sql,
  anthropicClient: Anthropic,
  classifierModel: string,
  synthesisModel: string,
  opts?: { daysBack?: number; maxTranscripts?: number },
): Promise<MeetingSyncResult> {
  const daysBack = opts?.daysBack ?? 7;
  const maxTranscripts = opts?.maxTranscripts ?? 20;

  logger.info({ daysBack, maxTranscripts }, 'Starting Fireflies meeting sync');

  // Fetch recent transcripts
  const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
  const transcripts = await client.listTranscripts({
    limit: maxTranscripts,
    fromDate,
  });

  logger.info({ meetingsFound: transcripts.length }, 'Fireflies transcripts listed');

  let newMeetings = 0;
  let skippedMeetings = 0;
  let factsExtracted = 0;
  let commitmentsExtracted = 0;
  let peopleExtracted = 0;

  // Delta detection: filter to only new meetings
  const newTranscripts: typeof transcripts = [];
  for (const meta of transcripts) {
    const existingPattern = `fireflies:${meta.id}:%`;
    const [existing] = await db`
      SELECT id FROM memories WHERE source LIKE ${existingPattern} AND valid_until IS NULL LIMIT 1
    `;
    if (existing) {
      skippedMeetings++;
    } else {
      newTranscripts.push(meta);
    }
  }

  logger.info({ newMeetings: newTranscripts.length, skipped: skippedMeetings }, 'Delta detection complete');

  // Fetch summaries in parallel batches, write to DB sequentially
  const BATCH_SIZE = 5;
  for (let batchStart = 0; batchStart < newTranscripts.length; batchStart += BATCH_SIZE) {
    const batch = newTranscripts.slice(batchStart, batchStart + BATCH_SIZE);

    // Fetch summaries from Fireflies API in parallel
    const summaries = await Promise.all(batch.map(async (meta) => {
      try {
        const summary = await client.getTranscriptSummary(meta.id);
        return { meta, summary, error: null };
      } catch (error) {
        return { meta, summary: null, error: error instanceof Error ? error.message : String(error) };
      }
    }));

    // Extract and store sequentially (DB writes)
    for (const { meta, summary, error } of summaries) {
      if (!summary) {
        logger.warn({ error, id: meta.id, title: meta.title }, 'Failed to fetch meeting summary — skipping');
        continue;
      }

      try {
        const result = await extractMeetingSummary(db, anthropicClient, classifierModel, synthesisModel, summary);
        factsExtracted += result.factsExtracted;
        commitmentsExtracted += result.commitmentsExtracted;
        peopleExtracted += result.peopleExtracted;
        newMeetings++;

        logger.info({
          id: meta.id,
          title: meta.title,
          facts: result.factsExtracted,
          commitments: result.commitmentsExtracted,
        }, 'Meeting synced');
      } catch (error) {
        logger.warn({
          error: error instanceof Error ? error.message : String(error),
          id: meta.id,
          title: meta.title,
        }, 'Failed to extract meeting — skipping');
      }
    }
  }

  const result: MeetingSyncResult = {
    meetingsScanned: transcripts.length,
    newMeetings,
    skippedMeetings,
    factsExtracted,
    commitmentsExtracted,
    peopleExtracted,
  };

  logger.info(result, 'Fireflies meeting sync complete');
  return result;
}

/**
 * Extract facts from a meeting summary (Tier 2) into memory.
 * Uses the meeting extraction prompt with Haiku, optionally refined by Sonnet.
 */
async function extractMeetingSummary(
  db: Sql,
  client: Anthropic,
  classifierModel: string,
  synthesisModel: string,
  transcript: TranscriptSummary,
): Promise<{ factsExtracted: number; commitmentsExtracted: number; peopleExtracted: number }> {
  const date = formatMeetingDate(transcript.date);
  const isoDate = new Date(transcript.date).toISOString();
  const source = `fireflies:${transcript.id}:${isoDate}`;
  const speakers = transcript.speakers.map(s => s.name).join(', ');

  // Build extraction input from meeting metadata + summary
  const input = [
    `Meeting: "${transcript.title}"`,
    `Date: ${date}`,
    `Speakers: ${speakers}`,
    transcript.participants.length > 0 ? `Participants: ${transcript.participants.join(', ')}` : '',
    '',
    transcript.summary.overview ? `Overview:\n${transcript.summary.overview}` : '',
    transcript.summary.action_items ? `\nAction Items:\n${transcript.summary.action_items}` : '',
    transcript.summary.outline ? `\nOutline:\n${transcript.summary.outline}` : '',
  ].filter(Boolean).join('\n');

  // Extract facts via Haiku
  let facts: Array<Record<string, unknown>> = [];
  try {
    const response = await client.messages.create({
      model: classifierModel,
      max_tokens: 4096,
      system: getPrompts().meetingExtraction,
      messages: [{ role: 'user', content: input }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed.facts && Array.isArray(parsed.facts)) {
        facts = parsed.facts;
      }
    } catch {
      // Try salvaging truncated JSON
      const salvaged = jsonStr.replace(/,\s*\{[^}]*$/, '') + ']}';
      try {
        const parsed = JSON.parse(salvaged);
        if (parsed.facts && Array.isArray(parsed.facts)) {
          facts = parsed.facts;
        }
      } catch {
        logger.warn({ title: transcript.title }, 'Meeting extraction returned unparseable JSON');
      }
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Meeting extraction failed');
    return { factsExtracted: 0, commitmentsExtracted: 0, peopleExtracted: 0 };
  }

  // Store meeting summary as a top-level memory (like file summaries)
  const summaryContent = transcript.summary.overview
    ? `Meeting "${transcript.title}" (${date}, speakers: ${speakers}): ${transcript.summary.overview} [source: Fireflies]`
    : `Meeting "${transcript.title}" on ${date} with ${speakers} [source: Fireflies]`;

  const allEntities = [
    ...transcript.speakers.map(s => s.name),
    ...extractEntitiesFromTitle(transcript.title),
  ];

  const summaryMemoryId = await insertMemory(db, {
    type: 'fact',
    content: summaryContent,
    source,
    importance: 5,
    confidence: 0.85,
    entities: allEntities,
  });

  // Store extracted facts
  const newMemoryIds: { id: string; content: string }[] = [
    { id: summaryMemoryId, content: summaryContent },
  ];
  let factsExtracted = 0;
  let commitmentsExtracted = 0;

  for (const rawFact of facts) {
    const fact = rawFact as Record<string, unknown>;
    if (!fact.content || !fact.type) continue;

    const factContent = String(fact.content).slice(0, 800);
    const factType = fact.type as string;
    const confidence = Math.max(0, Math.min(1, Number(fact.confidence) || 0.75));
    const importance = Math.max(1, Math.min(10, Math.round(Number(fact.importance) || 5)));
    const entities = Array.isArray(fact.entities) ? fact.entities.map(String) : [];

    // Add speaker as entity if present
    if (fact.speaker && typeof fact.speaker === 'string') {
      if (!entities.includes(fact.speaker)) entities.push(fact.speaker);
    }

    // Check for duplicates
    const duplicates = await findDuplicates(db, factContent, factType as 'fact');
    const closeMatch = duplicates.find(d => contentSimilarity(d.content, factContent) > 0.7);

    if (closeMatch) {
      if (confidence > closeMatch.confidence) {
        const newId = await insertMemory(db, {
          type: factType as 'fact',
          content: factContent,
          source,
          importance,
          confidence,
          entities,
        });
        await supersedeMemory(db, closeMatch.id, newId);
        await deleteEmbedding(db, closeMatch.id);
        newMemoryIds.push({ id: newId, content: factContent });
        factsExtracted++;
        if (factType === 'commitment') commitmentsExtracted++;
      }
    } else {
      const newId = await insertMemory(db, {
        type: factType as 'fact',
        content: factContent,
        source,
        importance,
        confidence,
        entities,
      });
      newMemoryIds.push({ id: newId, content: factContent });
      factsExtracted++;
      if (factType === 'commitment') commitmentsExtracted++;
    }
  }

  // Batch embed all new memories
  if (newMemoryIds.length > 0 && await hasVectorSupport(db)) {
    try {
      const embeddings = await embedBatch(newMemoryIds.map(m => m.content));
      for (let i = 0; i < newMemoryIds.length; i++) {
        await insertEmbedding(db, newMemoryIds[i].id, embeddings[i]);
      }
    } catch (error) {
      logger.debug({ error }, 'Embedding generation failed for meeting facts');
    }
  }

  return { factsExtracted, commitmentsExtracted, peopleExtracted: 0 };
}

/**
 * Deep read a meeting transcript (Tier 3) — full chunked extraction.
 * Called on-demand when the user asks for detailed analysis.
 */
export async function deepReadMeeting(
  client: FirefliesClient,
  db: Sql,
  anthropicClient: Anthropic,
  classifierModel: string,
  synthesisModel: string,
  transcriptId: string,
): Promise<{ factsExtracted: number; commitmentsExtracted: number }> {
  const transcript = await client.getTranscriptFull(transcriptId);
  const date = formatMeetingDate(transcript.date);
  const isoDate = new Date(transcript.date).toISOString();
  const source = `fireflies:${transcript.id}:${isoDate}`;
  const speakers = transcript.speakers.map(s => s.name).join(', ');

  // Build full transcript text
  const transcriptText = transcript.sentences
    .map(s => `[${s.speaker_name}]: ${s.text}`)
    .join('\n');

  // Chunk the transcript
  const CHUNK_SIZE = 8000;
  const CHUNK_OVERLAP = 500;
  const chunks = chunkText(transcriptText, CHUNK_SIZE, CHUNK_OVERLAP);

  logger.info({ transcriptId, title: transcript.title, chunks: chunks.length }, 'Starting meeting deep read');

  // Extract from each chunk
  const allFacts: Array<Record<string, unknown>> = [];

  for (let i = 0; i < chunks.length; i++) {
    const chunkLabel = chunks.length > 1 ? ` (section ${i + 1}/${chunks.length})` : '';
    const input = [
      `Meeting: "${transcript.title}"${chunkLabel}`,
      `Date: ${date} | Speakers: ${speakers}`,
      '',
      chunks[i],
    ].join('\n');

    try {
      const response = await anthropicClient.messages.create({
        model: classifierModel,
        max_tokens: 4096,
        system: getPrompts().meetingExtraction,
        messages: [{ role: 'user', content: input }],
      });

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');

      const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.facts && Array.isArray(parsed.facts)) {
          allFacts.push(...parsed.facts);
        }
      } catch { /* skip unparseable chunks */ }
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error), chunk: i }, 'Chunk extraction failed');
    }
  }

  // Sonnet synthesis pass if we have enough facts
  let synthesizedFacts = allFacts;
  if (allFacts.length > 5) {
    try {
      const synthResponse = await anthropicClient.messages.create({
        model: synthesisModel,
        max_tokens: 4096,
        system: getPrompts().factSynthesis.replace('{{SOURCE_TYPE}}', 'meeting transcript'),
        messages: [{
          role: 'user',
          content: `Meeting: "${transcript.title}" (${date})\n\nRaw extracted facts (${allFacts.length} items):\n${JSON.stringify(allFacts, null, 2)}`,
        }],
      });

      const synthText = synthResponse.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('');

      const synthJson = synthText.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
      try {
        const parsed = JSON.parse(synthJson);
        if (Array.isArray(parsed)) {
          synthesizedFacts = parsed;
          logger.info({ raw: allFacts.length, synthesized: parsed.length }, 'Meeting synthesis complete');
        }
      } catch { /* use raw facts */ }
    } catch (error) {
      logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Meeting synthesis failed — using raw facts');
    }
  }

  // Store facts
  const newMemoryIds: { id: string; content: string }[] = [];
  let factsExtracted = 0;
  let commitmentsExtracted = 0;

  for (const rawFact of synthesizedFacts) {
    const fact = rawFact as Record<string, unknown>;
    if (!fact.content || !fact.type) continue;

    const factContent = String(fact.content).slice(0, 800);
    const factType = fact.type as string;
    const confidence = Math.max(0, Math.min(1, Number(fact.confidence) || 0.75));
    const importance = Math.max(1, Math.min(10, Math.round(Number(fact.importance) || 5)));
    const entities = Array.isArray(fact.entities) ? fact.entities.map(String) : [];

    const duplicates = await findDuplicates(db, factContent, factType as 'fact');
    const closeMatch = duplicates.find(d => contentSimilarity(d.content, factContent) > 0.7);

    if (!closeMatch || confidence > (closeMatch?.confidence ?? 0)) {
      const newId = await insertMemory(db, {
        type: factType as 'fact',
        content: factContent,
        source,
        importance,
        confidence,
        entities,
      });
      if (closeMatch) {
        await supersedeMemory(db, closeMatch.id, newId);
        await deleteEmbedding(db, closeMatch.id);
      }
      newMemoryIds.push({ id: newId, content: factContent });
      factsExtracted++;
      if (factType === 'commitment') commitmentsExtracted++;
    }
  }

  // Batch embed
  if (newMemoryIds.length > 0 && await hasVectorSupport(db)) {
    try {
      const embeddings = await embedBatch(newMemoryIds.map(m => m.content));
      for (let i = 0; i < newMemoryIds.length; i++) {
        await insertEmbedding(db, newMemoryIds[i].id, embeddings[i]);
      }
    } catch { /* non-critical */ }
  }

  logger.info({ transcriptId, factsExtracted, commitmentsExtracted }, 'Meeting deep read complete');
  return { factsExtracted, commitmentsExtracted };
}

// ── Helpers ──

/**
 * Extract likely entity names from a meeting title.
 */
function extractEntitiesFromTitle(title: string): string[] {
  // Simple heuristic: split on common separators, keep capitalized words
  const parts = title.split(/[-—|:,\/]/).map(p => p.trim()).filter(Boolean);
  return parts.filter(p => p.length > 2 && /[A-Z]/.test(p[0]));
}

/**
 * Split text into overlapping chunks at paragraph boundaries.
 */
function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;
    if (end < text.length) {
      const lastBreak = text.lastIndexOf('\n', end);
      if (lastBreak > start + chunkSize / 2) {
        end = lastBreak;
      }
    }
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length) break;
  }

  return chunks;
}
