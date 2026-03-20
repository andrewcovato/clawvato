/**
 * Memory Store — CRUD operations for the memories and people tables.
 *
 * All functions take a postgres Sql instance so they're testable
 * without global state. Uses snake_case interfaces to match Postgres columns.
 */

import type { Sql } from '../db/index.js';
import { generateId } from '../db/index.js';
import { logger } from '../logger.js';
import pgvector from 'pgvector';

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

export async function insertMemory(sql: Sql, memory: NewMemory): Promise<string> {
  const id = generateId();
  const entityList = memory.entities ?? [];
  const entities = JSON.stringify(entityList);

  await sql`
    INSERT INTO memories (id, type, content, source, importance, confidence, entities)
    VALUES (${id}, ${memory.type}, ${memory.content}, ${memory.source},
            ${memory.importance ?? 5}, ${memory.confidence ?? 0.5}, ${entities})
  `;

  // Populate entity junction table
  if (entityList.length > 0) {
    for (const entity of entityList) {
      if (entity && typeof entity === 'string') {
        await sql`
          INSERT INTO memory_entities (memory_id, entity)
          VALUES (${id}, ${entity})
          ON CONFLICT DO NOTHING
        `;
      }
    }
  }

  // Increment category count
  try {
    await sql`UPDATE memory_categories SET count = count + 1 WHERE name = ${memory.type}`;
  } catch { /* category may not exist yet — created by findOrCreateCategory */ }

  logger.debug({ id, type: memory.type, contentLength: memory.content.length }, 'Memory stored');
  return id;
}

export async function getMemory(sql: Sql, id: string): Promise<Memory | null> {
  const [row] = await sql`SELECT * FROM memories WHERE id = ${id}`;
  return row ? row as unknown as Memory : null;
}

/**
 * Find memories by type, optionally filtering to currently-valid only.
 */
export async function findMemoriesByType(
  sql: Sql,
  type: MemoryType,
  opts?: { validOnly?: boolean; limit?: number },
): Promise<Memory[]> {
  const validOnly = opts?.validOnly ?? true;
  const limit = opts?.limit ?? 20;

  if (validOnly) {
    return await sql`
      SELECT * FROM memories WHERE type = ${type} AND valid_until IS NULL
      ORDER BY importance DESC, created_at DESC LIMIT ${limit}
    ` as unknown as Memory[];
  }

  return await sql`
    SELECT * FROM memories WHERE type = ${type}
    ORDER BY importance DESC, created_at DESC LIMIT ${limit}
  ` as unknown as Memory[];
}

/**
 * Search memories. When a query is provided, uses tsvector keyword search ranked by relevance.
 * When no query is provided (or empty), returns memories by importance + recency.
 * Supports optional filtering by type, source prefix, and minimum importance.
 */
