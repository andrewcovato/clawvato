/**
 * Memory Retriever — token-budgeted context retrieval for the agent.
 *
 * Before each agent call, retrieves relevant memories and formats them
 * as context. Uses a token budget to prevent context bloat.
 *
 * Retrieval order (highest value first):
 * 1. Memories about mentioned entities (entity junction lookup)
 * 2. Semantic + keyword search (hybrid tsvector + pgvector)
 * 3. Wake sleeping working context if relevant
 */

import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
// Document summaries are stored as memories — no special document search needed
import {
  searchMemories,
  findMemoriesByEntity,
  touchMemory,
  vectorSearch,
  type Memory,
} from './store.js';
import { embed } from './embeddings.js';
import { getConfig } from '../config.js';
import { rerankWithCrossEncoder } from './reranker.js';

/** Rough estimate: 1 token ≈ 4 characters */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RetrievalResult {
  context: string;
  tokensUsed: number;
  memoriesRetrieved: number;
}

/**
 * Calculate days since a memory was created.
 */
function daysSinceCreated(m: Memory): number {
  return Math.floor((Date.now() - new Date(m.created_at).getTime()) / 86400000);
}

/**
 * Format a memory as an XML-tagged fact for structured context injection.
 */
function formatMemory(m: Memory): string {
  const age = daysSinceCreated(m);
  const conf = m.confidence < 0.9 ? ` confidence="${m.confidence.toFixed(2)}"` : '';
  return `<fact type="${m.type}" importance="${m.importance}"${conf} age="${age}d">${m.content}</fact>`;
}

/**
 * Extract potential person names and keywords from a message.
 * Simple heuristic — looks for capitalized words that could be names.
 */
export function extractEntities(message: string): { names: string[]; keywords: string[] } {
  // Find potential names: capitalized words that look like proper nouns
  // At sentence start, only skip if word is a common sentence starter (verb, pronoun, etc.)
  const words = message.split(/\s+/);
  const names: string[] = [];
  let sentenceStart = true;
  for (let i = 0; i < words.length; i++) {
    const raw = words[i];
    const word = raw.replace(/[^\w]/g, '');
    const endsSentence = /[.!?]$/.test(raw);

    if (/^[A-Z][a-z]+$/.test(word) && !COMMON_WORDS.has(word.toLowerCase())) {
      // At sentence start, skip common sentence starters (verbs, pronouns, etc.)
      if (sentenceStart && SENTENCE_STARTERS.has(word.toLowerCase())) {
        sentenceStart = false;
        continue;
      }
      // Check if next word is also a capitalized name (two-word name)
      const next = words[i + 1]?.replace(/[^\w]/g, '');
      if (next && /^[A-Z][a-z]+$/.test(next) && !COMMON_WORDS.has(next.toLowerCase())) {
        names.push(`${word} ${next}`);
        i++; // skip next word
      } else {
        names.push(word);
      }
    }

    sentenceStart = endsSentence;
  }

  // Extract keywords for search (filter stopwords, take meaningful terms)
  const keywords = message
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w));

  return { names: [...new Set(names)], keywords: [...new Set(keywords)] };
}

// Common words that look like names but aren't
const COMMON_WORDS = new Set([
  'the', 'this', 'that', 'with', 'from', 'what', 'when', 'where', 'which',
  'will', 'would', 'could', 'should', 'have', 'been', 'just', 'also',
  'please', 'thanks', 'sure', 'okay', 'hello', 'here', 'there',
  'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december',
]);

// Words that commonly start sentences but aren't names
const SENTENCE_STARTERS = new Set([
  'the', 'this', 'that', 'what', 'when', 'where', 'which', 'who', 'how', 'why',
  'can', 'could', 'would', 'should', 'will', 'did', 'does', 'have', 'has', 'had',
  'are', 'is', 'was', 'were', 'been', 'being', 'get', 'got', 'let', 'make',
  'do', 'don', 'i', 'we', 'you', 'he', 'she', 'it', 'they', 'my', 'our', 'your',
  'ask', 'tell', 'check', 'find', 'look', 'see', 'send', 'give', 'take', 'set',
  'please', 'also', 'just', 'remember', 'schedule', 'draft', 'update', 'share',
]);

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'been',
  'will', 'would', 'could', 'should', 'about', 'there', 'their', 'what',
  'when', 'where', 'which', 'just', 'also', 'into', 'over', 'after',
  'before', 'some', 'than', 'then', 'them', 'they', 'these', 'those',
  'does', 'doing', 'done', 'please', 'thanks', 'sure', 'okay', 'hello',
  'want', 'need', 'know', 'think', 'like', 'make', 'look', 'find',
]);

/**
 * Rerank memory candidates using a local cross-encoder model.
 * Takes RRF-ranked candidates and rescores them based on actual relevance
 * to the query — catches keyword matches that aren't semantically relevant.
 *
 * Uses ms-marco-MiniLM-L-6-v2 locally ($0, ~5-15ms/candidate) instead of
 * the previous Haiku API approach.
 */
