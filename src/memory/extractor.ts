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
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import {
  insertMemory,
  findDuplicates,
  supersedeMemory,
  findOrCreatePerson,
  touchPerson,
  insertEmbedding,
  deleteEmbedding,
  hasVectorSupport,
  getCategoryList,
  findOrCreateCategory,
  type MemoryType,
  type NewMemory,
} from './store.js';
import { embedBatch } from './embeddings.js';
import { getPrompts } from '../prompts.js';
import { getConfig } from '../config.js';

/** A fact extracted by Haiku */
export interface ExtractedFact {
  type: MemoryType;
  content: string;
  confidence: number;
  importance: number;
  entities: string[];
}

/** People info extracted by Haiku */
export interface ExtractedPerson {
  name: string;
  email?: string;
  role?: string;
  organization?: string;
  relationship?: 'colleague' | 'client' | 'vendor' | 'friend';
}

export interface ExtractionResult {
  facts: ExtractedFact[];
  people: ExtractedPerson[];
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

    // Parse JSON — handle potential markdown wrapping
    const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
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
      }));

    // Auto-discover new categories via normalize-on-add
    if (sql) {
      for (const fact of facts) {
        fact.type = await findOrCreateCategory(sql, fact.type);
      }
    }

    const people: ExtractedPerson[] = (parsed.people ?? [])
      .filter((p: Record<string, unknown>) => p.name && typeof p.name === 'string')
      .map((p: Record<string, unknown>) => ({
        name: String(p.name),
        email: p.email ? String(p.email) : undefined,
        role: p.role ? String(p.role) : undefined,
        organization: p.organization ? String(p.organization) : undefined,
        relationship: ['colleague', 'client', 'vendor', 'friend'].includes(p.relationship as string)
          ? p.relationship as ExtractedPerson['relationship']
          : undefined,
      }));

    logger.info(
      { factsExtracted: facts.length, peopleExtracted: people.length, source },
      'Facts extracted from conversation',
    );

    return { facts, people };
  } catch (error) {
    logger.error({ error, source }, 'Fact extraction failed');
    return { facts: [], people: [] };
  }
}

/**
 * Store extracted facts and people into the database.
 * Handles deduplication — if a near-duplicate exists, supersedes the old one
 * if the new fact has higher confidence.
 * Embeds facts for vector search (pgvector always available).
 */
export async function storeExtractionResult(
  sql: Sql,
  result: ExtractionResult,
  source: string,
): Promise<{ memoriesStored: number; peopleStored: number; duplicatesSkipped: number }> {
  let memoriesStored = 0;
  let duplicatesSkipped = 0;
  let peopleStored = 0;
  const newMemoryIds: { id: string; content: string }[] = [];

  // Store facts
  for (const fact of result.facts) {
    const duplicates = await findDuplicates(sql, fact.content, fact.type);

    // Simple dedup: if any duplicate has very similar content, skip or supersede
    const closeMatch = duplicates.find(d => contentSimilarity(d.content, fact.content) > 0.8);

    if (closeMatch) {
      if (fact.confidence > closeMatch.confidence) {
        // New fact is more confident — supersede the old one
        const newMemory: NewMemory = {
          type: fact.type,
          content: fact.content,
          source,
          importance: fact.importance,
          confidence: fact.confidence,
          entities: fact.entities,
        };
        const newId = await insertMemory(sql, newMemory);
        await supersedeMemory(sql, closeMatch.id, newId);
        await deleteEmbedding(sql, closeMatch.id);
        newMemoryIds.push({ id: newId, content: fact.content });
        memoriesStored++;
        logger.debug(
          { oldId: closeMatch.id, newId, type: fact.type },
          'Memory superseded with higher-confidence version',
        );
      } else {
        duplicatesSkipped++;
      }
    } else {
      // No duplicate — store as new
      const newMemory: NewMemory = {
        type: fact.type,
        content: fact.content,
        source,
        importance: fact.importance,
        confidence: fact.confidence,
        entities: fact.entities,
      };
      const newId = await insertMemory(sql, newMemory);
      newMemoryIds.push({ id: newId, content: fact.content });
      memoriesStored++;
    }
  }

  // Store/update people
  for (const person of result.people) {
    await findOrCreatePerson(sql, {
      name: person.name,
      email: person.email,
      role: person.role,
      organization: person.organization,
      relationship: person.relationship,
    });
    peopleStored++;
  }

  // Touch people mentioned in facts (deduplicated)
  const allEntities = new Set(result.facts.flatMap(f => f.entities));
  for (const entity of allEntities) {
    const [person] = await sql`SELECT id FROM people WHERE LOWER(name) = LOWER(${entity})`;
    if (person) {
      await touchPerson(sql, person.id as string);
    }
  }

  // Embed new memories for vector search
  if (newMemoryIds.length > 0 && await hasVectorSupport(sql)) {
    try {
      const texts = newMemoryIds.map(m => m.content);
      const embeddings = await embedBatch(texts);
      for (let i = 0; i < newMemoryIds.length; i++) {
        await insertEmbedding(sql, newMemoryIds[i].id, embeddings[i]);
      }
      logger.debug({ count: newMemoryIds.length }, 'Embeddings stored');
    } catch (error) {
      logger.debug({ error }, 'Embedding generation failed — memories stored without vectors');
    }
  }

  logger.info(
    { memoriesStored, peopleStored, duplicatesSkipped, source },
    'Extraction result stored',
  );

  return { memoriesStored, peopleStored, duplicatesSkipped };
}

/**
 * Simple word-overlap similarity for deduplication.
 * Not a vector comparison — just checks if two strings talk about the same thing.
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
