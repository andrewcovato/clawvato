/**
 * Tests for the Memory Consolidation pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestSql } from '../helpers/pg-test.js';
import { insertMemory, findMemoriesByType } from '../../src/memory/store.js';
import { shouldConsolidate, consolidate } from '../../src/memory/consolidation.js';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ sql, cleanup } = await createTestDb());
});

afterEach(async () => {
  await cleanup();
});

describe('shouldConsolidate', () => {
  it('returns true when never run before', async () => {
    expect(await shouldConsolidate(sql)).toBe(true);
  });

  it('returns false after a recent run', async () => {
    // Run consolidation first
    await consolidate(sql);
    expect(await shouldConsolidate(sql)).toBe(false);
  });
});

describe('consolidate', () => {
  it('returns zero counts on empty database', async () => {
    const result = await consolidate(sql);

    expect(result.memoriesProcessed).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
  });

  it('merges near-duplicate memories', async () => {
    await insertMemory(sql, {
      type: 'fact',
      content: 'Jake works on the finance team at Acme Corp',
      source: 'test1',
      importance: 7,
      confidence: 0.9,
    });
    await insertMemory(sql, {
      type: 'fact',
      content: 'Jake works on the finance team at Acme',
      source: 'test2',
      importance: 5,
      confidence: 0.8,
    });

    const result = await consolidate(sql);

    expect(result.merged).toBe(1);

    // Only one should be valid
    const facts = await findMemoriesByType(sql, 'fact', { validOnly: true });
    expect(facts).toHaveLength(1);
    expect(facts[0].importance).toBe(7); // Higher importance kept

    // Verify supersede direction: lower importance points to higher importance
    const allFacts = await findMemoriesByType(sql, 'fact', { validOnly: false });
    const superseded = allFacts.find(f => f.valid_until !== null);
    const kept = allFacts.find(f => f.valid_until === null);
    expect(superseded!.superseded_by).toBe(kept!.id);
  });

  it('does not merge unrelated memories', async () => {
    await insertMemory(sql, {
      type: 'fact',
      content: 'Jake works on the finance team',
      source: 'test1',
      importance: 7,
    });
    await insertMemory(sql, {
      type: 'fact',
      content: 'Sarah prefers morning meetings',
      source: 'test2',
      importance: 6,
    });

    const result = await consolidate(sql);

    expect(result.merged).toBe(0);

    const facts = await findMemoriesByType(sql, 'fact', { validOnly: true });
    expect(facts).toHaveLength(2);
  });

  it('archives memories with importance <= 1', async () => {
    await insertMemory(sql, {
      type: 'observation',
      content: 'Trivial observation',
      source: 'test',
      importance: 1,
    });
    await insertMemory(sql, {
      type: 'fact',
      content: 'Important fact',
      source: 'test',
      importance: 8,
    });

    const result = await consolidate(sql);

    expect(result.archived).toBe(1);

    // Important fact should still be valid
    const facts = await findMemoriesByType(sql, 'fact', { validOnly: true });
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('Important fact');

    // Observation should be archived
    const observations = await findMemoriesByType(sql, 'observation', { validOnly: true });
    expect(observations).toHaveLength(0);
  });

  it('does not archive preferences even at low importance', async () => {
    await insertMemory(sql, {
      type: 'preference',
      content: 'Prefers dark mode',
      source: 'test',
      importance: 1,
    });

    const result = await consolidate(sql);

    expect(result.archived).toBe(0);

    const prefs = await findMemoriesByType(sql, 'preference', { validOnly: true });
    expect(prefs).toHaveLength(1);
  });

  it('does not archive commitments even at low importance', async () => {
    await insertMemory(sql, {
      type: 'commitment',
      content: 'Promised to deliver report by Friday',
      source: 'test',
      importance: 1,
    });

    const result = await consolidate(sql);

    expect(result.archived).toBe(0);
  });

  it('records consolidation run in the database', async () => {
    await consolidate(sql);

    const runs = await sql`
      SELECT * FROM consolidation_runs ORDER BY completed_at DESC LIMIT 1
    `;

    expect(runs.length).toBeGreaterThan(0);
    expect(runs[0].completed_at).toBeTruthy();
  });

  it('handles multiple consolidation runs', async () => {
    await insertMemory(sql, { type: 'observation', content: 'Obs 1', source: 'test', importance: 1 });

    const result1 = await consolidate(sql);
    expect(result1.archived).toBe(1);

    await insertMemory(sql, { type: 'observation', content: 'Obs 2', source: 'test', importance: 1 });

    const result2 = await consolidate(sql);
    expect(result2.archived).toBe(1);
  });
});