export async function searchMemories(
  sql: Sql,
  query: string,
  opts?: {
    limit?: number;
    type?: MemoryType;
    sourcePrefix?: string;
    minImportance?: number;
  },
): Promise<Memory[]> {
  const limit = opts?.limit ?? 20;
  const hasQuery = query && query.trim().length > 0;

  if (hasQuery) {
    try {
      // Build dynamic query with tsvector search
      // We split multi-word queries into OR terms so any word matches
      if (opts?.type && opts?.sourcePrefix && opts?.minImportance) {
        return await sql`
          SELECT * FROM memories
          WHERE content_tsv @@ to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})
            AND valid_until IS NULL
            AND type = ${opts.type}
            AND source LIKE ${opts.sourcePrefix + ':%'}
            AND importance >= ${opts.minImportance}
          ORDER BY ts_rank(content_tsv, to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})) DESC
          LIMIT ${limit}
        ` as unknown as Memory[];
      } else if (opts?.type && opts?.sourcePrefix) {
        return await sql`
          SELECT * FROM memories
          WHERE content_tsv @@ to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})
            AND valid_until IS NULL
            AND type = ${opts.type}
            AND source LIKE ${opts.sourcePrefix + ':%'}
          ORDER BY ts_rank(content_tsv, to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})) DESC
          LIMIT ${limit}
        ` as unknown as Memory[];
      } else if (opts?.type && opts?.minImportance) {
        return await sql`
          SELECT * FROM memories
          WHERE content_tsv @@ to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})
            AND valid_until IS NULL
            AND type = ${opts.type}
            AND importance >= ${opts.minImportance}
          ORDER BY ts_rank(content_tsv, to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})) DESC
          LIMIT ${limit}
        ` as unknown as Memory[];
      } else if (opts?.sourcePrefix && opts?.minImportance) {
        return await sql`
          SELECT * FROM memories
          WHERE content_tsv @@ to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})
            AND valid_until IS NULL
            AND source LIKE ${opts.sourcePrefix + ':%'}
            AND importance >= ${opts.minImportance}
          ORDER BY ts_rank(content_tsv, to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})) DESC
          LIMIT ${limit}
        ` as unknown as Memory[];
      } else if (opts?.type) {
        return await sql`
          SELECT * FROM memories
          WHERE content_tsv @@ to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})
            AND valid_until IS NULL
            AND type = ${opts.type}
          ORDER BY ts_rank(content_tsv, to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})) DESC
          LIMIT ${limit}
        ` as unknown as Memory[];
      } else if (opts?.sourcePrefix) {
        return await sql`
          SELECT * FROM memories
          WHERE content_tsv @@ to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})
            AND valid_until IS NULL
            AND source LIKE ${opts.sourcePrefix + ':%'}
          ORDER BY ts_rank(content_tsv, to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})) DESC
          LIMIT ${limit}
        ` as unknown as Memory[];
      } else if (opts?.minImportance) {
        return await sql`
          SELECT * FROM memories
          WHERE content_tsv @@ to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})
            AND valid_until IS NULL
            AND importance >= ${opts.minImportance}
          ORDER BY ts_rank(content_tsv, to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})) DESC
          LIMIT ${limit}
        ` as unknown as Memory[];
      } else {
        return await sql`
          SELECT * FROM memories
          WHERE content_tsv @@ to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})
            AND valid_until IS NULL
          ORDER BY ts_rank(content_tsv, to_tsquery('english', ${query.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})) DESC
          LIMIT ${limit}
        ` as unknown as Memory[];
      }
    } catch {
      logger.debug({ query }, 'tsvector search failed — falling back to recency');
      // Fall through to recency-based search below
    }
  }

  // No query or tsvector search failed — return by importance + recency
  if (opts?.type && opts?.sourcePrefix && opts?.minImportance) {
    return await sql`
      SELECT * FROM memories
      WHERE valid_until IS NULL AND type = ${opts.type}
        AND source LIKE ${opts.sourcePrefix + ':%'} AND importance >= ${opts.minImportance}
      ORDER BY importance DESC, created_at DESC LIMIT ${limit}
    ` as unknown as Memory[];
  } else if (opts?.type && opts?.sourcePrefix) {
    return await sql`
      SELECT * FROM memories
      WHERE valid_until IS NULL AND type = ${opts.type}
        AND source LIKE ${opts.sourcePrefix + ':%'}
      ORDER BY importance DESC, created_at DESC LIMIT ${limit}
    ` as unknown as Memory[];
  } else if (opts?.type && opts?.minImportance) {
    return await sql`
      SELECT * FROM memories
      WHERE valid_until IS NULL AND type = ${opts.type}
        AND importance >= ${opts.minImportance}
      ORDER BY importance DESC, created_at DESC LIMIT ${limit}
    ` as unknown as Memory[];
  } else if (opts?.sourcePrefix && opts?.minImportance) {
    return await sql`
      SELECT * FROM memories
      WHERE valid_until IS NULL
        AND source LIKE ${opts.sourcePrefix + ':%'} AND importance >= ${opts.minImportance}
      ORDER BY importance DESC, created_at DESC LIMIT ${limit}
    ` as unknown as Memory[];
  } else if (opts?.type) {
    return await sql`
      SELECT * FROM memories
      WHERE valid_until IS NULL AND type = ${opts.type}
      ORDER BY importance DESC, created_at DESC LIMIT ${limit}
    ` as unknown as Memory[];
  } else if (opts?.sourcePrefix) {
    return await sql`
      SELECT * FROM memories
      WHERE valid_until IS NULL AND source LIKE ${opts.sourcePrefix + ':%'}
      ORDER BY importance DESC, created_at DESC LIMIT ${limit}
    ` as unknown as Memory[];
  } else if (opts?.minImportance) {
    return await sql`
      SELECT * FROM memories
      WHERE valid_until IS NULL AND importance >= ${opts.minImportance}
      ORDER BY importance DESC, created_at DESC LIMIT ${limit}
    ` as unknown as Memory[];
  }

  return await sql`
    SELECT * FROM memories
    WHERE valid_until IS NULL
    ORDER BY importance DESC, created_at DESC LIMIT ${limit}
  ` as unknown as Memory[];
}

