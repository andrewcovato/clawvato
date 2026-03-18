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

  // Migrate: expand memory type CHECK constraint (v1 → v2)
  // SQLite can't ALTER CHECK constraints, so we recreate the table if needed
  try {
    // Test if new types are accepted
    db.exec(`INSERT INTO memories (id, type, content, source) VALUES ('__type_test__', 'strategy', 'test', 'migration')`);
    db.exec(`DELETE FROM memories WHERE id = '__type_test__'`);
  } catch {
    // Old constraint — need to migrate
    logger.info('Migrating memories table to support new memory types...');
    db.exec(`
      ALTER TABLE memories RENAME TO memories_old;
    `);
    // Re-run schema to create new table with expanded CHECK
    const newSchema = schema
      .split('\n')
      .filter(line => !line.trim().startsWith('CREATE INDEX') || !line.includes('memories'))
      .join('\n');
    try { db.exec(newSchema); } catch { /* tables may partially exist */ }
    db.exec(`
      INSERT INTO memories SELECT * FROM memories_old;
      DROP TABLE memories_old;
    `);
    logger.info('Memories table migrated successfully');
  }

  // One-time migration: reset documents + drive memories for re-sync with improved prompts
  // Safe to remove this block after it has run once on Railway (2026-03-18)
  try {
    const needsReset = db.prepare(
      "SELECT 1 FROM agent_state WHERE key = 'drive_reset_v5'"
    ).get();
    if (!needsReset) {
      logger.info('One-time reset: full memory clean slate (v5 — rebuild with better prompts)');
      db.exec("DELETE FROM documents");
      db.exec("UPDATE memories SET valid_until = datetime('now')");
      db.exec("DELETE FROM agent_state WHERE key LIKE 'wctx:%'");
      db.prepare(
        "INSERT OR REPLACE INTO agent_state (key, value, status) VALUES ('drive_reset_v5', ?, 'active')"
      ).run(new Date().toISOString());
    }
  } catch {
    // agent_state table may not exist yet on first run — that's fine
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
