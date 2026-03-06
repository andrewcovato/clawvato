import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/config.js';
import { initDb, getDb, closeDb, generateId } from '../src/db/index.js';

describe('database', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clawvato-test-'));
    loadConfig({ dataDir: tmpDir });
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes database with schema', () => {
    const db = initDb();
    // Verify tables exist
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    ).all() as unknown as Array<{ name: string }>;
    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('memories');
    expect(tableNames).toContain('people');
    expect(tableNames).toContain('actions');
    expect(tableNames).toContain('action_patterns');
    expect(tableNames).toContain('workflows');
    expect(tableNames).toContain('plugins');
    expect(tableNames).toContain('schema_version');
  });

  it('generates unique IDs', () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^[0-9a-f]{8}-/); // UUID format
  });

  it('can insert and query memories', () => {
    const db = initDb();
    const id = generateId();

    db.prepare(`
      INSERT INTO memories (id, type, content, source, importance)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, 'fact', 'Test memory content', 'test', 7);

    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as {
      id: string; content: string; importance: number;
    };

    expect(row.id).toBe(id);
    expect(row.content).toBe('Test memory content');
    expect(row.importance).toBe(7);
  });

  it('can insert and query people', () => {
    const db = initDb();
    const id = generateId();

    db.prepare(`
      INSERT INTO people (id, name, email, relationship)
      VALUES (?, ?, ?, ?)
    `).run(id, 'Jake Martinez', 'jake@corp.com', 'colleague');

    const person = db.prepare('SELECT * FROM people WHERE email = ?').get('jake@corp.com') as unknown as {
      name: string; relationship: string;
    };

    expect(person.name).toBe('Jake Martinez');
    expect(person.relationship).toBe('colleague');
  });

  it('FTS5 search works on memories', () => {
    const db = initDb();
    const id = generateId();

    db.prepare(`
      INSERT INTO memories (id, type, content, source)
      VALUES (?, ?, ?, ?)
    `).run(id, 'fact', 'Andrew prefers morning meetings before lunch', 'test');

    const results = db.prepare(`
      SELECT m.* FROM memories m
      JOIN memories_fts ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH 'morning meetings'
    `).all() as unknown as Array<{ id: string; content: string }>;

    expect(results.length).toBe(1);
    expect(results[0].content).toContain('morning meetings');
  });

  it('enforces memory type constraints', () => {
    const db = initDb();
    expect(() => {
      db.prepare(`
        INSERT INTO memories (id, type, content, source)
        VALUES (?, ?, ?, ?)
      `).run(generateId(), 'invalid_type', 'test', 'test');
    }).toThrow();
  });

  it('is idempotent on repeated init', () => {
    const db1 = initDb();
    db1.prepare(`
      INSERT INTO memories (id, type, content, source)
      VALUES (?, ?, ?, ?)
    `).run(generateId(), 'fact', 'first init data', 'test');

    closeDb();

    // Re-init should not drop existing data
    const db2 = initDb();
    const count = db2.prepare('SELECT COUNT(*) as n FROM memories').get() as unknown as { n: number };
    expect(count.n).toBe(1);
  });
});