async function rerankMemories(
  query: string,
  candidates: Memory[],
  maxCandidates: number,
): Promise<Memory[]> {
  if (candidates.length === 0) return candidates;

  const config = getConfig();
  const toRerank = candidates.slice(0, maxCandidates);

  try {
    const reranked = await rerankWithCrossEncoder(query, toRerank, config.memory.rerankTopK);

    // Append any candidates beyond maxCandidates (weren't reranked)
    const remaining = candidates.slice(maxCandidates);
    logger.debug({ reranked: reranked.length, total: candidates.length }, 'Memory rerank complete');
    return [...reranked, ...remaining];
  } catch (error) {
    // Rerank failed — fall back to original RRF order
    logger.debug({ error }, 'Memory rerank failed — using RRF order');
    return candidates;
  }
}

/**
 * Retrieve relevant memory context for a given message.
 *
 * Returns formatted context string and metadata about what was retrieved.
 * Respects the token budget — stops adding context when budget is exceeded.
 * Uses hybrid search (tsvector + pgvector) when available.
 * Optionally reranks results via Haiku for precision.
 */
export async function retrieveContext(
  sql: Sql,
  message: string,
  opts?: { tokenBudget?: number; surfaces?: string[] },
): Promise<RetrievalResult> {
  const config = getConfig();
  const budget = opts?.tokenBudget ?? config.context.longTermTokenBudget;
  const surfaces = opts?.surfaces ?? [process.env.CLAWVATO_SURFACE ?? 'cloud', 'global'];
  const parts: string[] = [];
  let tokensUsed = 0;
  let memoriesRetrieved = 0;

  const { names, keywords } = extractEntities(message);

  // ── 1. Memories about mentioned entities (highest value per token) ──
  for (const name of names) {
    if (tokensUsed >= budget) break;

    const entityMemories = await findMemoriesByEntity(sql, name, { limit: 3, surfaces });
    for (const mem of entityMemories) {
      if (tokensUsed >= budget) break;

      const line = formatMemory(mem);
      const tokens = estimateTokens(line);
      if (tokensUsed + tokens <= budget) {
        parts.push(line);
        tokensUsed += tokens;
        memoriesRetrieved++;
        await touchMemory(sql, mem.id);
      }
    }
  }

  // ── 4. Semantic + keyword search for relevant facts/decisions ──
  // (File summaries are stored as memories — they surface here naturally)
  if (tokensUsed < budget && keywords.length > 0) {
    const ftsQuery = keywords.slice(0, 5).join(' | ');
    let searchResults: Memory[];

    // Use hybrid search (vector + tsvector) — pgvector always available
    try {
      const queryEmbedding = await embed(message, 'query');
      searchResults = await vectorSearch(sql, queryEmbedding, { limit: 20, ftsQuery, surfaces });
    } catch {
      // Embedding failed — fall back to tsvector only
      searchResults = await searchMemories(sql, ftsQuery, { limit: 20, surfaces });
    }

    // LLM rerank: Haiku scores candidates for actual relevance to the query
    if (config.memory.rerankEnabled && searchResults.length > 0) {
      searchResults = await rerankMemories(message, searchResults, config.memory.rerankMaxCandidates);
    }

    for (const mem of searchResults) {
      if (tokensUsed >= budget) break;

      const line = formatMemory(mem);
      const tokens = estimateTokens(line);
      if (tokensUsed + tokens <= budget) {
        parts.push(line);
        tokensUsed += tokens;
        memoriesRetrieved++;
        await touchMemory(sql, mem.id);
      }
    }
  }

  // ── 5. Wake sleeping working context if relevant ──
  if (keywords.length > 0) {
    try {
      const sleepingQuery = keywords.slice(0, 3).map(k => `%${k}%`);
      for (const pattern of sleepingQuery) {
        const sleeping = await sql`
          SELECT key, value FROM agent_state
          WHERE key LIKE 'wctx:%' AND status = 'sleeping' AND value LIKE ${pattern}
          LIMIT 3
        ` as unknown as Array<{ key: string; value: string }>;

        for (const entry of sleeping) {
          // Wake it — set status back to active
          await sql`UPDATE agent_state SET status = 'active', updated_at = NOW() WHERE key = ${entry.key}`;
          logger.info({ key: entry.key }, 'Woke sleeping working context — matched query');
        }
      }
    } catch { /* agent_state may not exist */ }
  }

  // Preferences and decisions now surface via semantic search when relevant
  // (removed hardcoded type-biased pulls that consumed budget regardless of relevance)

  const context = parts.length > 0
    ? `<memories>\n${parts.join('\n')}\n</memories>`
    : '';

  logger.info(
    { memoriesRetrieved, tokensUsed, budget },
    'Memory context retrieved',
  );

  return { context, tokensUsed, memoriesRetrieved };
}
