/**
 * Tests for the Memory Store — CRUD operations for memories and people.
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
  insertPerson,
  findPersonByName,
  findPersonBySlackId,
  findPersonByEmail,
  touchPerson,
  updatePerson,
  findOrCreatePerson,
  getAllPeople,
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

describe('People CRUD', () => {
  it('inserts and finds a person by name', async () => {
    await insertPerson(sql, { name: 'Jake Wilson', email: 'jake@corp.com', role: 'Engineer' });

    const person = await findPersonByName(sql, 'Jake Wilson');
    expect(person).not.toBeNull();
    expect(person!.name).toBe('Jake Wilson');
    expect(person!.email).toBe('jake@corp.com');
    expect(person!.role).toBe('Engineer');
    expect(person!.relationship).toBe('unknown');
    expect(person!.interaction_count).toBe(0);
  });

  it('finds person by name case-insensitively', async () => {
    await insertPerson(sql, { name: 'Sarah Chen' });

    const found = await findPersonByName(sql, 'sarah chen');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Sarah Chen');
  });

  it('finds person by Slack ID', async () => {
    await insertPerson(sql, { name: 'Sarah', slack_id: 'U123ABC' });

    const person = await findPersonBySlackId(sql, 'U123ABC');
    expect(person).not.toBeNull();
    expect(person!.name).toBe('Sarah');
  });

  it('finds person by email', async () => {
    await insertPerson(sql, { name: 'Bob', email: 'bob@corp.com' });

    const person = await findPersonByEmail(sql, 'bob@corp.com');
    expect(person).not.toBeNull();
    expect(person!.name).toBe('Bob');
  });

  it('touches a person (updates interaction tracking)', async () => {
    const id = await insertPerson(sql, { name: 'Jake' });

    await touchPerson(sql, id);
    const person = await findPersonByName(sql, 'Jake');
    expect(person!.interaction_count).toBe(1);
    expect(person!.last_interaction_at).not.toBeNull();
  });

  it('updates person fields', async () => {
    const id = await insertPerson(sql, { name: 'Jake' });

    await updatePerson(sql, id, { email: 'jake@corp.com', role: 'Manager', timezone: 'US/Pacific' });

    const updated = await findPersonByName(sql, 'Jake');
    expect(updated!.email).toBe('jake@corp.com');
    expect(updated!.role).toBe('Manager');
    expect(updated!.timezone).toBe('US/Pacific');
  });

  it('findOrCreatePerson creates new person', async () => {
    const id = await findOrCreatePerson(sql, { name: 'New Person', email: 'new@corp.com' });

    const person = await findPersonByName(sql, 'New Person');
    expect(person).not.toBeNull();
    expect(person!.id).toBe(id);
    expect(person!.email).toBe('new@corp.com');
  });

  it('findOrCreatePerson returns existing and enriches', async () => {
    const id1 = await findOrCreatePerson(sql, { name: 'Jake' });
    const id2 = await findOrCreatePerson(sql, { name: 'Jake', email: 'jake@corp.com', role: 'Engineer' });

    expect(id2).toBe(id1);

    const person = await findPersonByName(sql, 'Jake');
    expect(person!.email).toBe('jake@corp.com');
    expect(person!.role).toBe('Engineer');
  });

  it('findOrCreatePerson does not overwrite existing fields with nothing', async () => {
    await findOrCreatePerson(sql, { name: 'Jake', email: 'jake@corp.com' });
    await findOrCreatePerson(sql, { name: 'Jake' }); // no email this time

    const person = await findPersonByName(sql, 'Jake');
    expect(person!.email).toBe('jake@corp.com'); // not overwritten
  });

  it('getAllPeople returns people ordered by interaction count', async () => {
    const id1 = await insertPerson(sql, { name: 'Alice' });
    const id2 = await insertPerson(sql, { name: 'Bob' });

    await touchPerson(sql, id2);
    await touchPerson(sql, id2);
    await touchPerson(sql, id1);

    const people = await getAllPeople(sql);
    expect(people[0].name).toBe('Bob');
    expect(people[1].name).toBe('Alice');
  });
});
