import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateId } from '../src/db/index.js';
import { createTestDb, type TestSql } from './helpers/pg-test.js';

describe('database', () => {
  let sql: TestSql;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ sql, cleanup } = await createTestDb());
  });

  afterEach(async () => {
    await cleanup();
  });

  it('initializes database with schema', async () => {
    // Verify tables exist
    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const tableNames = tables.map(t => t.table_name);

    expect(tableNames).toContain('memories');
    expect(tableNames).toContain('memory_entities');
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

  it('can insert and query memories', async () => {
    const id = generateId();

    await sql`
      INSERT INTO memories (id, type, content, source, importance)
      VALUES (${id}, 'fact', 'Test memory content', 'test', 7)
    `;

    const [row] = await sql`SELECT * FROM memories WHERE id = ${id}`;

    expect(row.id).toBe(id);
    expect(row.content).toBe('Test memory content');
    expect(row.importance).toBe(7);
  });

  it('can insert and query memory entities', async () => {
    const id = generateId();

    await sql`
      INSERT INTO memories (id, type, content, source, importance)
      VALUES (${id}, 'relationship', 'Jake Martinez is a colleague at Corp', 'test', 7)
    `;
    await sql`
      INSERT INTO memory_entities (memory_id, entity)
      VALUES (${id}, 'Jake Martinez')
    `;

    const [entity] = await sql`SELECT * FROM memory_entities WHERE entity = 'Jake Martinez'`;
    expect(entity.memory_id).toBe(id);
  });

  it('tsvector search works on memories', async () => {
    const id = generateId();

    await sql`
      INSERT INTO memories (id, type, content, source)
      VALUES (${id}, 'fact', 'Andrew prefers morning meetings before lunch', 'test')
    `;

    const results = await sql`
      SELECT * FROM memories
      WHERE content_tsv @@ plainto_tsquery('english', 'morning meetings')
    `;

    expect(results.length).toBe(1);
    expect(results[0].content).toContain('morning meetings');
  });

  it('allows dynamic memory types (no CHECK constraint on type)', async () => {
    const id = generateId();
    // Dynamic categories — any string type is allowed at the schema level
    await sql`
      INSERT INTO memories (id, type, content, source)
      VALUES (${id}, 'custom_dynamic_type', 'test', 'test')
    `;
    await sql`DELETE FROM memories WHERE id = ${id}`;
  });

  it('is idempotent on repeated schema application', async () => {
    await sql`
      INSERT INTO memories (id, type, content, source)
      VALUES (${generateId()}, 'fact', 'first init data', 'test')
    `;

    // Re-running schema should not drop existing data (IF NOT EXISTS)
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const schemaPath = join(__dirname, '..', 'src', 'db', 'schema.pg.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    await sql.unsafe(schema);

    const [count] = await sql`SELECT COUNT(*)::int as n FROM memories`;
    expect(count.n).toBe(1);
  });
});
