/**
 * Memory Retriever — token-budgeted context retrieval for the agent.
 *
 * Before each agent call, retrieves relevant memories and formats them
 * as context. Uses a token budget to prevent context bloat.
 *
 * Retrieval order (highest value first):
 * 1. People mentioned in the message (structured lookup, ~30-50 tokens each)
 * 2. Preferences relevant to the action type (structured, ~15-20 tokens each)
 * 3. Related documents from the file catalog (~20-40 tokens each)
 * 4. Keyword search for relevant facts/decisions (FTS5, ~15-20 tokens each)
 */

import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logger.js';
import { findDocumentsByEntity, type Document } from '../google/drive-sync.js';
import {
  findPersonByName,
  findMemoriesByType,
  searchMemories,
  findMemoriesByEntity,
  touchMemory,
  vectorSearch,
  hasVectorSupport,
  type Memory,
  type Person,
} from './store.js';
import { embed } from './embeddings.js';

/** Maximum tokens to inject as memory context */
const DEFAULT_TOKEN_BUDGET = 1500;

/** Rough estimate: 1 token ≈ 4 characters */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface RetrievalResult {
  context: string;
  tokensUsed: number;
  memoriesRetrieved: number;
  peopleRetrieved: number;
}

/**
 * Format a person record as a concise context line.
 */
function formatPerson(p: Person): string {
  const parts = [p.name];
  if (p.role) parts.push(p.role);
  if (p.organization) parts.push(`at ${p.organization}`);
  if (p.email) parts.push(`(${p.email})`);
  if (p.slack_id) parts.push(`Slack: ${p.slack_id}`);
  if (p.timezone) parts.push(`TZ: ${p.timezone}`);
  if (p.notes) parts.push(`— ${p.notes}`);
  return parts.join(', ');
}

/**
 * Format a memory as a concise context line.
 */
