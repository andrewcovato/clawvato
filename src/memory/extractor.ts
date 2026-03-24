/**
 * Memory Extractor — extracts structured facts from conversations using Haiku.
 *
 * After each agent interaction, Haiku analyzes the conversation and extracts:
 * - Facts (things that are true about the world)
 * - Preferences (how the user likes things done)
 * - Decisions (choices the user made)
 * - People info (names, roles, relationships)
 *
 * Each extraction costs ~$0.00025 (Haiku). At 100 interactions/day = $0.75/mo.
 *
 * Write-time dedup: each candidate fact is compared against existing similar
 * memories using vector similarity. Haiku judges: ADD, UPDATE, NOOP, or DELETE.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import {
  insertMemory,
  supersedeMemory,
  insertEmbedding,
  deleteEmbedding,
  getCategoryList,
  findOrCreateCategory,
  findSimilarByVector,
  type MemoryType,
  type NewMemory,
} from './store.js';
import { embedBatch } from './embeddings.js';
import { getPrompts } from '../prompts.js';
import { getConfig } from '../config.js';

/**
 * Simple word-overlap similarity for deduplication in other modules.
 * Not used by the extraction pipeline (which uses vector similarity + LLM judgment),
 * but still needed by consolidation, sync, etc.
 */
export function contentSimilarity(a: string, b: string): number {
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const wordsA = new Set(normalize(a));
  const wordsB = new Set(normalize(b));

  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let overlap = 0;
  for (const word of wordsA) {
    if (wordsB.has(word)) overlap++;
  }

  // Jaccard similarity
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? overlap / union : 0;
}

/** A fact extracted by Haiku */
export interface ExtractedFact {
  type: MemoryType;
  content: string;
  confidence: number;
  importance: number;
  entities: string[];
  domain?: string;
}

export interface ExtractionResult {
  facts: ExtractedFact[];
}

export interface StoreResult {
  memoriesStored: number;
  duplicatesSkipped: number;
  memoriesUpdated: number;
  memoriesRetired: number;
}

// Prompt loaded from config/prompts/extraction.md

/**
 * Extract facts from a conversation using Haiku.
 * Pass sql to enable dynamic category injection and auto-discovery.
 */
export async function extractFacts(
  client: Anthropic,
  model: string,
  conversation: string,
  source: string,
  sql?: Sql,
): Promise<ExtractionResult> {
  try {
    const config = getConfig();

    // Inject dynamic categories into the extraction prompt
    let systemPrompt = getPrompts().extraction;
    if (sql) {
      const categoryList = await getCategoryList(sql);
      systemPrompt = systemPrompt.replace('{{CATEGORIES}}', categoryList);
    } else {
      // Fallback: no DB available, use a static list
      systemPrompt = systemPrompt.replace('{{CATEGORIES}}', '- "fact", "preference", "decision", "observation", "strategy", "conclusion", "commitment", "technical", "research", "project"');
    }

    const response = await client.messages.create({
      model,
      max_tokens: config.memory.extractionMaxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: conversation }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Parse JSON — handle markdown wrapping, leading text, etc.
    // Extract the JSON object from anywhere in the response
    let jsonStr = text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[0];
    } else {
      jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
    }
    const parsed = JSON.parse(jsonStr);

    // Content cap: 0 = unlimited, otherwise truncate
    const maxChars = config.memory.extractionContentMaxChars;

    const facts: ExtractedFact[] = (parsed.facts ?? [])
      .filter((f: Record<string, unknown>) =>
        f.content && typeof f.content === 'string' &&
        f.type && typeof f.type === 'string'
      )
      .map((f: Record<string, unknown>) => ({
        type: f.type as MemoryType,
        content: maxChars > 0 ? String(f.content).slice(0, maxChars) : String(f.content),
        confidence: Math.max(0, Math.min(1, Number(f.confidence) || 0.5)),
        importance: Math.max(1, Math.min(10, Math.round(Number(f.importance) || 5))),
        entities: Array.isArray(f.entities) ? f.entities.map(String) : [],
        domain: typeof f.domain === 'string' ? f.domain : undefined,
      }));

    // Auto-discover new categories via normalize-on-add
    if (sql) {
      for (const fact of facts) {
        fact.type = await findOrCreateCategory(sql, fact.type);
      }
    }

    logger.info(
      { factsExtracted: facts.length, source },
      'Facts extracted from conversation',
    );

    return { facts };
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : JSON.stringify(error);
    const errStatus = (error as Record<string, unknown>)?.status;
    logger.error({ error: errMsg, status: errStatus, source }, 'Fact extraction failed');
    return { facts: [] };
  }
}

