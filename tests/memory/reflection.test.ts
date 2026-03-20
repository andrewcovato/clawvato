/**
 * Tests for the Reflection system — synthesizes insights from accumulated memories.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestSql } from '../helpers/pg-test.js';
import { insertMemory, findMemoriesByType } from '../../src/memory/store.js';
import { maybeReflect } from '../../src/memory/reflection.js';

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

function createMockClient(responseJson: unknown[]) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(responseJson) }],
      }),
    },
  } as any;
}

describe('maybeReflect', () => {
  it('does not trigger when no memories exist', async () => {
    const client = createMockClient([]);
    const result = await maybeReflect(sql, client, 'haiku');

    expect(result.reflected).toBe(false);
    expect(result.insightsGenerated).toBe(0);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('does not trigger when cumulative importance is below threshold', async () => {
    // Insert a few low-importance memories (total < 50)
    for (let i = 0; i < 5; i++) {
      await insertMemory(sql, { type: 'fact', content: `Low importance fact ${i}`, source: 'test', importance: 3 });
    }
    // Total importance = 15, well below 50

    const client = createMockClient([]);
    const result = await maybeReflect(sql, client, 'haiku');

    expect(result.reflected).toBe(false);
    expect(client.messages.create).not.toHaveBeenCalled();
  });

  it('triggers when cumulative importance exceeds threshold', async () => {
    // Insert enough high-importance memories to exceed 50
    for (let i = 0; i < 7; i++) {
      await insertMemory(sql, { type: 'fact', content: `Important fact ${i}`, source: 'test', importance: 8 });
    }
    // Total importance = 56, above threshold of 50

    const client = createMockClient([
      { content: 'Owner focuses heavily on client management and pipeline optimization', importance: 8 },
      { content: 'There is a pattern of strategic pivots driven by procurement delays', importance: 7 },
    ]);

    const result = await maybeReflect(sql, client, 'haiku');

    expect(result.reflected).toBe(true);
    expect(result.insightsGenerated).toBe(2);
    expect(client.messages.create).toHaveBeenCalledOnce();

    // Reflections should be stored in the DB
    const reflections = await findMemoriesByType(sql, 'reflection');
    expect(reflections).toHaveLength(2);
    expect(reflections[0].content).toContain('client management');
  });

  it('does not trigger again immediately after reflecting', async () => {
    // First: trigger a reflection
    for (let i = 0; i < 7; i++) {
      await insertMemory(sql, { type: 'fact', content: `Fact ${i}`, source: 'test', importance: 8 });
    }

    const client = createMockClient([
      { content: 'Test insight', importance: 7 },
    ]);

    await maybeReflect(sql, client, 'haiku');

    // Second: add a few more memories (not enough to re-trigger)
    await insertMemory(sql, { type: 'fact', content: 'New fact', source: 'test', importance: 5 });

    const result = await maybeReflect(sql, client, 'haiku');

    expect(result.reflected).toBe(false);
    // Only the first call should have called the API
    expect(client.messages.create).toHaveBeenCalledOnce();
  });

  it('handles malformed API response gracefully', async () => {
    for (let i = 0; i < 7; i++) {
      await insertMemory(sql, { type: 'fact', content: `Fact ${i}`, source: 'test', importance: 8 });
    }

    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'not json' }],
        }),
      },
    } as any;

    const result = await maybeReflect(sql, client, 'haiku');

    // Should still mark as reflected (to prevent infinite retries) but no insights
    expect(result.reflected).toBe(true);
    expect(result.insightsGenerated).toBe(0);
  });

  it('handles empty agent_state table gracefully', async () => {
    // Insert enough memories to trigger reflection
    for (let i = 0; i < 7; i++) {
      await insertMemory(sql, { type: 'fact', content: `Fact ${i}`, source: 'test', importance: 8 });
    }

    const client = createMockClient([{ content: 'Test insight', importance: 7 }]);
    // Should work even with empty agent_state table
    const result = await maybeReflect(sql, client, 'haiku');
    expect(result.reflected).toBe(true);
  });

  it('stores reflections with correct metadata', async () => {
    for (let i = 0; i < 7; i++) {
      await insertMemory(sql, { type: 'fact', content: `Fact ${i}`, source: 'test', importance: 8 });
    }

    const client = createMockClient([
      { content: 'Key insight about workflow patterns', importance: 9 },
    ]);

    await maybeReflect(sql, client, 'haiku');

    const reflections = await findMemoriesByType(sql, 'reflection');
    expect(reflections).toHaveLength(1);
    expect(reflections[0].type).toBe('reflection');
    expect(reflections[0].confidence).toBe(0.8);
    expect(reflections[0].importance).toBe(9);
    expect(reflections[0].source).toMatch(/^reflection:/);
  });
});
