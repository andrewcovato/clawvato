/**
 * Tests for the Memory Retriever — token-budgeted context retrieval.
 *
 * Seeds a real Postgres database with known memories and verifies the
 * retriever returns the right context within budget.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestSql } from '../helpers/pg-test.js';
import { insertMemory, getMemory } from '../../src/memory/store.js';
import { retrieveContext, extractEntities } from '../../src/memory/retriever.js';

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

describe('retrieveContext', () => {
  it('returns empty context when no memories exist', async () => {
    const result = await retrieveContext(sql, 'hello world');

    expect(result.context).toBe('');
    expect(result.memoriesRetrieved).toBe(0);
    expect(result.tokensUsed).toBe(0);
  });

  it('retrieves memories about mentioned entities', async () => {
    await insertMemory(sql, {
      type: 'relationship',
      content: 'Jake Wilson is an Engineer at Acme (jake@corp.com)',
      source: 'test',
      importance: 7,
      entities: ['Jake Wilson'],
    });

    const result = await retrieveContext(sql, 'Can you schedule a meeting with Jake Wilson?');

    expect(result.memoriesRetrieved).toBeGreaterThanOrEqual(1);
    expect(result.context).toContain('Jake Wilson');
    expect(result.context).toContain('jake@corp.com');
    expect(result.context).toContain('Engineer');
  });

  it('retrieves preferences via semantic search', async () => {
    await insertMemory(sql, {
      type: 'preference',
      content: 'Andrew prefers meetings after 10am',
      source: 'test',
      importance: 8,
      confidence: 1.0,
    });

    // Preferences surface via FTS when query keywords overlap
    const result = await retrieveContext(sql, 'When does Andrew prefer meetings?');

    expect(result.memoriesRetrieved).toBeGreaterThanOrEqual(1);
    expect(result.context).toContain('meetings after 10am');
  });

  it('retrieves memories matching entity names', async () => {
    await insertMemory(sql, {
      type: 'fact',
      content: 'Jake is on the sales team',
      source: 'test',
      importance: 6,
      entities: ['Jake'],
    });

    const result = await retrieveContext(sql, 'What team is Jake on?');

    expect(result.context).toContain('sales team');
  });

  it('retrieves facts via keyword search', async () => {
    await insertMemory(sql, {
      type: 'fact',
      content: 'The quarterly budget review happens every Friday',
      source: 'test',
      importance: 7,
    });

    const result = await retrieveContext(sql, 'When is the budget review?');

    expect(result.memoriesRetrieved).toBeGreaterThanOrEqual(1);
    expect(result.context).toContain('budget review');
  });

  it('respects token budget', async () => {
    // Insert many memories with common keywords
    for (let i = 0; i < 20; i++) {
      await insertMemory(sql, {
        type: 'fact',
        content: `Meeting update number ${i}: The quarterly budget review discussion covered important financial topics`,
        source: 'test',
        importance: 5,
      });
    }

    const result = await retrieveContext(sql, 'quarterly budget review meeting', { tokenBudget: 200 });

    // Should not exceed budget
    expect(result.tokensUsed).toBeLessThanOrEqual(200);
    // Should still retrieve some
    expect(result.memoriesRetrieved).toBeGreaterThan(0);
    // But not all 20
    expect(result.memoriesRetrieved).toBeLessThan(20);
  });

  it('touches retrieved memories (updates access tracking)', async () => {
    const id = await insertMemory(sql, {
      type: 'preference',
      content: 'Andrew prefers short meetings over long discussions',
      source: 'test',
      importance: 8,
    });

    await retrieveContext(sql, 'What does Andrew prefer about meetings?');

    const memory = await getMemory(sql, id);
    expect(memory!.access_count).toBeGreaterThanOrEqual(1);
  });

  it('includes decisions via semantic search', async () => {
    await insertMemory(sql, {
      type: 'decision',
      content: 'Andrew decided to use view-only sharing by default for all files',
      source: 'test',
      importance: 9,
      confidence: 1.0,
    });

    // Decisions surface via FTS when query keywords overlap
    const result = await retrieveContext(sql, 'What sharing default view-only decision?');

    expect(result.context).toContain('view-only');
  });

  it('formats context with ## Memory header', async () => {
    await insertMemory(sql, {
      type: 'preference',
      content: 'Andrew prefers concise emails over long ones',
      source: 'test',
      importance: 8,
    });

    const result = await retrieveContext(sql, 'What are Andrew preferences about emails?');

    expect(result.context).toMatch(/^## Memory/);
  });

  it('shows confidence for low-confidence memories', async () => {
    await insertMemory(sql, {
      type: 'fact',
      content: 'Jake might be switching teams',
      source: 'test',
      confidence: 0.5,
      entities: ['Jake'],
    });

    const result = await retrieveContext(sql, 'What is Jake doing?');

    expect(result.context).toContain('50% confident');
  });

  it('does not show confidence for high-confidence memories', async () => {
    await insertMemory(sql, {
      type: 'preference',
      content: 'Andrew prefers email',
      source: 'test',
      confidence: 0.95,
    });

    const result = await retrieveContext(sql, 'How should I contact Andrew?');

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
