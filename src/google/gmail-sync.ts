/**
 * Gmail Sync — extracts knowledge from email threads into memory.
 *
 * Smart filtering to handle email's high noise ratio:
 *   - Skip automated/no-reply senders
 *   - Skip newsletters (unsubscribe signals)
 *   - Skip CC-only threads where owner never participated
 *   - Prioritize threads where owner is direct sender/recipient
 *
 * Conservative scoring: email facts get lower confidence (0.6-0.8)
 * than documents (0.85) or direct Slack statements (1.0). The
 * consolidation pipeline handles pruning over time.
 *
 * Source format: gmail:{threadId}:{date}
 */

import { google } from 'googleapis';
import type Anthropic from '@anthropic-ai/sdk';
import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logger.js';
import { getPrompts } from '../prompts.js';
import { getConfig } from '../config.js';
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

export interface GmailSyncResult {
  threadsScanned: number;
  threadsExtracted: number;
  threadsSkipped: number;
  threadsFiltered: number;
  factsExtracted: number;
  commitmentsExtracted: number;
  peopleExtracted: number;
}

interface ParsedThread {
  threadId: string;
  subject: string;
  date: string;
  messages: Array<{
    from: string;
    to: string;
    date: string;
    body: string;
    isOwner: boolean;
  }>;
  ownerParticipated: boolean;
}

// ── Pre-filters ──

/** Senders to always skip */
const JUNK_SENDER_PATTERNS = [
  /no-?reply@/i,
  /noreply@/i,
  /notifications?@/i,
  /mailer-daemon@/i,
  /postmaster@/i,
  /calendar-notification@/i,
  /notify@/i,
  /donotreply@/i,
  /automated@/i,
  /newsletter@/i,
  /marketing@/i,
  /support@.*\.zendesk\.com/i,
  /.*@github\.com$/i,
  /.*@linkedin\.com$/i,
  /.*@slack\.com$/i,
  /.*@google\.com$/i,
  /.*@atlassian\.com$/i,
  /.*@jira\.com$/i,
];

/** Check if an email body contains newsletter/marketing signals */
function isLikelyNewsletter(body: string, headers: Array<{ name?: string | null; value?: string | null }>): boolean {
  // List-Unsubscribe header is a strong newsletter signal
  if (headers.some(h => h.name?.toLowerCase() === 'list-unsubscribe')) return true;
  // Body-level signals
  const lower = body.toLowerCase();
  if (lower.includes('unsubscribe') && lower.includes('preferences')) return true;
  if (lower.includes('you are receiving this email because')) return true;
  if (lower.includes('view in browser') || lower.includes('view as webpage')) return true;
  return false;
}

function isJunkSender(from: string): boolean {
  return JUNK_SENDER_PATTERNS.some(p => p.test(from));
}

// ── Sync engine ──

/**
 * Sync recent email threads into long-term memory.
 * Filters junk, extracts action items and facts from real conversations.
 */
