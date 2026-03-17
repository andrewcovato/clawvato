/**
 * Tests for the Memory Retriever — token-budgeted context retrieval.
 *
 * Seeds a real SQLite database with known memories and verifies the
 * retriever returns the right context within budget.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import { initDb, closeDb } from '../../src/db/index.js';
import { insertMemory, insertPerson, getMemory } from '../../src/memory/store.js';
import { retrieveContext, extractEntities } from '../../src/memory/retriever.js';
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

describe('retrieveContext', () => {
  it('returns empty context when no memories exist', () => {
    const result = retrieveContext(db, 'hello world');

    expect(result.context).toBe('');
    expect(result.memoriesRetrieved).toBe(0);
    expect(result.peopleRetrieved).toBe(0);
    expect(result.tokensUsed).toBe(0);
  });

  it('retrieves people mentioned in the message', () => {
    insertPerson(db, {
      name: 'Jake Wilson',
      email: 'jake@corp.com',
      role: 'Engineer',
      organization: 'Acme',
    });

    const result = retrieveContext(db, 'Can you schedule a meeting with Jake Wilson?');

    expect(result.peopleRetrieved).toBe(1);
    expect(result.context).toContain('Jake Wilson');
    expect(result.context).toContain('jake@corp.com');
    expect(result.context).toContain('Engineer');
  });

  it('retrieves preferences', () => {
    insertMemory(db, {
      type: 'preference',
      content: 'Andrew prefers meetings after 10am',
      source: 'test',
      importance: 8,
      confidence: 1.0,
    });

    const result = retrieveContext(db, 'Schedule something for tomorrow');

    expect(result.memoriesRetrieved).toBeGreaterThanOrEqual(1);
    expect(result.context).toContain('meetings after 10am');
  });

  it('retrieves memories matching entity names', () => {
    insertMemory(db, {
      type: 'fact',
      content: 'Jake is on the sales team',
      source: 'test',
      importance: 6,
      entities: ['Jake'],
    });

    const result = retrieveContext(db, 'What team is Jake on?');

    expect(result.context).toContain('sales team');
  });

  it('retrieves facts via keyword search', () => {
    insertMemory(db, {
      type: 'fact',
      content: 'The quarterly budget review happens every Friday',
      source: 'test',
      importance: 7,
    });

    const result = retrieveContext(db, 'When is the budget review?');

    expect(result.memoriesRetrieved).toBeGreaterThanOrEqual(1);
    expect(result.context).toContain('budget review');
  });

  it('respects token budget', () => {
    // Insert many memories
    for (let i = 0; i < 20; i++) {
      insertMemory(db, {
        type: 'preference',
        content: `Preference number ${i}: This is a moderately long preference statement that takes up some tokens`,
        source: 'test',
        importance: 5,
      });
    }

    const result = retrieveContext(db, 'What are my preferences?', { tokenBudget: 200 });

    // Should not exceed budget
    expect(result.tokensUsed).toBeLessThanOrEqual(200);
    // Should still retrieve some
    expect(result.memoriesRetrieved).toBeGreaterThan(0);
    // But not all 20
    expect(result.memoriesRetrieved).toBeLessThan(20);
  });

  it('touches retrieved memories (updates access tracking)', () => {
    const id = insertMemory(db, {
      type: 'preference',
      content: 'Andrew prefers short meetings',
      source: 'test',
      importance: 8,
    });

    retrieveContext(db, 'Schedule a meeting');

    const memory = getMemory(db, id);
    expect(memory!.access_count).toBeGreaterThanOrEqual(1);
  });

  it('includes decisions in context', () => {
    insertMemory(db, {
      type: 'decision',
      content: 'Andrew decided to use view-only sharing by default',
      source: 'test',
      importance: 9,
      confidence: 1.0,
    });

    const result = retrieveContext(db, 'Share this file with Jake');

    expect(result.context).toContain('view-only');
  });

  it('formats context with ## Memory header', () => {
    insertMemory(db, {
      type: 'preference',
      content: 'Andrew prefers concise emails',
      source: 'test',
      importance: 8,
    });

    const result = retrieveContext(db, 'Draft an email');

    expect(result.context).toMatch(/^## Memory/);
  });

  it('shows confidence for low-confidence memories', () => {
    insertMemory(db, {
      type: 'fact',
      content: 'Jake might be switching teams',
      source: 'test',
      confidence: 0.5,
      entities: ['Jake'],
    });

    const result = retrieveContext(db, 'What is Jake doing?');

    expect(result.context).toContain('50% confident');
  });

  it('does not show confidence for high-confidence memories', () => {
    insertMemory(db, {
      type: 'preference',
      content: 'Andrew prefers email',
      source: 'test',
      confidence: 0.95,
    });

    const result = retrieveContext(db, 'How should I contact Andrew?');

    expect(result.context).not.toContain('confident');
  });
});

describe('extractEntities', () => {
  it('extracts capitalized names', () => {
    const { names } = extractEntities('Can you schedule a meeting with Jake Wilson?');
    expect(names).toContain('Jake Wilson');
  });

  it('extracts single names', () => {
    const { names } = extractEntities('Ask Sarah about the project');
    expect(names).toContain('Sarah');
  });

  it('ignores common words', () => {
    const { names } = extractEntities('Please check the Monday meeting');
    expect(names).not.toContain('Monday');
    expect(names).not.toContain('Please');
  });

  it('extracts keywords for search', () => {
    const { keywords } = extractEntities('When is the quarterly budget review?');
    expect(keywords).toContain('quarterly');
    expect(keywords).toContain('budget');
    expect(keywords).toContain('review');
  });

  it('filters stopwords from keywords', () => {
    const { keywords } = extractEntities('What is the status of the project?');
    expect(keywords).not.toContain('what');
    expect(keywords).not.toContain('the');
    expect(keywords).toContain('status');
    expect(keywords).toContain('project');
  });

  it('deduplicates names and keywords', () => {
    const { names, keywords } = extractEntities('Jake and Jake went to the meeting meeting');
    const jakeCount = names.filter(n => n === 'Jake').length;
    expect(jakeCount).toBeLessThanOrEqual(1);
    const meetingCount = keywords.filter(k => k === 'meeting').length;
    expect(meetingCount).toBeLessThanOrEqual(1);
  });
});
