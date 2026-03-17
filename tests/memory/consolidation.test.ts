/**
 * Tests for the Memory Consolidation pipeline.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import { initDb, closeDb } from '../../src/db/index.js';
import { insertMemory, getMemory, findMemoriesByType, touchMemory } from '../../src/memory/store.js';
import { shouldConsolidate, consolidate } from '../../src/memory/consolidation.js';
import type { DatabaseSync } from 'node:sqlite';

let db: DatabaseSync;
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'clawvato-test-'));
  loadConfig({ dataDir: tmpDir });
  db = initDb();
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('shouldConsolidate', () => {
  it('returns true when never run before', () => {
    expect(shouldConsolidate(db)).toBe(true);
  });

  it('returns false after a recent run', () => {
    // Run consolidation first
    consolidate(db);
    expect(shouldConsolidate(db)).toBe(false);
  });
});

describe('consolidate', () => {
  it('returns zero counts on empty database', () => {
    const result = consolidate(db);

    expect(result.memoriesProcessed).toBe(0);
    expect(result.merged).toBe(0);
    expect(result.decayed).toBe(0);
    expect(result.archived).toBe(0);
  });

  it('merges near-duplicate memories', () => {
    insertMemory(db, {
      type: 'fact',
      content: 'Jake works on the finance team at Acme Corp',
      source: 'test1',
      importance: 7,
      confidence: 0.9,
    });
    insertMemory(db, {
      type: 'fact',
      content: 'Jake works on the finance team at Acme',
      source: 'test2',
      importance: 5,
      confidence: 0.8,
    });

    const result = consolidate(db);

    expect(result.merged).toBe(1);

    // Only one should be valid
    const facts = findMemoriesByType(db, 'fact', { validOnly: true });
    expect(facts).toHaveLength(1);
    expect(facts[0].importance).toBe(7); // Higher importance kept

    // Verify supersede direction: lower importance points to higher importance
    const allFacts = findMemoriesByType(db, 'fact', { validOnly: false });
    const superseded = allFacts.find(f => f.valid_until !== null);
    const kept = allFacts.find(f => f.valid_until === null);
    expect(superseded!.superseded_by).toBe(kept!.id);
  });

  it('does not merge unrelated memories', () => {
    insertMemory(db, {
      type: 'fact',
      content: 'Jake works on the finance team',
      source: 'test1',
      importance: 7,
    });
    insertMemory(db, {
      type: 'fact',
      content: 'Sarah prefers morning meetings',
      source: 'test2',
      importance: 6,
    });

    const result = consolidate(db);

    expect(result.merged).toBe(0);

    const facts = findMemoriesByType(db, 'fact', { validOnly: true });
    expect(facts).toHaveLength(2);
  });

  it('archives memories with importance <= 1', () => {
    insertMemory(db, {
      type: 'observation',
      content: 'Trivial observation',
      source: 'test',
      importance: 1,
    });
    insertMemory(db, {
      type: 'fact',
      content: 'Important fact',
      source: 'test',
      importance: 8,
    });

    const result = consolidate(db);

    expect(result.archived).toBe(1);

    // Important fact should still be valid
    const facts = findMemoriesByType(db, 'fact', { validOnly: true });
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('Important fact');

    // Observation should be archived
    const observations = findMemoriesByType(db, 'observation', { validOnly: true });
    expect(observations).toHaveLength(0);
  });

  it('does not archive preferences even at low importance', () => {
    insertMemory(db, {
      type: 'preference',
      content: 'Prefers dark mode',
      source: 'test',
      importance: 1,
    });

    const result = consolidate(db);

    expect(result.archived).toBe(0);

    const prefs = findMemoriesByType(db, 'preference', { validOnly: true });
    expect(prefs).toHaveLength(1);
  });

  it('does not archive commitments even at low importance', () => {
    insertMemory(db, {
      type: 'commitment',
      content: 'Promised to deliver report by Friday',
      source: 'test',
      importance: 1,
    });

    const result = consolidate(db);

    expect(result.archived).toBe(0);
  });

  it('records consolidation run in the database', () => {
    consolidate(db);

    const runs = db.prepare(
      "SELECT * FROM consolidation_runs ORDER BY completed_at DESC LIMIT 1"
    ).get() as Record<string, unknown> | undefined;

    expect(runs).toBeDefined();
    expect(runs!.completed_at).toBeTruthy();
  });

  it('handles multiple consolidation runs', () => {
    insertMemory(db, { type: 'observation', content: 'Obs 1', source: 'test', importance: 1 });

    const result1 = consolidate(db);
    expect(result1.archived).toBe(1);

    insertMemory(db, { type: 'observation', content: 'Obs 2', source: 'test', importance: 1 });

    const result2 = consolidate(db);
    expect(result2.archived).toBe(1);
  });
});