/**
 * Find memories mentioning a specific entity.
 * Uses the memory_entities junction table for O(log n) indexed lookup.
 */
export async function findMemoriesByEntity(
  sql: Sql,
  entity: string,
  opts?: { limit?: number },
): Promise<Memory[]> {
  const limit = opts?.limit ?? 10;
  return await sql`
    SELECT m.* FROM memories m
    JOIN memory_entities me ON m.id = me.memory_id
    WHERE LOWER(me.entity) = LOWER(${entity}) AND m.valid_until IS NULL
    ORDER BY m.importance DESC, m.created_at DESC LIMIT ${limit}
  ` as unknown as Memory[];
}

/**
 * Mark a memory as accessed (updates recency for retrieval scoring).
 */
export async function touchMemory(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE memories SET last_accessed_at = NOW(), access_count = access_count + 1
    WHERE id = ${id}
  `;
}

/**
 * Supersede a memory (mark it as replaced by a newer one).
 */
export async function supersedeMemory(sql: Sql, oldId: string, newId: string): Promise<void> {
  await sql`
    UPDATE memories SET valid_until = NOW(), superseded_by = ${newId}
    WHERE id = ${oldId}
  `;
}

/**
 * Check for near-duplicate memories by content similarity.
 * Uses tsvector to find candidates, then checks for high overlap.
 */
export async function findDuplicates(
  sql: Sql,
  content: string,
  type: MemoryType,
): Promise<Memory[]> {
  // Extract keywords for search (first 5 meaningful words)
  const keywords = content
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2)
    .slice(0, 5)
    .join(' ');

  if (!keywords) return [];

  // Join with OR so any keyword match counts
  const ftsQuery = keywords.split(/\s+/).join(' | ');
  return searchMemories(sql, ftsQuery, { limit: 5, type });
}

/**
 * Get recent memories created since a given timestamp.
 */
export async function getRecentMemories(
  sql: Sql,
  since: string,
  opts?: { limit?: number },
): Promise<Memory[]> {
  const limit = opts?.limit ?? 50;
  return await sql`
    SELECT * FROM memories WHERE created_at >= ${since} AND valid_until IS NULL
    ORDER BY created_at DESC LIMIT ${limit}
  ` as unknown as Memory[];
}

// ── People CRUD ──

export async function insertPerson(sql: Sql, person: NewPerson): Promise<string> {
  const id = generateId();
  await sql`
    INSERT INTO people (id, name, email, slack_id, relationship, organization, role)
    VALUES (${id}, ${person.name}, ${person.email ?? null}, ${person.slack_id ?? null},
            ${person.relationship ?? 'unknown'}, ${person.organization ?? null}, ${person.role ?? null})
  `;

  logger.debug({ id, name: person.name }, 'Person stored');
  return id;
}

export async function findPersonByName(sql: Sql, name: string): Promise<Person | null> {
  const [row] = await sql`SELECT * FROM people WHERE LOWER(name) = LOWER(${name})`;
  return row ? row as unknown as Person : null;
}

export async function findPersonBySlackId(sql: Sql, slackId: string): Promise<Person | null> {
  const [row] = await sql`SELECT * FROM people WHERE slack_id = ${slackId}`;
  return row ? row as unknown as Person : null;
}

export async function findPersonByEmail(sql: Sql, email: string): Promise<Person | null> {
  const [row] = await sql`SELECT * FROM people WHERE LOWER(email) = LOWER(${email})`;
  return row ? row as unknown as Person : null;
}

/**
 * Update a person's interaction tracking.
 */
export async function touchPerson(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE people SET last_interaction_at = NOW(), interaction_count = interaction_count + 1
    WHERE id = ${id}
  `;
}

