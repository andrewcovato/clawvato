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
    // On subsequent runs, tables/triggers already exist — that's fine
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('already exists')) {
      throw err;
    }
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
