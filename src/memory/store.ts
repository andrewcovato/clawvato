/**
 * Memory Store — CRUD operations for the memories and people tables.
 *
 * All functions take a DatabaseSync instance so they're testable
 * without global state. Uses snake_case interfaces to match SQLite columns.
 */

import type { DatabaseSync } from 'node:sqlite';
import { generateId } from '../db/index.js';
import { logger } from '../logger.js';
import { embeddingToBytes } from './embeddings.js';

// ── Prepared statement cache for hot-path queries ──

const stmtCache = new WeakMap<DatabaseSync, Map<string, ReturnType<DatabaseSync['prepare']>>>();

function cachedPrepare(db: DatabaseSync, sql: string): ReturnType<DatabaseSync['prepare']> {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

// ── Memory types (dynamic categories — no fixed enum) ──

export type MemoryType = string;

export interface Memory {
  id: string;
  type: MemoryType;
  content: string;
  source: string;
  importance: number;
  confidence: number;
  valid_from: string;
  valid_until: string | null;
  created_at: string;
  last_accessed_at: string | null;
  access_count: number;
  entities: string; // JSON array
  superseded_by: string | null;
  reflection_source: number;
}

export interface NewMemory {
  type: MemoryType;
  content: string;
  source: string;
  importance?: number;
  confidence?: number;
  entities?: string[];
}

// ── People types ──

export type Relationship = 'colleague' | 'client' | 'vendor' | 'friend' | 'unknown';

export interface Person {
  id: string;
  name: string;
  email: string | null;
  slack_id: string | null;
  github_username: string | null;
  relationship: Relationship;
  organization: string | null;
  role: string | null;
  timezone: string | null;
  notes: string | null;
  communication_preferences: string | null;
  first_seen_at: string;
  last_interaction_at: string | null;
  interaction_count: number;
}

export interface NewPerson {
  name: string;
  email?: string;
  slack_id?: string;
  relationship?: Relationship;
  organization?: string;
  role?: string;
}

// ── Memory CRUD ──

export function insertMemory(db: DatabaseSync, memory: NewMemory): string {
  const id = generateId();
  const entityList = memory.entities ?? [];
  const entities = JSON.stringify(entityList);

  db.prepare(`
    INSERT INTO memories (id, type, content, source, importance, confidence, entities)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    memory.type,
    memory.content,
    memory.source,
    memory.importance ?? 5,
    memory.confidence ?? 0.5,
    entities,
  );

  // Populate entity junction table
  if (entityList.length > 0) {
    const insertEntity = db.prepare(
      'INSERT OR IGNORE INTO memory_entities (memory_id, entity) VALUES (?, ?)'
    );
    for (const entity of entityList) {
      if (entity && typeof entity === 'string') {
        insertEntity.run(id, entity);
      }
    }
  }

  // Increment category count
  try {
    db.prepare(
      'UPDATE memory_categories SET count = count + 1 WHERE name = ?'
    ).run(memory.type);
  } catch { /* category may not exist yet — created by findOrCreateCategory */ }

  logger.debug({ id, type: memory.type, contentLength: memory.content.length }, 'Memory stored');
  return id;
}

export function getMemory(db: DatabaseSync, id: string): Memory | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  return row ? row as unknown as Memory : null;
}

/**
 * Find memories by type, optionally filtering to currently-valid only.
 */
export function findMemoriesByType(
  db: DatabaseSync,
  type: MemoryType,
  opts?: { validOnly?: boolean; limit?: number },
): Memory[] {
  const validOnly = opts?.validOnly ?? true;
  const limit = opts?.limit ?? 20;

  const sql = validOnly
    ? 'SELECT * FROM memories WHERE type = ? AND valid_until IS NULL ORDER BY importance DESC, created_at DESC LIMIT ?'
    : 'SELECT * FROM memories WHERE type = ? ORDER BY importance DESC, created_at DESC LIMIT ?';

  return db.prepare(sql).all(type, limit) as unknown as Memory[];
}

/**
 * Search memories. When a query is provided, uses FTS5 keyword search ranked by relevance.
 * When no query is provided (or empty), returns memories by importance + recency.
 * Supports optional filtering by type, source prefix, and minimum importance.
 */
export function searchMemories(
  db: DatabaseSync,
  query: string,
  opts?: {
    limit?: number;
    type?: MemoryType;
    sourcePrefix?: string;
    minImportance?: number;
  },
): Memory[] {
  const limit = opts?.limit ?? 20;
  const hasQuery = query && query.trim().length > 0;

  if (hasQuery) {
    // FTS5 keyword search — ranked by relevance
    const conditions: string[] = ['memories_fts MATCH ?', 'm.valid_until IS NULL'];
    const params: Array<string | number> = [query];

    if (opts?.type) {
      conditions.push('m.type = ?');
      params.push(opts.type);
    }
    if (opts?.sourcePrefix) {
      conditions.push('m.source LIKE ?');
      params.push(`${opts.sourcePrefix}:%`);
    }
    if (opts?.minImportance) {
      conditions.push('m.importance >= ?');
      params.push(opts.minImportance);
    }

    params.push(limit);

    const sql = `SELECT m.* FROM memories m
      JOIN memories_fts f ON m.rowid = f.rowid
      WHERE ${conditions.join(' AND ')}
      ORDER BY f.rank
      LIMIT ?`;

    try {
      const rows = db.prepare(sql).all(...params);
      return rows as unknown as Memory[];
    } catch {
      logger.debug({ query }, 'FTS5 search failed — falling back to recency');
      // Fall through to recency-based search below
    }
  }

  // No query or FTS5 failed — return by importance + recency
  const conditions: string[] = ['valid_until IS NULL'];
  const params: Array<string | number> = [];

  if (opts?.type) {
    conditions.push('type = ?');
    params.push(opts.type);
  }
  if (opts?.sourcePrefix) {
    conditions.push('source LIKE ?');
    params.push(`${opts.sourcePrefix}:%`);
  }
  if (opts?.minImportance) {
    conditions.push('importance >= ?');
    params.push(opts.minImportance);
  }

  params.push(limit);

  const sql = `SELECT * FROM memories
    WHERE ${conditions.join(' AND ')}
    ORDER BY importance DESC, created_at DESC
    LIMIT ?`;

  return db.prepare(sql).all(...params) as unknown as Memory[];
}

/**
 * Find memories mentioning a specific entity.
 * Uses the memory_entities junction table for O(log n) indexed lookup.
 */
export function findMemoriesByEntity(
  db: DatabaseSync,
  entity: string,
  opts?: { limit?: number },
): Memory[] {
  const limit = opts?.limit ?? 10;
  return db.prepare(
    `SELECT m.* FROM memories m
     JOIN memory_entities me ON m.id = me.memory_id
     WHERE me.entity = ? COLLATE NOCASE AND m.valid_until IS NULL
     ORDER BY m.importance DESC, m.created_at DESC LIMIT ?`
  ).all(entity, limit) as unknown as Memory[];
}

/**
 * Mark a memory as accessed (updates recency for retrieval scoring).
 */
export function touchMemory(db: DatabaseSync, id: string): void {
  cachedPrepare(db, `
    UPDATE memories SET last_accessed_at = datetime('now'), access_count = access_count + 1
    WHERE id = ?
  `).run(id);
}

/**
 * Supersede a memory (mark it as replaced by a newer one).
 */
export function supersedeMemory(db: DatabaseSync, oldId: string, newId: string): void {
  db.prepare(`
    UPDATE memories SET valid_until = datetime('now'), superseded_by = ?
    WHERE id = ?
  `).run(newId, oldId);
}

/**
 * Check for near-duplicate memories by content similarity.
 * Uses FTS5 to find candidates, then checks for high overlap.
 */
export function findDuplicates(
  db: DatabaseSync,
  content: string,
  type: MemoryType,
): Memory[] {
  // Extract keywords for FTS5 search (first 5 meaningful words)
  const keywords = content
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 5)
    .join(' ');

  if (!keywords) return [];

  // Join with OR so any keyword match counts
  const ftsQuery = keywords.split(/\s+/).join(' OR ');
  return searchMemories(db, ftsQuery, { limit: 5, type });
}

/**
 * Get recent memories created since a given timestamp.
 */
export function getRecentMemories(
  db: DatabaseSync,
  since: string,
  opts?: { limit?: number },
): Memory[] {
  const limit = opts?.limit ?? 50;
  return db.prepare(
    `SELECT * FROM memories WHERE created_at >= ? AND valid_until IS NULL
     ORDER BY created_at DESC LIMIT ?`
  ).all(since, limit) as unknown as Memory[];
}

// ── People CRUD ──

export function insertPerson(db: DatabaseSync, person: NewPerson): string {
  const id = generateId();
  db.prepare(`
    INSERT INTO people (id, name, email, slack_id, relationship, organization, role)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    person.name,
    person.email ?? null,
    person.slack_id ?? null,
    person.relationship ?? 'unknown',
    person.organization ?? null,
    person.role ?? null,
  );

  logger.debug({ id, name: person.name }, 'Person stored');
  return id;
}

export function findPersonByName(db: DatabaseSync, name: string): Person | null {
  // Case-insensitive search
  const row = cachedPrepare(db, 'SELECT * FROM people WHERE name = ? COLLATE NOCASE').get(name);
  return row ? row as unknown as Person : null;
}

export function findPersonBySlackId(db: DatabaseSync, slackId: string): Person | null {
  const row = db.prepare('SELECT * FROM people WHERE slack_id = ?').get(slackId);
  return row ? row as unknown as Person : null;
}

export function findPersonByEmail(db: DatabaseSync, email: string): Person | null {
  const row = db.prepare('SELECT * FROM people WHERE email = ? COLLATE NOCASE').get(email);
  return row ? row as unknown as Person : null;
}

/**
 * Update a person's interaction tracking.
 */
export function touchPerson(db: DatabaseSync, id: string): void {
  cachedPrepare(db, `
    UPDATE people SET last_interaction_at = datetime('now'), interaction_count = interaction_count + 1
    WHERE id = ?
  `).run(id);
}

/**
 * Update specific fields on a person record.
 */
export function updatePerson(
  db: DatabaseSync,
  id: string,
  updates: Partial<Pick<Person, 'email' | 'slack_id' | 'role' | 'organization' | 'relationship' | 'notes' | 'timezone'>>,
): void {
  const ALLOWED_KEYS = new Set(['email', 'slack_id', 'role', 'organization', 'relationship', 'notes', 'timezone']);
  const fields: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && ALLOWED_KEYS.has(key)) {
      fields.push(`${key} = ?`);
      values.push(value as string | number | null);
    }
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(`UPDATE people SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

/**
 * Find or create a person by name. Returns the person ID.
 */
export function findOrCreatePerson(db: DatabaseSync, person: NewPerson): string {
  const existing = findPersonByName(db, person.name);
  if (existing) {
    // Update fields if new info provided
    const updates: Partial<Person> = {};
    if (person.email && !existing.email) updates.email = person.email;
    if (person.slack_id && !existing.slack_id) updates.slack_id = person.slack_id;
    if (person.role && !existing.role) updates.role = person.role;
    if (person.organization && !existing.organization) updates.organization = person.organization;
    if (person.relationship && person.relationship !== 'unknown' && existing.relationship === 'unknown') {
      updates.relationship = person.relationship;
    }
    if (Object.keys(updates).length > 0) {
      updatePerson(db, existing.id, updates);
    }
    return existing.id;
  }
  return insertPerson(db, person);
}

/**
 * Get all people, ordered by interaction frequency.
 */
export function getAllPeople(db: DatabaseSync, opts?: { limit?: number }): Person[] {
  const limit = opts?.limit ?? 50;
  return db.prepare(
    'SELECT * FROM people ORDER BY interaction_count DESC, last_interaction_at DESC LIMIT ?'
  ).all(limit) as unknown as Person[];
}

// ── Vector operations ──

/**
 * Check if the memories_vec table exists (sqlite-vec loaded).
 */
export function hasVectorSupport(db: DatabaseSync): boolean {
  try {
    db.prepare('SELECT count(*) as c FROM memories_vec').get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Store an embedding for a memory in the vector index.
 */
export function insertEmbedding(db: DatabaseSync, memoryId: string, embedding: Float32Array): void {
  try {
    db.prepare(
      'INSERT INTO memories_vec (memory_id, embedding) VALUES (?, ?)'
    ).run(memoryId, embeddingToBytes(embedding));
  } catch (error) {
    logger.debug({ error, memoryId }, 'Failed to insert embedding — vector search may not be available');
  }
}

/**
 * Remove an embedding from the vector index.
 */
export function deleteEmbedding(db: DatabaseSync, memoryId: string): void {
  try {
    db.prepare('DELETE FROM memories_vec WHERE memory_id = ?').run(memoryId);
  } catch {
    // Non-critical — vec table may not exist
  }
}

/**
 * Semantic search: find memories similar to a query embedding.
 * Returns memories joined with their similarity distance, ordered by relevance.
 * Uses Reciprocal Rank Fusion with FTS5 results when ftsQuery is provided.
 */
export function vectorSearch(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  opts?: { limit?: number; ftsQuery?: string },
): Memory[] {
  const limit = opts?.limit ?? 10;

  if (opts?.ftsQuery) {
    // Hybrid search: RRF of vector + FTS5
    return hybridSearch(db, queryEmbedding, opts.ftsQuery, limit);
  }

  // Pure vector search
  try {
    const rows = db.prepare(`
      SELECT m.*
      FROM memories m
      JOIN memories_vec v ON m.id = v.memory_id
      WHERE v.embedding MATCH ?
        AND k = ?
        AND m.valid_until IS NULL
      ORDER BY v.distance
    `).all(embeddingToBytes(queryEmbedding), limit);
    return rows as unknown as Memory[];
  } catch (error) {
    logger.debug({ error }, 'Vector search failed');
    return [];
  }
}

/**
 * Hybrid search using Reciprocal Rank Fusion (RRF).
 * Combines FTS5 keyword rankings with vector similarity rankings.
 * RRF score = 1/(k+rank_fts) + 1/(k+rank_vec), where k=60 is standard.
 */
function hybridSearch(
  db: DatabaseSync,
  queryEmbedding: Float32Array,
  ftsQuery: string,
  limit: number,
): Memory[] {
  const K = 60; // RRF constant

  // Get FTS5 results
  let ftsIds: string[];
  try {
    const ftsRows = db.prepare(`
      SELECT m.id
      FROM memories m
      JOIN memories_fts f ON m.rowid = f.rowid
      WHERE memories_fts MATCH ? AND m.valid_until IS NULL
      ORDER BY f.rank
      LIMIT 30
    `).all(ftsQuery) as unknown as { id: string }[];
    ftsIds = ftsRows.map(r => r.id);
  } catch {
    ftsIds = [];
  }

  // Get vector results
  let vecIds: string[];
  try {
    const vecRows = db.prepare(`
      SELECT v.memory_id as id
      FROM memories_vec v
      JOIN memories m ON m.id = v.memory_id
      WHERE v.embedding MATCH ?
        AND k = 30
        AND m.valid_until IS NULL
      ORDER BY v.distance
    `).all(embeddingToBytes(queryEmbedding)) as unknown as { id: string }[];
    vecIds = vecRows.map(r => r.id);
  } catch {
    vecIds = [];
  }

  // Compute RRF scores
  const scores = new Map<string, number>();

  ftsIds.forEach((id, rank) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (K + rank + 1));
  });

  vecIds.forEach((id, rank) => {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (K + rank + 1));
  });

  // Sort by RRF score and fetch full memories
  const rankedIds = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);

  if (rankedIds.length === 0) return [];

  // Fetch full memory records
  const placeholders = rankedIds.map(() => '?').join(',');
  const memories = db.prepare(
    `SELECT * FROM memories WHERE id IN (${placeholders}) AND valid_until IS NULL`
  ).all(...rankedIds) as unknown as Memory[];

  // Restore RRF order
  const memoryMap = new Map(memories.map(m => [m.id, m]));
  return rankedIds.map(id => memoryMap.get(id)).filter((m): m is Memory => !!m);
}

// ── Category CRUD ──

export interface CategoryRow {
  name: string;
  description: string | null;
  count: number;
  source: 'seed' | 'discovered';
  created_at: string;
}

/**
 * Get all categories ordered by count (most-used first).
 */
export function getCategories(db: DatabaseSync): CategoryRow[] {
  return db.prepare(
    'SELECT * FROM memory_categories ORDER BY count DESC'
  ).all() as unknown as CategoryRow[];
}

/**
 * Format categories as a string list for prompt injection.
 */
export function getCategoryList(db: DatabaseSync): string {
  const cats = getCategories(db);
  return cats
    .map(c => c.description ? `- "${c.name}" — ${c.description}` : `- "${c.name}"`)
    .join('\n');
}

/**
 * Find or create a category, normalizing on add.
 * If a fuzzy match is found against existing categories, returns the existing name.
 * Otherwise creates a new discovered category.
 */
export function findOrCreateCategory(
  db: DatabaseSync,
  name: string,
  description?: string,
  fuzzyThreshold = 0.8,
): string {
  // Normalize: lowercase, trim, no trailing 's' for simple plurals
  const normalized = name.toLowerCase().trim().replace(/s$/, '');
  if (!normalized) return 'fact'; // fallback

  // Exact match (singular or plural)
  const exact = db.prepare(
    'SELECT name FROM memory_categories WHERE name = ? OR name = ?'
  ).get(normalized, normalized + 's') as { name: string } | undefined;
  if (exact) return exact.name;

  // Fuzzy match against existing categories
  const existing = db.prepare(
    'SELECT name FROM memory_categories'
  ).all() as unknown as Array<{ name: string }>;

  for (const cat of existing) {
    if (categoryFuzzyMatch(normalized, cat.name) >= fuzzyThreshold) {
      return cat.name;
    }
  }

  // No match — create new discovered category
  db.prepare(
    "INSERT OR IGNORE INTO memory_categories (name, description, source) VALUES (?, ?, 'discovered')"
  ).run(normalized, description ?? null);

  logger.info({ category: normalized }, 'New memory category discovered');
  return normalized;
}

/**
 * Fuzzy match two category names using character overlap + containment.
 */
function categoryFuzzyMatch(a: string, b: string): number {
  if (a === b) return 1;

  // Containment check (one is substring of other)
  if (a.includes(b) || b.includes(a)) return 0.9;

  // Word overlap (Jaccard on word fragments split by _ and -)
  const wordsA = new Set(a.split(/[-_\s]+/));
  const wordsB = new Set(b.split(/[-_\s]+/));
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const union = new Set([...wordsA, ...wordsB]).size;
  return union > 0 ? overlap / union : 0;
}