/**
 * Update specific fields on a person record.
 */
export async function updatePerson(
  sql: Sql,
  id: string,
  updates: Partial<Pick<Person, 'email' | 'slack_id' | 'role' | 'organization' | 'relationship' | 'notes' | 'timezone'>>,
): Promise<void> {
  // Build update dynamically — postgres.js doesn't support dynamic column names in tagged templates,
  // so we use a single UPDATE with COALESCE-style conditional updates
  await sql`
    UPDATE people SET
      email = COALESCE(${updates.email ?? null}, email),
      slack_id = COALESCE(${updates.slack_id ?? null}, slack_id),
      role = COALESCE(${updates.role ?? null}, role),
      organization = COALESCE(${updates.organization ?? null}, organization),
      relationship = COALESCE(${updates.relationship ?? null}, relationship),
      notes = COALESCE(${updates.notes ?? null}, notes),
      timezone = COALESCE(${updates.timezone ?? null}, timezone)
    WHERE id = ${id}
  `;
}

/**
 * Find or create a person by name. Returns the person ID.
 */
export async function findOrCreatePerson(sql: Sql, person: NewPerson): Promise<string> {
  const existing = await findPersonByName(sql, person.name);
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
      await updatePerson(sql, existing.id, updates);
    }
    return existing.id;
  }
  return insertPerson(sql, person);
}

/**
 * Get all people, ordered by interaction frequency.
 */
export async function getAllPeople(sql: Sql, opts?: { limit?: number }): Promise<Person[]> {
  const limit = opts?.limit ?? 50;
  return await sql`
    SELECT * FROM people ORDER BY interaction_count DESC, last_interaction_at DESC LIMIT ${limit}
  ` as unknown as Person[];
}

// ── Vector operations ──

/**
 * pgvector is always available — extension loaded in schema.
 */
export async function hasVectorSupport(_sql: Sql): Promise<boolean> {
  return true;
}

/**
 * Store an embedding for a memory.
 */
export async function insertEmbedding(sql: Sql, memoryId: string, embedding: Float32Array): Promise<void> {
  try {
    const vec = pgvector.toSql(Array.from(embedding));
    await sql`UPDATE memories SET embedding = ${vec} WHERE id = ${memoryId}`;
  } catch (error) {
    logger.debug({ error, memoryId }, 'Failed to insert embedding');
  }
}

/**
 * Remove an embedding from a memory.
 */
export async function deleteEmbedding(sql: Sql, memoryId: string): Promise<void> {
  try {
    await sql`UPDATE memories SET embedding = NULL WHERE id = ${memoryId}`;
  } catch {
    // Non-critical
  }
}

/**
 * Semantic search: find memories similar to a query embedding.
 * Uses Reciprocal Rank Fusion with tsvector results when ftsQuery is provided.
 */