function formatMemory(m: Memory): string {
  const typeLabel = m.type === 'preference' ? 'Pref' :
    m.type === 'decision' ? 'Decision' :
    m.type === 'fact' ? 'Fact' :
    m.type === 'reflection' ? 'Insight' :
    m.type === 'strategy' ? 'Strategy' :
    m.type === 'conclusion' ? 'Conclusion' :
    m.type === 'commitment' ? 'Commitment' :
    'Note';
  const confidence = m.confidence >= 0.9 ? '' : ` [${Math.round(m.confidence * 100)}% confident]`;
  return `${typeLabel}: ${m.content}${confidence}`;
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

  // Extract keywords for FTS5 search (filter stopwords, take meaningful terms)
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
 * Retrieve relevant memory context for a given message.
 *
 * Returns formatted context string and metadata about what was retrieved.
 * Respects the token budget — stops adding context when budget is exceeded.
 * Uses hybrid search (FTS5 + vector) when sqlite-vec is available.
 */
export async function retrieveContext(
  db: DatabaseSync,
  message: string,
  opts?: { tokenBudget?: number },
): Promise<RetrievalResult> {
  const budget = opts?.tokenBudget ?? DEFAULT_TOKEN_BUDGET;
  const parts: string[] = [];
  let tokensUsed = 0;
  let memoriesRetrieved = 0;
  let peopleRetrieved = 0;

  const { names, keywords } = extractEntities(message);

  // ── 1. People lookup (highest value per token) ──
  for (const name of names) {
    if (tokensUsed >= budget) break;

    const person = findPersonByName(db, name);
    if (person) {
      const line = formatPerson(person);
      const tokens = estimateTokens(line);
      if (tokensUsed + tokens <= budget) {
        parts.push(`Person: ${line}`);
        tokensUsed += tokens;
        peopleRetrieved++;
      }
    }
  }

  // ── 2. Preferences (always valuable when relevant) ──
  if (tokensUsed < budget) {
    const prefs = findMemoriesByType(db, 'preference', { validOnly: true, limit: 5 });
    for (const pref of prefs) {
      if (tokensUsed >= budget) break;

      const line = formatMemory(pref);
      const tokens = estimateTokens(line);
      if (tokensUsed + tokens <= budget) {
        parts.push(line);
        tokensUsed += tokens;
        memoriesRetrieved++;
        touchMemory(db, pref.id);
      }
    }
  }

  // ── 3. Memories about mentioned entities ──
  for (const name of names) {
    if (tokensUsed >= budget) break;

    const entityMemories = findMemoriesByEntity(db, name, { limit: 3 });
    for (const mem of entityMemories) {
      if (tokensUsed >= budget) break;

      const line = formatMemory(mem);
      const tokens = estimateTokens(line);
      if (tokensUsed + tokens <= budget) {
        parts.push(line);
        tokensUsed += tokens;
        memoriesRetrieved++;
        touchMemory(db, mem.id);
      }
    }
  }

  // ── 4. Related documents from file catalog ──
  const seenDocIds = new Set<string>();
  for (const name of names) {
    if (tokensUsed >= budget) break;
    try {
      const docs = findDocumentsByEntity(db, name, { limit: 3 });
      for (const doc of docs) {
        if (tokensUsed >= budget || seenDocIds.has(doc.id)) continue;
        seenDocIds.add(doc.id);
        const summary = doc.summary ? `: ${doc.summary.slice(0, 100)}` : '';
        const line = `File: ${doc.name}${summary} (ID: ${doc.source_id})`;
        const tokens = estimateTokens(line);
        if (tokensUsed + tokens <= budget) {
          parts.push(line);
          tokensUsed += tokens;
          memoriesRetrieved++;
        }
      }
    } catch {
      // documents table may not exist yet — non-critical
    }
  }

  // Also search documents by keywords
  if (tokensUsed < budget && keywords.length > 0) {
    try {
      const keywordQuery = keywords.slice(0, 3).join('%');
      const docs = db.prepare(`
        SELECT * FROM documents
        WHERE status = 'active'
          AND (name LIKE ? OR summary LIKE ?)
        ORDER BY modified_time DESC LIMIT 3
      `).all(`%${keywordQuery}%`, `%${keywordQuery}%`) as unknown as Document[];

      for (const doc of docs) {
        if (tokensUsed >= budget || seenDocIds.has(doc.id)) continue;
        seenDocIds.add(doc.id);
        const summary = doc.summary ? `: ${doc.summary.slice(0, 100)}` : '';
        const line = `File: ${doc.name}${summary} (ID: ${doc.source_id})`;
        const tokens = estimateTokens(line);
        if (tokensUsed + tokens <= budget) {
          parts.push(line);
          tokensUsed += tokens;
          memoriesRetrieved++;
        }
      }
    } catch {
      // documents table may not exist — non-critical
    }
  }

  // ── 5. Semantic + keyword search for relevant facts/decisions ──
  if (tokensUsed < budget && keywords.length > 0) {
    const ftsQuery = keywords.slice(0, 5).join(' OR ');
    let searchResults: Memory[];

    // Use hybrid search (vector + FTS5) when available, else FTS5 only
    if (hasVectorSupport(db)) {
      try {
        const queryEmbedding = await embed(message);
        searchResults = vectorSearch(db, queryEmbedding, { limit: 10, ftsQuery });
      } catch {
        // Embedding failed — fall back to FTS5 only
        searchResults = searchMemories(db, ftsQuery, { limit: 10 });
      }
    } else {
      searchResults = searchMemories(db, ftsQuery, { limit: 10 });
    }

    for (const mem of searchResults) {
      if (tokensUsed >= budget) break;

      const line = formatMemory(mem);
      const tokens = estimateTokens(line);
      if (tokensUsed + tokens <= budget) {
        parts.push(line);
        tokensUsed += tokens;
        memoriesRetrieved++;
        touchMemory(db, mem.id);
      }
    }
  }

  // ── 5. Recent decisions (always useful as background) ──
  if (tokensUsed < budget) {
    const decisions = findMemoriesByType(db, 'decision', { validOnly: true, limit: 3 });
    for (const dec of decisions) {
      if (tokensUsed >= budget) break;

      const line = formatMemory(dec);
      const tokens = estimateTokens(line);
      if (tokensUsed + tokens <= budget) {
        parts.push(line);
        tokensUsed += tokens;
        memoriesRetrieved++;
        touchMemory(db, dec.id);
      }
    }
  }

  const context = parts.length > 0
    ? `## Memory\n${parts.join('\n')}`
    : '';

  logger.info(
    { memoriesRetrieved, peopleRetrieved, tokensUsed, budget },
    'Memory context retrieved',
  );

  return { context, tokensUsed, memoriesRetrieved, peopleRetrieved };
}