/** Dedup decision returned by Haiku */
interface DedupDecision {
  action: 'ADD' | 'UPDATE' | 'NOOP' | 'DELETE';
  target_id: string | null;
  reason: string;
}

/**
 * Ask Haiku to judge whether a new fact should be added, updated, skipped, or
 * used to retire an existing memory.
 */
async function judgeDuplicate(
  client: Anthropic,
  model: string,
  fact: ExtractedFact,
  existingMemories: Array<{ id: string; type: string; content: string; confidence: number }>,
): Promise<DedupDecision> {
  const config = getConfig();
  const prompts = getPrompts();

  // Build the prompt with runtime variables
  const existingFormatted = existingMemories
    .map(m => `[ID: ${m.id}] (type: ${m.type}, confidence: ${m.confidence}): ${m.content}`)
    .join('\n');

  const systemPrompt = prompts.memoryDedup
    .replace('{{FACT_TYPE}}', fact.type)
    .replace('{{NEW_FACT}}', fact.content)
    .replace('{{EXISTING_MEMORIES}}', existingFormatted);

  const response = await client.messages.create({
    model,
    max_tokens: config.agent.classifierMaxTokens,
    messages: [{ role: 'user', content: systemPrompt }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  // Parse JSON — handle markdown wrapping
  let jsonStr = text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  } else {
    jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
  }

  const parsed = JSON.parse(jsonStr);

  const action = String(parsed.action ?? 'ADD').toUpperCase();
  if (!['ADD', 'UPDATE', 'NOOP', 'DELETE'].includes(action)) {
    return { action: 'ADD', target_id: null, reason: 'Unparseable action — defaulting to ADD' };
  }

  return {
    action: action as DedupDecision['action'],
    target_id: parsed.target_id ?? null,
    reason: String(parsed.reason ?? ''),
  };
}

/**
 * Store extracted facts into the database with write-time deduplication.
 *
 * When dedup is enabled (default), each fact is embedded and compared against
 * existing similar memories via vector similarity. Haiku judges whether to
 * ADD, UPDATE, NOOP, or DELETE.
 *
 * When dedup is disabled, facts are inserted directly (original behavior).
 */
export async function storeExtractionResult(
  sql: Sql,
  result: ExtractionResult,
  source: string,
  opts?: { surface_id?: string; domain?: string; client?: Anthropic },
): Promise<StoreResult> {
  const config = getConfig();
  let memoriesStored = 0;
  let duplicatesSkipped = 0;
  let memoriesUpdated = 0;
  let memoriesRetired = 0;

  if (result.facts.length === 0) {
    return { memoriesStored, duplicatesSkipped, memoriesUpdated, memoriesRetired };
  }

  // Step 1: Embed ALL candidate facts upfront in one batch
  let embeddings: Float32Array[];
  try {
    const texts = result.facts.map(f => f.content);
    embeddings = await embedBatch(texts, 'document');
  } catch (error) {
    logger.debug({ error }, 'Batch embedding failed — storing without dedup or vectors');
    // Fallback: store all facts without dedup or embeddings
    for (const fact of result.facts) {
      const newMemory: NewMemory = {
        type: fact.type,
        content: fact.content,
        source,
        importance: fact.importance,
        confidence: fact.confidence,
        entities: fact.entities,
        surface_id: opts?.surface_id,
        domain: fact.domain ?? opts?.domain ?? 'general',
      };
      await insertMemory(sql, newMemory);
      memoriesStored++;
    }
    return { memoriesStored, duplicatesSkipped, memoriesUpdated, memoriesRetired };
  }

  const surfaceId = opts?.surface_id ?? 'global';
  const dedupEnabled = config.memory.dedupEnabled && opts?.client != null;

  // Step 2: Process each fact with its embedding
  for (let i = 0; i < result.facts.length; i++) {
    const fact = result.facts[i];
    const embedding = embeddings[i];

    if (dedupEnabled) {
      // Find similar existing memories by vector
      const similar = await findSimilarByVector(sql, embedding, {
        limit: config.memory.dedupMaxCandidates,
        surfaces: [surfaceId, 'global'],
        minSimilarity: config.memory.dedupSimilarityThreshold,
      });

      if (similar.length === 0) {
        // No similar memories — ADD directly
        const newMemory: NewMemory = {
          type: fact.type,
          content: fact.content,
          source,
          importance: fact.importance,
          confidence: fact.confidence,
          entities: fact.entities,
          surface_id: opts?.surface_id,
          domain: fact.domain ?? opts?.domain ?? 'general',
        };
        const newId = await insertMemory(sql, newMemory);
        await insertEmbedding(sql, newId, embedding);
        memoriesStored++;
      } else {
        // Similar memories found — ask Haiku to judge
        let decision: DedupDecision;
        try {
          decision = await judgeDuplicate(
            opts!.client!,
            config.models.classifier,
            fact,
            similar.map(m => ({ id: m.id, type: m.type, content: m.content, confidence: m.confidence })),
          );
        } catch (error) {
          logger.debug({ error, fact: fact.content.slice(0, 100) }, 'Dedup judgment failed — defaulting to ADD');
          decision = { action: 'ADD', target_id: null, reason: 'Judgment call failed' };
        }

        logger.debug(
          { action: decision.action, targetId: decision.target_id, reason: decision.reason, fact: fact.content.slice(0, 80) },
          'Dedup decision',
        );

        switch (decision.action) {
          case 'ADD': {
            const newMemory: NewMemory = {
              type: fact.type,
              content: fact.content,
              source,
              importance: fact.importance,
              confidence: fact.confidence,
              entities: fact.entities,
              surface_id: opts?.surface_id,
              domain: fact.domain ?? opts?.domain ?? 'general',
            };
            const newId = await insertMemory(sql, newMemory);
            await insertEmbedding(sql, newId, embedding);
            memoriesStored++;
            break;
          }

          case 'UPDATE': {
            if (!decision.target_id) {
              // No target — treat as ADD
              const newMemory: NewMemory = {
                type: fact.type,
                content: fact.content,
                source,
                importance: fact.importance,
                confidence: fact.confidence,
                entities: fact.entities,
                surface_id: opts?.surface_id,
                domain: fact.domain ?? opts?.domain ?? 'general',
              };
              const newId = await insertMemory(sql, newMemory);
              await insertEmbedding(sql, newId, embedding);
              memoriesStored++;
            } else {
              const newMemory: NewMemory = {
                type: fact.type,
                content: fact.content,
                source,
                importance: fact.importance,
                confidence: fact.confidence,
                entities: fact.entities,
                surface_id: opts?.surface_id,
                domain: fact.domain ?? opts?.domain ?? 'general',
              };
              const newId = await insertMemory(sql, newMemory);
              await insertEmbedding(sql, newId, embedding);
              await supersedeMemory(sql, decision.target_id, newId);
              await deleteEmbedding(sql, decision.target_id);
              memoriesUpdated++;
            }
            break;
          }

          case 'NOOP': {
            duplicatesSkipped++;
            break;
          }

          case 'DELETE': {
            const newMemory: NewMemory = {
              type: fact.type,
              content: fact.content,
              source,
              importance: fact.importance,
              confidence: fact.confidence,
              entities: fact.entities,
              surface_id: opts?.surface_id,
              domain: fact.domain ?? opts?.domain ?? 'general',
            };
            const newId = await insertMemory(sql, newMemory);
            await insertEmbedding(sql, newId, embedding);
            if (decision.target_id) {
              await supersedeMemory(sql, decision.target_id, newId);
              await deleteEmbedding(sql, decision.target_id);
            }
            memoriesRetired++;
            break;
          }
        }
      }
    } else {
      // Dedup disabled — ADD directly with embedding
      const newMemory: NewMemory = {
        type: fact.type,
        content: fact.content,
        source,
        importance: fact.importance,
        confidence: fact.confidence,
        entities: fact.entities,
        surface_id: opts?.surface_id,
        domain: fact.domain ?? opts?.domain ?? 'general',
      };
      const newId = await insertMemory(sql, newMemory);
      await insertEmbedding(sql, newId, embedding);
      memoriesStored++;
    }
  }

  logger.info(
    { memoriesStored, duplicatesSkipped, memoriesUpdated, memoriesRetired, source },
    'Extraction result stored',
  );

  return { memoriesStored, duplicatesSkipped, memoriesUpdated, memoriesRetired };
}
