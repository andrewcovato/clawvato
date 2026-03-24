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

  // Run embedding migration in background (non-blocking)
  reembedAllMemories(sql).catch(err => {
    logger.warn({ error: err }, 'Embedding migration failed — will retry on next startup');
  });

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