export async function vectorSearch(
  sql: Sql,
  queryEmbedding: Float32Array,
  opts?: { limit?: number; ftsQuery?: string },
): Promise<Memory[]> {
  const limit = opts?.limit ?? 10;

  if (opts?.ftsQuery) {
    // Hybrid search: single CTE query with RRF
    return hybridSearch(sql, queryEmbedding, opts.ftsQuery, limit);
  }

  // Pure vector search
  try {
    const vec = pgvector.toSql(Array.from(queryEmbedding));
    return await sql`
      SELECT * FROM memories
      WHERE embedding IS NOT NULL AND valid_until IS NULL
      ORDER BY embedding <=> ${vec}
      LIMIT ${limit}
    ` as unknown as Memory[];
  } catch (error) {
    logger.debug({ error }, 'Vector search failed');
    return [];
  }
}

/**
 * Hybrid search using Reciprocal Rank Fusion (RRF).
 * Single CTE query combining tsvector + vector results.
 */
async function hybridSearch(
  sql: Sql,
  queryEmbedding: Float32Array,
  ftsQuery: string,
  limit: number,
): Promise<Memory[]> {
  try {
    const vec = pgvector.toSql(Array.from(queryEmbedding));
    return await sql`
      WITH fts AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(content_tsv, to_tsquery('english', ${ftsQuery.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')})) DESC) as rn
        FROM memories
        WHERE content_tsv @@ to_tsquery('english', ${ftsQuery.trim().split(/\s+/).map(w => w.replace(/[^a-zA-Z0-9]/g, '')).filter(Boolean).join(' | ')}) AND valid_until IS NULL
        LIMIT 30
      ),
      vec AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> ${vec}) as rn
        FROM memories
        WHERE embedding IS NOT NULL AND valid_until IS NULL
        LIMIT 30
      )
      SELECT m.* FROM (
        SELECT COALESCE(f.id, v.id) as id,
          COALESCE(1.0/(60+f.rn),0) + COALESCE(1.0/(60+v.rn),0) as score
        FROM fts f FULL OUTER JOIN vec v USING (id)
      ) ranked
      JOIN memories m ON m.id = ranked.id
      ORDER BY ranked.score DESC
      LIMIT ${limit}
    ` as unknown as Memory[];
  } catch (error) {
    logger.debug({ error }, 'Hybrid search failed');
    return [];
  }
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
export async function getCategories(sql: Sql): Promise<CategoryRow[]> {
  return await sql`
    SELECT * FROM memory_categories ORDER BY count DESC
  ` as unknown as CategoryRow[];
}

/**
 * Format categories as a string list for prompt injection.
 */
export async function getCategoryList(sql: Sql): Promise<string> {
  const cats = await getCategories(sql);
  return cats
    .map(c => c.description ? `- "${c.name}" — ${c.description}` : `- "${c.name}"`)
    .join('\n');
}

/**
 * Find or create a category, normalizing on add.
 * If a fuzzy match is found against existing categories, returns the existing name.
 * Otherwise creates a new discovered category.
 */
export async function findOrCreateCategory(
  sql: Sql,
  name: string,
  description?: string,
  fuzzyThreshold = 0.8,
): Promise<string> {
  // Normalize: lowercase, trim, no trailing 's' for simple plurals
  const normalized = name.toLowerCase().trim().replace(/s$/, '');
  if (!normalized) return 'fact'; // fallback

  // Exact match (singular or plural)
  const [exact] = await sql`
    SELECT name FROM memory_categories WHERE name = ${normalized} OR name = ${normalized + 's'}
  `;
  if (exact) return exact.name as string;

  // Fuzzy match against existing categories
  const existing = await sql`SELECT name FROM memory_categories` as unknown as Array<{ name: string }>;

  for (const cat of existing) {
    if (categoryFuzzyMatch(normalized, cat.name) >= fuzzyThreshold) {
      return cat.name;
    }
  }

  // No match — create new discovered category
  await sql`
    INSERT INTO memory_categories (name, description, source)
    VALUES (${normalized}, ${description ?? null}, 'discovered')
    ON CONFLICT DO NOTHING
  `;

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