export async function syncGmail(
  auth: InstanceType<typeof google.auth.OAuth2>,
  db: DatabaseSync,
  anthropicClient: Anthropic,
  classifierModel: string,
  ownerEmail: string,
  opts?: { daysBack?: number; maxThreads?: number },
): Promise<GmailSyncResult> {
  const gmail = google.gmail({ version: 'v1', auth });
  const daysBack = opts?.daysBack ?? 7;
  const maxThreads = opts?.maxThreads ?? 50;

  logger.info({ daysBack, maxThreads }, 'Starting Gmail sync');

  // Search for threads (not individual messages)
  const afterDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
  const afterStr = `${afterDate.getFullYear()}/${String(afterDate.getMonth() + 1).padStart(2, '0')}/${String(afterDate.getDate()).padStart(2, '0')}`;

  let threadIds: string[] = [];
  let pageToken: string | undefined;

  while (threadIds.length < maxThreads) {
    const result = await gmail.users.threads.list({
      userId: 'me',
      q: `after:${afterStr}`,
      maxResults: Math.min(50, maxThreads - threadIds.length),
      pageToken,
    });

    for (const t of result.data.threads ?? []) {
      if (t.id) threadIds.push(t.id);
    }

    pageToken = result.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  logger.info({ threadsFound: threadIds.length }, 'Gmail threads listed');

  // Delta detection: filter out already-synced threads
  const newThreadIds = threadIds.filter(id => {
    const existing = db.prepare(
      "SELECT id FROM memories WHERE source LIKE ? AND valid_until IS NULL LIMIT 1"
    ).get(`gmail:${id}:%`);
    return !existing;
  });

  const skipped = threadIds.length - newThreadIds.length;
  logger.info({ newThreads: newThreadIds.length, alreadySynced: skipped }, 'Delta detection complete');

  let threadsExtracted = 0;
  let threadsFiltered = 0;
  let factsExtracted = 0;
  let commitmentsExtracted = 0;
  let peopleExtracted = 0;

  // Process in parallel batches
  const BATCH_SIZE = 5;
  for (let batchStart = 0; batchStart < newThreadIds.length; batchStart += BATCH_SIZE) {
    const batch = newThreadIds.slice(batchStart, batchStart + BATCH_SIZE);

    // Fetch threads in parallel
    const fetchedThreads = await Promise.all(batch.map(async (threadId) => {
      try {
        const thread = await gmail.users.threads.get({
          userId: 'me',
          id: threadId,
          format: 'full',
        });
        return { threadId, data: thread.data, error: null };
      } catch (error) {
        return { threadId, data: null, error: error instanceof Error ? error.message : String(error) };
      }
    }));

    // Parse, filter, and extract sequentially (DB writes)
    for (const { threadId, data, error } of fetchedThreads) {
      if (!data || error) {
        logger.debug({ threadId, error }, 'Failed to fetch thread');
        continue;
      }

      const messages = data.messages ?? [];
      if (messages.length === 0) continue;

      // Parse the thread
      const parsed = parseThread(threadId, messages as unknown as Array<Record<string, unknown>>, ownerEmail);

      // Pre-filter: skip junk
      const firstFrom = parsed.messages[0]?.from ?? '';
      if (isJunkSender(firstFrom)) {
        threadsFiltered++;
        continue;
      }

      // Pre-filter: skip newsletters
      const firstHeaders = messages[0]?.payload?.headers ?? [];
      const firstBody = parsed.messages[0]?.body ?? '';
      if (isLikelyNewsletter(firstBody, firstHeaders)) {
        threadsFiltered++;
        continue;
      }

      // Pre-filter: skip CC-only threads where owner never participated
      if (!parsed.ownerParticipated && parsed.messages.length > 2) {
        threadsFiltered++;
        continue;
      }

      // Extract facts via Haiku
      try {
        const result = await extractEmailThread(db, anthropicClient, classifierModel, parsed);
        factsExtracted += result.factsExtracted;
        commitmentsExtracted += result.commitmentsExtracted;
        peopleExtracted += result.peopleExtracted;
        threadsExtracted++;

        if (result.factsExtracted > 0) {
          logger.info({
            threadId,
            subject: parsed.subject.slice(0, 60),
            facts: result.factsExtracted,
            commitments: result.commitmentsExtracted,
          }, 'Email thread synced');
        }
      } catch (error) {
        logger.warn({
          error: error instanceof Error ? error.message : String(error),
          threadId,
        }, 'Email extraction failed — skipping');
      }
    }
  }

  const result: GmailSyncResult = {
    threadsScanned: threadIds.length,
    threadsExtracted,
    threadsSkipped: skipped,
    threadsFiltered,
    factsExtracted,
    commitmentsExtracted,
    peopleExtracted,
  };

  logger.info(result, 'Gmail sync complete');
  return result;
}

// ── Helpers ──

function parseThread(
  threadId: string,
  messages: Array<Record<string, unknown>>,
  ownerEmail: string,
): ParsedThread {
  const ownerLower = ownerEmail.toLowerCase();
  const parsed: ParsedThread = {
    threadId,
    subject: '',
    date: '',
    messages: [],
    ownerParticipated: false,
  };

  for (const msg of messages) {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const headers = (payload?.headers ?? []) as Array<{ name?: string | null; value?: string | null }>;

    const from = headers.find(h => h.name === 'From')?.value ?? 'unknown';
    const to = headers.find(h => h.name === 'To')?.value ?? '';
    const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
    const date = headers.find(h => h.name === 'Date')?.value ?? '';

    if (!parsed.subject && subject) parsed.subject = subject;
    if (!parsed.date && date) parsed.date = date;

    // Extract body
    let body = '';
    const payloadBody = payload?.body as Record<string, unknown> | undefined;
    if (payloadBody?.data) {
      body = Buffer.from(payloadBody.data as string, 'base64').toString('utf-8');
    } else {
      const parts = (payload?.parts ?? []) as Array<Record<string, unknown>>;
      const textPart = parts.find(p => (p.mimeType as string) === 'text/plain');
      const textBody = textPart?.body as Record<string, unknown> | undefined;
      if (textBody?.data) {
        body = Buffer.from(textBody.data as string, 'base64').toString('utf-8');
      }
    }

    const isOwner = from.toLowerCase().includes(ownerLower);
    if (isOwner) parsed.ownerParticipated = true;

    parsed.messages.push({
      from,
      to,
      date,
      body: body.slice(0, 2000),
      isOwner,
    });
  }

  return parsed;
}

async function extractEmailThread(
  db: DatabaseSync,
  client: Anthropic,
  model: string,
  thread: ParsedThread,
): Promise<{ factsExtracted: number; commitmentsExtracted: number; peopleExtracted: number }> {
  const source = `gmail:${thread.threadId}:${thread.date}`;

  // Build extraction input
  const messageParts = thread.messages.map(m => {
    const label = m.isOwner ? '[OWNER]' : '[EXTERNAL]';
    return `${label} From: ${m.from}\nTo: ${m.to}\nDate: ${m.date}\n\n${m.body}`;
  });

  const input = [
    `Email Thread: "${thread.subject}"`,
    `Messages: ${thread.messages.length}`,
    `Owner participated: ${thread.ownerParticipated ? 'yes' : 'no (CC only)'}`,
    '',
    ...messageParts,
  ].join('\n\n---\n\n');

  // Extract via Haiku
  let facts: Array<Record<string, unknown>> = [];
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 4096,
      system: getPrompts().emailExtraction,
      messages: [{ role: 'user', content: input.slice(0, 15000) }],
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
        if (parsed.facts && Array.isArray(parsed.facts)) facts = parsed.facts;
      } catch { /* skip */ }
    }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Email extraction API call failed');
    return { factsExtracted: 0, commitmentsExtracted: 0, peopleExtracted: 0 };
  }

  // If nothing extracted, still store a minimal thread summary so delta detection skips it next time
  if (facts.length === 0) {
    insertMemory(db, {
      type: 'fact',
      content: `Email thread "${thread.subject}" (${thread.messages.length} messages, ${thread.date}) — no actionable content extracted. [source: Gmail]`,
      source,
      importance: 1,
      confidence: 0.5,
      entities: [],
    });
    return { factsExtracted: 0, commitmentsExtracted: 0, peopleExtracted: 0 };
  }

  // Store extracted facts
  const newMemoryIds: { id: string; content: string }[] = [];
  let factsExtracted = 0;
  let commitmentsExtracted = 0;

  for (const rawFact of facts) {
    const fact = rawFact as Record<string, unknown>;
    if (!fact.content || !fact.type) continue;

    const factContent = String(fact.content).slice(0, 500);
    const factType = fact.type as string;
    const confidence = Math.max(0, Math.min(1, Number(fact.confidence) || 0.65));
    const importance = Math.max(1, Math.min(10, Math.round(Number(fact.importance) || 4)));
    const entities = Array.isArray(fact.entities) ? fact.entities.map(String) : [];

    // Check for duplicates
    const duplicates = findDuplicates(db, factContent, factType as 'fact');
    const closeMatch = duplicates.find(d => contentSimilarity(d.content, factContent) > 0.7);

    if (closeMatch) {
      // Only supersede if we have higher confidence
      if (confidence > closeMatch.confidence) {
        const newId = insertMemory(db, {
          type: factType as 'fact',
          content: factContent,
          source,
          importance,
          confidence,
          entities,
        });
        supersedeMemory(db, closeMatch.id, newId);
        deleteEmbedding(db, closeMatch.id);
        newMemoryIds.push({ id: newId, content: factContent });
        factsExtracted++;
        if (factType === 'commitment') commitmentsExtracted++;
      }
    } else {
      const newId = insertMemory(db, {
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

  // Batch embed
  if (newMemoryIds.length > 0 && hasVectorSupport(db)) {
    try {
      const embeddings = await embedBatch(newMemoryIds.map(m => m.content));
      for (let i = 0; i < newMemoryIds.length; i++) {
        insertEmbedding(db, newMemoryIds[i].id, embeddings[i]);
      }
    } catch { /* non-critical */ }
  }

  return { factsExtracted, commitmentsExtracted, peopleExtracted: 0 };
}
