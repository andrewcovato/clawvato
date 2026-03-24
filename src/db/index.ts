import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { reembedAllMemories } from '../memory/embeddings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Sql = postgres.Sql;

let sql: Sql | null = null;

export function getDb(): Sql {
  if (!sql) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return sql;
}

export async function initDb(): Promise<Sql> {
  if (sql) return sql;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL environment variable is required');
  }

  logger.info('Initializing Postgres database');

  sql = postgres(databaseUrl, {
    // Connection pool settings
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    // Transform undefined to null for consistency
    transform: {
      undefined: null,
    },
  });

  // Run schema
  const schemaPath = join(__dirname, 'schema.pg.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  await sql.unsafe(schema);

  // ── Migration: add surface_id column if missing ──
  const [hasSurfaceId] = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'surface_id'
  `;
  if (!hasSurfaceId) {
    logger.info('Migrating: adding surface_id column to memories');
    await sql`ALTER TABLE memories ADD COLUMN surface_id TEXT NOT NULL DEFAULT 'global'`;
    await sql`CREATE INDEX IF NOT EXISTS idx_memories_surface ON memories(surface_id)`;
    await sql`CREATE INDEX IF NOT EXISTS idx_memories_surface_valid ON memories(surface_id, valid_until)`;
    // Existing memories were created by the cloud agent — migrate them
    await sql`UPDATE memories SET surface_id = 'cloud' WHERE surface_id = 'global'`;
    logger.info('Migration complete: surface_id column added, existing memories set to cloud');
  }

  // ── Migration: add domain column if missing ──
  const [hasDomain] = await sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'memories' AND column_name = 'domain'
  `;
  if (!hasDomain) {
    logger.info('Migrating: adding domain column to memories');
    await sql`ALTER TABLE memories ADD COLUMN domain TEXT NOT NULL DEFAULT 'general'`;
    await sql`CREATE INDEX IF NOT EXISTS idx_memories_domain ON memories(domain)`;
    logger.info('Migration complete: domain column added');
  }

  // Seed categories on first run (check count, insert if 0)
  const [{ count }] = await sql`SELECT COUNT(*)::int as count FROM memory_categories`;
  if (count === 0) {
    const seedCategories: Array<[string, string]> = [
      ['fact', 'Objective truths about the world'],
      ['preference', 'How the owner likes things done'],
      ['decision', 'Choices made with reasoning'],
      ['observation', 'Patterns noticed but not confirmed'],
      ['strategy', 'Plans, approaches, pivots with rationale'],
      ['conclusion', 'Insights, analyses, realizations'],
      ['commitment', 'Promises, deadlines, deliverables'],
      ['reflection', 'System-generated synthesized insights'],
      ['technical', 'Code, architecture, APIs, debugging insights'],
      ['research', 'Findings from investigation or analysis'],
      ['project', 'Project status, milestones, blockers'],
      ['reference', 'Links, docs, resources to revisit'],
      ['learning', 'Lessons learned, mistakes, growth'],
      ['creative', 'Ideas, brainstorms, possibilities'],
      ['relationship', 'Dynamics between people, collaboration patterns'],
      ['artifact', 'Key assets: repos, directories, strategy docs, tools, infrastructure'],
    ];

    for (const [name, desc] of seedCategories) {
      await sql`
        INSERT INTO memory_categories (name, description, source)
        VALUES (${name}, ${desc}, 'seed')
        ON CONFLICT DO NOTHING
      `;
    }

    // Populate category counts from existing data
    await sql`
      UPDATE memory_categories SET count = (
        SELECT COUNT(*) FROM memories WHERE type = memory_categories.name AND valid_until IS NULL
      )
    `;

    logger.info({ categories: seedCategories.length }, 'Seed categories inserted');
  }

  logger.info('Database schema initialized');

  // Embedding backfill handled by plugin scheduler (clawvato-memory).

  return sql;
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
    logger.info('Database connection closed');
  }
}

// Generate a unique ID
export function generateId(): string {
  return crypto.randomUUID();
}
