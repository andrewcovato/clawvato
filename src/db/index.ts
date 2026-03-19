import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import * as sqliteVec from 'sqlite-vec';

const __dirname = dirname(fileURLToPath(import.meta.url));

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(): DatabaseSync {
  if (db) return db;

  const config = getConfig();
  const dbPath = join(config.dataDir, 'clawvato.db');

  logger.info({ dbPath }, 'Initializing SQLite database');

  db = new DatabaseSync(dbPath, { allowExtension: true });

  // Load sqlite-vec extension for vector search
  try {
    sqliteVec.load(db);
    logger.info('sqlite-vec extension loaded');
  } catch (err) {
    logger.warn({ error: err }, 'sqlite-vec extension not available — vector search disabled');
  }

  // Enable WAL mode for better concurrent read/write performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');

  // Run schema — strip PRAGMA lines (already set above) and execute the rest
  const schemaPath = join(__dirname, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8')
    .split('\n')
    .filter(line => !line.trim().startsWith('PRAGMA'))
    .join('\n');

  try {
    db.exec(schema);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('no such column: status') || msg.includes('no such column: entities')) {
      // Migration: add entities column to existing documents table
      logger.info('Migrating schema — adding missing columns...');
      try { db.exec(`ALTER TABLE documents ADD COLUMN entities TEXT DEFAULT '[]'`); } catch { /* may already exist */ }
      try { db.exec(`ALTER TABLE agent_state ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`); } catch { /* may already exist */ }
      // Retry schema (for the index)
      try { db.exec(schema); } catch { /* tables exist, fine */ }
      logger.info('Documents table migrated');
    } else if (!msg.includes('already exists')) {
      throw err;
    }
  }

  // Migrate: remove type CHECK constraint (allows dynamic categories)
  // SQLite can't ALTER CHECK constraints, so we recreate the table if needed.
  // Self-healing: handles partial migration state from prior crash.

  // First: check if memories_old exists from a prior crashed migration
  const hasMemoriesOld = (() => {
    try {
      db.exec("SELECT 1 FROM memories_old LIMIT 1");
      return true;
    } catch { return false; }
  })();

  if (hasMemoriesOld) {
    // Prior migration crashed mid-way — recover
    logger.info('Recovering from partial type migration — memories_old found');
    // Ensure memories table exists with new schema
    try { db.exec(schema); } catch { /* tables may partially exist */ }
    // Check if memories has data
    const count = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    if (count === 0) {
      // Data is in memories_old — copy it over
      db.exec('INSERT INTO memories SELECT * FROM memories_old;');
      logger.info('Recovered data from memories_old');
    }
    db.exec('DROP TABLE IF EXISTS memories_old;');
    logger.info('Cleaned up memories_old');
  } else {
    // Normal check: test if dynamic types are accepted
    try {
      db.exec(`INSERT INTO memories (id, type, content, source) VALUES ('__type_test__', 'technical', 'test', 'migration')`);
      db.exec(`DELETE FROM memories WHERE id = '__type_test__'`);
    } catch {
      // Old constraint — need to migrate to unconstrained type column
      logger.info('Migrating memories table to remove type CHECK constraint (dynamic categories)...');
      db.exec(`ALTER TABLE memories RENAME TO memories_old;`);
      // Create fresh memories table with new schema (no CHECK)
      try { db.exec(schema); } catch { /* tables may partially exist */ }
      db.exec(`
        INSERT INTO memories SELECT * FROM memories_old;
        DROP TABLE memories_old;
      `);
      logger.info('Memories table migrated successfully — dynamic categories enabled');
    }
  }

  // Migrate: populate memory_entities junction table from JSON entities column
  const entityMigrationDone = db.prepare(
    "SELECT value FROM agent_state WHERE key = 'migration:memory_entities_v1'"
  ).get() as { value: string } | undefined;

  if (!entityMigrationDone) {
    logger.info('Migrating: populating memory_entities junction table...');
    const rows = db.prepare(
      "SELECT id, entities FROM memories WHERE entities != '[]' AND entities IS NOT NULL AND valid_until IS NULL"
    ).all() as Array<{ id: string; entities: string }>;

    const insertEntity = db.prepare(
      'INSERT OR IGNORE INTO memory_entities (memory_id, entity) VALUES (?, ?)'
    );
    let entityCount = 0;
    for (const row of rows) {
      try {
        const entities = JSON.parse(row.entities) as string[];
        for (const entity of entities) {
          if (entity && typeof entity === 'string') {
            insertEntity.run(row.id, entity);
            entityCount++;
          }
        }
      } catch { /* malformed JSON — skip */ }
    }

    // Seed memory_categories with defaults
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

    const insertCategory = db.prepare(
      "INSERT OR IGNORE INTO memory_categories (name, description, source) VALUES (?, ?, 'seed')"
    );
    for (const [name, desc] of seedCategories) {
      insertCategory.run(name, desc);
    }

    // Populate category counts from existing data
    db.exec(`
      UPDATE memory_categories SET count = (
        SELECT COUNT(*) FROM memories WHERE type = memory_categories.name AND valid_until IS NULL
      )
    `);

    // Mark migration complete
    db.prepare(
      "INSERT OR REPLACE INTO agent_state (key, value, status, updated_at) VALUES ('migration:memory_entities_v1', 'done', 'active', datetime('now'))"
    ).run();

    logger.info({ entityCount, memories: rows.length, categories: seedCategories.length }, 'Entity junction + category migration complete');
  }

  // Create vector table (requires sqlite-vec extension)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0(
        memory_id TEXT PRIMARY KEY,
        embedding float[384]
      )
    `);
  } catch {
    // sqlite-vec not available — skip vector table
    logger.debug('memories_vec table not created — sqlite-vec not loaded');
  }

  logger.info('Database schema initialized');
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

// Generate a unique ID
export function generateId(): string {
  return crypto.randomUUID();
}
