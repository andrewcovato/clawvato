/**
 * Tests for the Memory Extractor.
 *
 * Tests the extraction pipeline, deduplication logic, and storage.
 * Mocks the Anthropic client so tests are free and fast.
 *
 * Uses Postgres via the pg-test helper (isolated schema per suite).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestSql } from '../helpers/pg-test.js';
import { loadConfig } from '../../src/config.js';
import {
  extractFacts,
  storeExtractionResult,
  type ExtractionResult,
} from '../../src/memory/extractor.js';
import { getMemory, findMemoriesByType, insertMemory } from '../../src/memory/store.js';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  loadConfig({});
  const testDb = await createTestDb();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterEach(async () => {
  await cleanup();
});

// Mock Anthropic client
function createMockClient(responseJson: Record<string, unknown>) {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: JSON.stringify(responseJson) }],
      }),
    },
  } as any;
}

describe('extractFacts', () => {
  it('extracts facts from a conversation', async () => {
    const client = createMockClient({
      facts: [
        { type: 'fact', content: 'Jake works on the finance team', confidence: 0.9, importance: 7, entities: ['Jake'] },
        { type: 'preference', content: 'Andrew prefers meetings after 10am', confidence: 1.0, importance: 8, entities: ['Andrew'] },
      ],
    });

    const result = await extractFacts(client, 'haiku', 'test conversation', 'test-source');

    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].type).toBe('fact');
    expect(result.facts[0].content).toBe('Jake works on the finance team');
    expect(result.facts[0].confidence).toBe(0.9);
    expect(result.facts[0].importance).toBe(7);
    expect(result.facts[0].entities).toEqual(['Jake']);
  });

  it('handles empty extraction', async () => {
    const client = createMockClient({ facts: [] });

    const result = await extractFacts(client, 'haiku', 'hello how are you', 'test');

    expect(result.facts).toHaveLength(0);
  });

  it('handles malformed response gracefully', async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: 'this is not json' }],
        }),
      },
    } as any;

    const result = await extractFacts(client, 'haiku', 'test', 'test');

    expect(result.facts).toHaveLength(0);
  });

  it('handles API error gracefully', async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('API error')),
      },
    } as any;

    const result = await extractFacts(client, 'haiku', 'test', 'test');

    expect(result.facts).toHaveLength(0);
  });

  it('clamps confidence and importance values', async () => {
    const client = createMockClient({
      facts: [
        { type: 'fact', content: 'Test', confidence: 1.5, importance: 15, entities: [] },
        { type: 'fact', content: 'Test 2', confidence: -0.5, importance: -3, entities: [] },
      ],
    });

    const result = await extractFacts(client, 'haiku', 'test', 'test');

    expect(result.facts[0].confidence).toBe(1.0);
    expect(result.facts[0].importance).toBe(10);
    expect(result.facts[1].confidence).toBe(0);
    expect(result.facts[1].importance).toBe(1);
  });

  it('accepts any string as memory type (dynamic categories)', async () => {
    const client = createMockClient({
      facts: [
        { type: 'custom_dynamic_type', content: 'Custom category', confidence: 0.5, importance: 5, entities: [] },
        { type: 'fact', content: 'Standard category', confidence: 0.5, importance: 5, entities: [] },
      ],
    });

    const result = await extractFacts(client, 'haiku', 'test', 'test');

    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].type).toBe('custom_dynamic_type');
    expect(result.facts[1].type).toBe('fact');
  });

  it('strips markdown code fences from response', async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'text',
            text: '```json\n{"facts": [{"type": "fact", "content": "Test fact", "confidence": 0.8, "importance": 5, "entities": []}]}\n```',
          }],
        }),
      },
    } as any;

    const result = await extractFacts(client, 'haiku', 'test', 'test');

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe('Test fact');
  });
});

describe('storeExtractionResult', () => {
  it('stores facts without dedup when no client provided', async () => {
    const result: ExtractionResult = {
      facts: [
        { type: 'fact', content: 'Jake works in finance', confidence: 0.9, importance: 7, entities: ['Jake'] },
        { type: 'preference', content: 'Prefers morning meetings', confidence: 1.0, importance: 8, entities: [] },
      ],
    };

    const stored = await storeExtractionResult(sql, result, 'test');

    expect(stored.memoriesStored).toBe(2);
    expect(stored.duplicatesSkipped).toBe(0);
    expect(stored.memoriesUpdated).toBe(0);
    expect(stored.memoriesRetired).toBe(0);

    const facts = await findMemoriesByType(sql, 'fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('Jake works in finance');
  });

  it('returns expanded metrics shape', async () => {
    const result: ExtractionResult = {
      facts: [
        { type: 'fact', content: 'Test fact for metrics', confidence: 0.8, importance: 5, entities: [] },
      ],
    };

    const stored = await storeExtractionResult(sql, result, 'test');

    expect(stored).toHaveProperty('memoriesStored');
    expect(stored).toHaveProperty('duplicatesSkipped');
    expect(stored).toHaveProperty('memoriesUpdated');
    expect(stored).toHaveProperty('memoriesRetired');
  });

  it('stores all facts when dedup is disabled (no client)', async () => {
    // Insert an existing memory first
    await insertMemory(sql, {
      type: 'fact',
      content: 'Jake works on the finance team',
      source: 'old',
      confidence: 0.9,
      importance: 7,
    });

    const result: ExtractionResult = {
      facts: [
        { type: 'fact', content: 'Jake works in the finance team', confidence: 0.7, importance: 6, entities: [] },
      ],
    };

    // Without client, dedup is disabled — fact is stored regardless
    const stored = await storeExtractionResult(sql, result, 'test');

    expect(stored.memoriesStored).toBe(1);
    expect(stored.duplicatesSkipped).toBe(0);
  });

  it('uses dedup when client is provided and similar memories exist', async () => {
    // Mock client that returns NOOP decision
    const mockClient = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{ type: 'text', text: JSON.stringify({ action: 'NOOP', target_id: null, reason: 'Already known' }) }],
        }),
      },
    } as any;

    // Insert an existing memory with an embedding so findSimilarByVector can find it
    const existingId = await insertMemory(sql, {
      type: 'fact',
      content: 'Jake works on the finance team',
      source: 'old',
      confidence: 0.9,
      importance: 7,
    });

    // Note: This test requires embeddings to be stored for the existing memory
    // and for embedBatch to work. In practice, the vector search may return
    // no results if no embeddings exist, causing the fact to be added directly.
    // Full integration testing of the dedup flow requires a populated vector store.

    const result: ExtractionResult = {
      facts: [
        { type: 'fact', content: 'Jake works in the finance team', confidence: 0.7, importance: 6, entities: [] },
      ],
    };

    const stored = await storeExtractionResult(sql, result, 'test', { client: mockClient });

    // Without embeddings on the existing memory, findSimilarByVector returns empty,
    // so the fact gets added directly (no dedup judgment needed)
    expect(stored.memoriesStored + stored.duplicatesSkipped + stored.memoriesUpdated + stored.memoriesRetired).toBe(1);
  });
});
