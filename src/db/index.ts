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

  // Migrate: remove type CHECK constraint (allows dynamic categories)
  // Self-healing: handles corrupted FTS5 state from prior crash-restart loops.
  //
  // The FTS5 content table (memories_fts with content='memories') gets corrupted
  // when memories is renamed. We detect this and do a clean rebuild.

  // Check for stale memories_old from a prior crashed migration
  const hasMemoriesOld = (() => {
    try {
      db.exec("SELECT 1 FROM memories_old LIMIT 1");
      return true;
    } catch { return false; }
  })();

  if (hasMemoriesOld) {
    // Prior migration crashed — rebuild clean
    logger.info('Recovering from partial type migration — rebuilding memories table...');

    // Drop corrupted FTS5 state (triggers reference stale content table)
    try { db.exec('DROP TRIGGER IF EXISTS memories_ai;'); } catch { /* */ }
    try { db.exec('DROP TRIGGER IF EXISTS memories_ad;'); } catch { /* */ }
    try { db.exec('DROP TRIGGER IF EXISTS memories_au;'); } catch { /* */ }
    try { db.exec('DROP TABLE IF EXISTS memories_fts;'); } catch { /* */ }
    try { db.exec('DROP TABLE IF EXISTS memories;'); } catch { /* */ }

    // Rename memories_old back to memories (preserves data)
    db.exec('ALTER TABLE memories_old RENAME TO memories;');

    // Now re-run full schema — creates FTS5 + triggers + new tables
    // The memories table exists with data, CREATE TABLE IF NOT EXISTS is a no-op for it
    // But we need the CHECK constraint removed — so rebuild:
    // 1. Create temp table with new schema
    db.exec(`CREATE TABLE memories_new (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
      confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
      valid_from TEXT NOT NULL DEFAULT (datetime('now')),
      valid_until TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_accessed_at TEXT,
      access_count INTEGER NOT NULL DEFAULT 0,
      entities TEXT DEFAULT '[]',
      superseded_by TEXT,
      reflection_source INTEGER DEFAULT 0
    );`);
    // 2. Copy data
    db.exec('INSERT INTO memories_new SELECT * FROM memories;');
    // 3. Drop old table
    db.exec('DROP TABLE memories;');
    // 4. Rename
    db.exec('ALTER TABLE memories_new RENAME TO memories;');
    // 5. Re-run schema for FTS5 + triggers + indexes + new tables
    try { db.exec(schema); } catch { /* tables may partially exist */ }

    logger.info('Recovery complete — memories table rebuilt with dynamic categories');
  } else {
    // Normal path: test if dynamic types are accepted
    let needsMigration = false;
    try {
      db.exec(`INSERT INTO memories (id, type, content, source) VALUES ('__type_test__', 'technical', 'test', 'migration')`);
      db.exec(`DELETE FROM memories WHERE id = '__type_test__'`);
    } catch {
      needsMigration = true;
    }

    if (needsMigration) {
      logger.info('Migrating memories table to remove type CHECK constraint...');

      // Drop FTS5 triggers + table first (they reference memories)
      try { db.exec('DROP TRIGGER IF EXISTS memories_ai;'); } catch { /* */ }
      try { db.exec('DROP TRIGGER IF EXISTS memories_ad;'); } catch { /* */ }
      try { db.exec('DROP TRIGGER IF EXISTS memories_au;'); } catch { /* */ }
      try { db.exec('DROP TABLE IF EXISTS memories_fts;'); } catch { /* */ }

      // Rebuild memories table without CHECK constraint
      db.exec('ALTER TABLE memories RENAME TO memories_old;');
      db.exec(`CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        importance INTEGER NOT NULL DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
        confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
        valid_from TEXT NOT NULL DEFAULT (datetime('now')),
        valid_until TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        entities TEXT DEFAULT '[]',
        superseded_by TEXT,
        reflection_source INTEGER DEFAULT 0
      );`);
      db.exec('INSERT INTO memories SELECT * FROM memories_old;');
      db.exec('DROP TABLE memories_old;');

      // Re-run schema for FTS5 + triggers + indexes + new tables
      try { db.exec(schema); } catch { /* tables may partially exist */ }

      logger.info('Memories table migrated — dynamic categories enabled');
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
