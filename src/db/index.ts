import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

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

  db = new DatabaseSync(dbPath);

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
