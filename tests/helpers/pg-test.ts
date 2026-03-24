/**
 * Test helper for Postgres-backed tests.
 *
 * Each test gets an isolated Postgres schema.
 * Uses TEST_DATABASE_URL or DATABASE_URL.
 */

import postgres from 'postgres';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export type TestSql = postgres.Sql;

/**
 * Create an isolated test database connection with its own schema.
 */
export async function createTestDb(): Promise<{ sql: TestSql; cleanup: () => Promise<void>; schemaName: string }> {
  const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('TEST_DATABASE_URL or DATABASE_URL environment variable is required for tests');
  }

  const schemaName = `test_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  // Create schema using a temporary connection
  const setupSql = postgres(databaseUrl, { max: 1 });
  await setupSql.unsafe(`CREATE SCHEMA ${schemaName}`);
  await setupSql.end();

  // Main connection with search_path set via connection option
  // (persists across pool connections, unlike SET search_path)
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 5,
    transform: { undefined: null },
    connection: { search_path: `${schemaName}, public` },
  });

  // Run the Postgres schema
  const schemaPath = join(__dirname, '..', '..', 'src', 'db', 'schema.pg.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  await sql.unsafe(schema);

  // Verify isolation — the search_path should be our test schema
  const [check] = await sql`SELECT current_schema() as s`;
  if (check.s !== schemaName) {
    throw new Error(`Schema isolation failed: expected ${schemaName}, got ${check.s}`);
  }

  const cleanup = async () => {
    try {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    } catch { /* may already be dropped */ }
    await sql.end();
  };

  return { sql, cleanup, schemaName };
}
