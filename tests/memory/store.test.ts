/**
 * Tests for the Memory Store — CRUD operations for memories and people.
 *
 * Uses real SQLite databases in temp directories (same pattern as db.test.ts).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import { initDb, closeDb } from '../../src/db/index.js';
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
  insertPerson,
  findPersonByName,
  findPersonBySlackId,
  findPersonByEmail,
  touchPerson,
  updatePerson,
  findOrCreatePerson,
  getAllPeople,
} from '../../src/memory/store.js';
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

describe('Memory CRUD', () => {
  it('inserts and retrieves a memory', () => {
    const id = insertMemory(db, {
      type: 'fact',
      content: 'Jake works on the finance team',
      source: 'slack:C123:ts1',
      importance: 7,
      confidence: 0.9,
      entities: ['Jake'],
    });

    const memory = getMemory(db, id);
    expect(memory).not.toBeNull();
    expect(memory!.type).toBe('fact');
    expect(memory!.content).toBe('Jake works on the finance team');
    expect(memory!.importance).toBe(7);
    expect(memory!.confidence).toBe(0.9);
    expect(JSON.parse(memory!.entities)).toEqual(['Jake']);
    expect(memory!.valid_until).toBeNull();
    expect(memory!.access_count).toBe(0);
  });

  it('uses default importance and confidence', () => {
    const id = insertMemory(db, {
      type: 'observation',
      content: 'Andrew usually sends standup notes by 9am',
      source: 'inferred',
    });

    const memory = getMemory(db, id);
    expect(memory!.importance).toBe(5);
    expect(memory!.confidence).toBe(0.5);
  });

  it('finds memories by type', () => {
    insertMemory(db, { type: 'fact', content: 'Fact 1', source: 'test' });
    insertMemory(db, { type: 'fact', content: 'Fact 2', source: 'test' });
    insertMemory(db, { type: 'preference', content: 'Pref 1', source: 'test' });

    const facts = findMemoriesByType(db, 'fact');
    expect(facts).toHaveLength(2);

    const prefs = findMemoriesByType(db, 'preference');
    expect(prefs).toHaveLength(1);
  });

  it('filters out superseded memories when validOnly=true', () => {
    const id1 = insertMemory(db, { type: 'fact', content: 'Old fact', source: 'test' });
    const id2 = insertMemory(db, { type: 'fact', content: 'New fact', source: 'test' });
    supersedeMemory(db, id1, id2);

    const valid = findMemoriesByType(db, 'fact', { validOnly: true });
    expect(valid).toHaveLength(1);
    expect(valid[0].id).toBe(id2);

    const all = findMemoriesByType(db, 'fact', { validOnly: false });
    expect(all).toHaveLength(2);
  });

  it('searches memories via FTS5', () => {
    insertMemory(db, { type: 'fact', content: 'The quarterly budget review is on Fridays', source: 'test' });
    insertMemory(db, { type: 'fact', content: 'Sarah prefers morning meetings', source: 'test' });

    const results = searchMemories(db, 'budget review');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].content).toContain('budget');
  });

  it('returns empty for FTS5 with no matches', () => {
    insertMemory(db, { type: 'fact', content: 'Some fact', source: 'test' });
    const results = searchMemories(db, 'xyzzyzzy');
    expect(results).toHaveLength(0);
  });

  it('finds memories by entity', () => {
    insertMemory(db, {
      type: 'fact',
      content: 'Jake is on the sales team',
      source: 'test',
      entities: ['Jake'],
    });
    insertMemory(db, {
      type: 'fact',
      content: 'Sarah works in marketing',
      source: 'test',
      entities: ['Sarah'],
    });

    const jakeMemories = findMemoriesByEntity(db, 'Jake');
    expect(jakeMemories).toHaveLength(1);
    expect(jakeMemories[0].content).toContain('Jake');
  });

  it('touches a memory (updates access tracking)', () => {
    const id = insertMemory(db, { type: 'fact', content: 'Test', source: 'test' });

    touchMemory(db, id);
    const memory = getMemory(db, id);
    expect(memory!.access_count).toBe(1);
    expect(memory!.last_accessed_at).not.toBeNull();

    touchMemory(db, id);
    const updated = getMemory(db, id);
    expect(updated!.access_count).toBe(2);
  });

  it('supersedes a memory', () => {
    const oldId = insertMemory(db, { type: 'fact', content: 'Jake is on sales', source: 'test' });
    const newId = insertMemory(db, { type: 'fact', content: 'Jake is on marketing', source: 'test' });

    supersedeMemory(db, oldId, newId);

    const old = getMemory(db, oldId);
    expect(old!.valid_until).not.toBeNull();
    expect(old!.superseded_by).toBe(newId);

    const current = getMemory(db, newId);
    expect(current!.valid_until).toBeNull();
  });

  it('finds duplicates by keyword overlap', () => {
    insertMemory(db, { type: 'fact', content: 'Jake works on the finance team', source: 'test' });

    const dupes = findDuplicates(db, 'Jake is part of the finance team', 'fact');
    expect(dupes.length).toBeGreaterThanOrEqual(1);
  });

  it('gets recent memories since a timestamp', () => {
    insertMemory(db, { type: 'fact', content: 'Recent fact', source: 'test' });

    const recent = getRecentMemories(db, '2020-01-01');
    expect(recent.length).toBeGreaterThanOrEqual(1);

    const future = getRecentMemories(db, '2099-01-01');
    expect(future).toHaveLength(0);
  });

  it('respects limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      insertMemory(db, { type: 'fact', content: `Fact ${i}`, source: 'test' });
    }

    const limited = findMemoriesByType(db, 'fact', { limit: 3 });
    expect(limited).toHaveLength(3);
  });
});

describe('People CRUD', () => {
  it('inserts and finds a person by name', () => {
    insertPerson(db, { name: 'Jake Wilson', email: 'jake@corp.com', role: 'Engineer' });

    const person = findPersonByName(db, 'Jake Wilson');
    expect(person).not.toBeNull();
    expect(person!.name).toBe('Jake Wilson');
    expect(person!.email).toBe('jake@corp.com');
    expect(person!.role).toBe('Engineer');
    expect(person!.relationship).toBe('unknown');
    expect(person!.interaction_count).toBe(0);
  });

  it('finds person by name case-insensitively', () => {
    insertPerson(db, { name: 'Sarah Chen' });

    const found = findPersonByName(db, 'sarah chen');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Sarah Chen');
  });

  it('finds person by Slack ID', () => {
    insertPerson(db, { name: 'Sarah', slack_id: 'U123ABC' });

    const person = findPersonBySlackId(db, 'U123ABC');
    expect(person).not.toBeNull();
    expect(person!.name).toBe('Sarah');
  });

  it('finds person by email', () => {
    insertPerson(db, { name: 'Bob', email: 'bob@corp.com' });

    const person = findPersonByEmail(db, 'bob@corp.com');
    expect(person).not.toBeNull();
    expect(person!.name).toBe('Bob');
  });

  it('touches a person (updates interaction tracking)', () => {
    const id = insertPerson(db, { name: 'Jake' });

    touchPerson(db, id);
    const person = findPersonByName(db, 'Jake');
    expect(person!.interaction_count).toBe(1);
    expect(person!.last_interaction_at).not.toBeNull();
  });

  it('updates person fields', () => {
    const id = insertPerson(db, { name: 'Jake' });

    updatePerson(db, id, { email: 'jake@corp.com', role: 'Manager', timezone: 'US/Pacific' });

    const updated = findPersonByName(db, 'Jake');
    expect(updated!.email).toBe('jake@corp.com');
    expect(updated!.role).toBe('Manager');
    expect(updated!.timezone).toBe('US/Pacific');
  });

  it('findOrCreatePerson creates new person', () => {
    const id = findOrCreatePerson(db, { name: 'New Person', email: 'new@corp.com' });

    const person = findPersonByName(db, 'New Person');
    expect(person).not.toBeNull();
    expect(person!.id).toBe(id);
    expect(person!.email).toBe('new@corp.com');
  });

  it('findOrCreatePerson returns existing and enriches', () => {
    const id1 = findOrCreatePerson(db, { name: 'Jake' });
    const id2 = findOrCreatePerson(db, { name: 'Jake', email: 'jake@corp.com', role: 'Engineer' });

    expect(id2).toBe(id1);

    const person = findPersonByName(db, 'Jake');
    expect(person!.email).toBe('jake@corp.com');
    expect(person!.role).toBe('Engineer');
  });

  it('findOrCreatePerson does not overwrite existing fields with nothing', () => {
    findOrCreatePerson(db, { name: 'Jake', email: 'jake@corp.com' });
    findOrCreatePerson(db, { name: 'Jake' }); // no email this time

    const person = findPersonByName(db, 'Jake');
    expect(person!.email).toBe('jake@corp.com'); // not overwritten
  });

  it('getAllPeople returns people ordered by interaction count', () => {
    const id1 = insertPerson(db, { name: 'Alice' });
    const id2 = insertPerson(db, { name: 'Bob' });

    touchPerson(db, id2);
    touchPerson(db, id2);
    touchPerson(db, id1);

    const people = getAllPeople(db);
    expect(people[0].name).toBe('Bob');
    expect(people[1].name).toBe('Alice');
  });
});
