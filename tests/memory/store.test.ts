/**
 * Tests for the Memory Store — CRUD operations for memories.
 *
 * Uses isolated Postgres schemas per test suite via pg-test helper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestSql } from '../helpers/pg-test.js';
import {
  insertMemory,
  getMemory,
  findMemoriesByType,
  searchMemories,
  findMemoriesByEntity,
  touchMemory,
  supersedeMemory,
  findDuplicates,
  getRecentMemories,
} from '../../src/memory/store.js';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const testDb = await createTestDb();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('Memory CRUD', () => {
  it('inserts and retrieves a memory', async () => {
    const id = await insertMemory(sql, {
      type: 'fact',
      content: 'Jake works on the finance team',
      source: 'slack:C123:ts1',
      importance: 7,
      confidence: 0.9,
      entities: ['Jake'],
    });

    const memory = await getMemory(sql, id);
    expect(memory).not.toBeNull();
    expect(memory!.type).toBe('fact');
    expect(memory!.content).toBe('Jake works on the finance team');
    expect(memory!.importance).toBe(7);
    expect(memory!.confidence).toBe(0.9);
    expect(JSON.parse(memory!.entities)).toEqual(['Jake']);
    expect(memory!.valid_until).toBeNull();
    expect(memory!.access_count).toBe(0);
  });

  it('uses default importance and confidence', async () => {
    const id = await insertMemory(sql, {
      type: 'observation',
      content: 'Andrew usually sends standup notes by 9am',
      source: 'inferred',
    });

    const memory = await getMemory(sql, id);
    expect(memory!.importance).toBe(5);
    expect(memory!.confidence).toBe(0.5);
  });

  it('finds memories by type', async () => {
    await insertMemory(sql, { type: 'fact', content: 'Fact 1', source: 'test' });
    await insertMemory(sql, { type: 'fact', content: 'Fact 2', source: 'test' });
    await insertMemory(sql, { type: 'preference', content: 'Pref 1', source: 'test' });

    const facts = await findMemoriesByType(sql, 'fact');
    expect(facts).toHaveLength(2);

    const prefs = await findMemoriesByType(sql, 'preference');
    expect(prefs).toHaveLength(1);
  });

  it('filters out superseded memories when validOnly=true', async () => {
    const id1 = await insertMemory(sql, { type: 'fact', content: 'Old fact', source: 'test' });
    const id2 = await insertMemory(sql, { type: 'fact', content: 'New fact', source: 'test' });
    await supersedeMemory(sql, id1, id2);

    const valid = await findMemoriesByType(sql, 'fact', { validOnly: true });
    expect(valid).toHaveLength(1);
    expect(valid[0].id).toBe(id2);

    const all = await findMemoriesByType(sql, 'fact', { validOnly: false });
    expect(all).toHaveLength(2);
  });

  it('searches memories via full-text search', async () => {
    await insertMemory(sql, { type: 'fact', content: 'The quarterly budget review is on Fridays', source: 'test' });
    await insertMemory(sql, { type: 'fact', content: 'Sarah prefers morning meetings', source: 'test' });

    const results = await searchMemories(sql, 'budget review');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('budget');
  });

  it('returns empty for full-text search with no matches', async () => {
    await insertMemory(sql, { type: 'fact', content: 'Some fact', source: 'test' });
    const results = await searchMemories(sql, 'xyzzyzzy');
    expect(results).toHaveLength(0);
  });

  it('finds memories by entity', async () => {
    await insertMemory(sql, {
      type: 'fact',
      content: 'Jake is on the sales team',
      source: 'test',
      entities: ['Jake'],
    });
    await insertMemory(sql, {
      type: 'fact',
      content: 'Sarah works in marketing',
      source: 'test',
      entities: ['Sarah'],
    });

    const jakeMemories = await findMemoriesByEntity(sql, 'Jake');
    expect(jakeMemories).toHaveLength(1);
    expect(jakeMemories[0].content).toContain('Jake');
  });

  it('touches a memory (updates access tracking)', async () => {
    const id = await insertMemory(sql, { type: 'fact', content: 'Test', source: 'test' });

    await touchMemory(sql, id);
    const memory = await getMemory(sql, id);
    expect(memory!.access_count).toBe(1);
    expect(memory!.last_accessed_at).not.toBeNull();

    await touchMemory(sql, id);
    const updated = await getMemory(sql, id);
    expect(updated!.access_count).toBe(2);
  });

  it('supersedes a memory', async () => {
    const oldId = await insertMemory(sql, { type: 'fact', content: 'Jake is on sales', source: 'test' });
    const newId = await insertMemory(sql, { type: 'fact', content: 'Jake is on marketing', source: 'test' });

    await supersedeMemory(sql, oldId, newId);

    const old = await getMemory(sql, oldId);
    expect(old!.valid_until).not.toBeNull();
    expect(old!.superseded_by).toBe(newId);

    const current = await getMemory(sql, newId);
    expect(current!.valid_until).toBeNull();
  });

  it('finds duplicates by keyword overlap', async () => {
    await insertMemory(sql, { type: 'fact', content: 'Jake works on the finance team', source: 'test' });

    const dupes = await findDuplicates(sql, 'Jake is part of the finance team', 'fact');
    expect(dupes.length).toBeGreaterThanOrEqual(1);
  });

  it('gets recent memories since a timestamp', async () => {
    await insertMemory(sql, { type: 'fact', content: 'Recent fact', source: 'test' });

    const recent = await getRecentMemories(sql, '2020-01-01');
    expect(recent.length).toBeGreaterThanOrEqual(1);

    const future = await getRecentMemories(sql, '2099-01-01');
    expect(future).toHaveLength(0);
  });

  it('respects limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await insertMemory(sql, { type: 'fact', content: `Fact ${i}`, source: 'test' });
    }

    const limited = await findMemoriesByType(sql, 'fact', { limit: 3 });
    expect(limited).toHaveLength(3);
  });
});

