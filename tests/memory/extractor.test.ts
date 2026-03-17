/**
 * Tests for the Memory Extractor.
 *
 * Tests the extraction pipeline, deduplication logic, and storage.
 * Mocks the Anthropic client so tests are free and fast.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import { initDb, closeDb } from '../../src/db/index.js';
import {
  extractFacts,
  storeExtractionResult,
  contentSimilarity,
  type ExtractionResult,
} from '../../src/memory/extractor.js';
import { getMemory, findMemoriesByType, findPersonByName, insertMemory } from '../../src/memory/store.js';
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
  it('extracts facts and people from a conversation', async () => {
    const client = createMockClient({
      facts: [
        { type: 'fact', content: 'Jake works on the finance team', confidence: 0.9, importance: 7, entities: ['Jake'] },
        { type: 'preference', content: 'Andrew prefers meetings after 10am', confidence: 1.0, importance: 8, entities: ['Andrew'] },
      ],
      people: [
        { name: 'Jake Wilson', role: 'Analyst', organization: 'Acme Corp', relationship: 'colleague' },
      ],
    });

    const result = await extractFacts(client, 'haiku', 'test conversation', 'test-source');

    expect(result.facts).toHaveLength(2);
    expect(result.facts[0].type).toBe('fact');
    expect(result.facts[0].content).toBe('Jake works on the finance team');
    expect(result.facts[0].confidence).toBe(0.9);
    expect(result.facts[0].importance).toBe(7);
    expect(result.facts[0].entities).toEqual(['Jake']);

    expect(result.people).toHaveLength(1);
    expect(result.people[0].name).toBe('Jake Wilson');
    expect(result.people[0].role).toBe('Analyst');
  });

  it('handles empty extraction', async () => {
    const client = createMockClient({ facts: [], people: [] });

    const result = await extractFacts(client, 'haiku', 'hello how are you', 'test');

    expect(result.facts).toHaveLength(0);
    expect(result.people).toHaveLength(0);
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
    expect(result.people).toHaveLength(0);
  });

  it('handles API error gracefully', async () => {
    const client = {
      messages: {
        create: vi.fn().mockRejectedValue(new Error('API error')),
      },
    } as any;

    const result = await extractFacts(client, 'haiku', 'test', 'test');

    expect(result.facts).toHaveLength(0);
    expect(result.people).toHaveLength(0);
  });

  it('clamps confidence and importance values', async () => {
    const client = createMockClient({
      facts: [
        { type: 'fact', content: 'Test', confidence: 1.5, importance: 15, entities: [] },
        { type: 'fact', content: 'Test 2', confidence: -0.5, importance: -3, entities: [] },
      ],
      people: [],
    });

    const result = await extractFacts(client, 'haiku', 'test', 'test');

    expect(result.facts[0].confidence).toBe(1.0);
    expect(result.facts[0].importance).toBe(10);
    expect(result.facts[1].confidence).toBe(0);
    expect(result.facts[1].importance).toBe(1);
  });

  it('filters invalid memory types', async () => {
    const client = createMockClient({
      facts: [
        { type: 'invalid_type', content: 'Bad type', confidence: 0.5, importance: 5, entities: [] },
        { type: 'fact', content: 'Good type', confidence: 0.5, importance: 5, entities: [] },
      ],
      people: [],
    });

    const result = await extractFacts(client, 'haiku', 'test', 'test');

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0].content).toBe('Good type');
  });

  it('strips markdown code fences from response', async () => {
    const client = {
      messages: {
        create: vi.fn().mockResolvedValue({
          content: [{
            type: 'text',
            text: '```json\n{"facts": [{"type": "fact", "content": "Test fact", "confidence": 0.8, "importance": 5, "entities": []}], "people": []}\n```',
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
  it('stores facts and people', async () => {
    const result: ExtractionResult = {
      facts: [
        { type: 'fact', content: 'Jake works in finance', confidence: 0.9, importance: 7, entities: ['Jake'] },
        { type: 'preference', content: 'Prefers morning meetings', confidence: 1.0, importance: 8, entities: [] },
      ],
      people: [
        { name: 'Jake Wilson', role: 'Analyst', relationship: 'colleague' },
      ],
    };

    const stored = await storeExtractionResult(db, result, 'test');

    expect(stored.memoriesStored).toBe(2);
    expect(stored.peopleStored).toBe(1);
    expect(stored.duplicatesSkipped).toBe(0);

    const facts = findMemoriesByType(db, 'fact');
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toBe('Jake works in finance');

    const person = findPersonByName(db, 'Jake Wilson');
    expect(person).not.toBeNull();
    expect(person!.role).toBe('Analyst');
  });

  it('skips duplicates with lower confidence', async () => {
    // Store initial fact
    insertMemory(db, {
      type: 'fact',
      content: 'Jake works on the finance team',
      source: 'old',
      confidence: 0.9,
      importance: 7,
    });

    // Try to store similar fact with lower confidence
    const result: ExtractionResult = {
      facts: [
        { type: 'fact', content: 'Jake works in the finance team', confidence: 0.7, importance: 6, entities: [] },
      ],
      people: [],
    };

    const stored = await storeExtractionResult(db, result, 'test');

    expect(stored.duplicatesSkipped).toBe(1);
    expect(stored.memoriesStored).toBe(0);
  });

  it('supersedes duplicates with higher confidence', async () => {
    // Store initial lower-confidence fact
    const oldId = insertMemory(db, {
      type: 'fact',
      content: 'Jake works on the finance team',
      source: 'old',
      confidence: 0.5,
      importance: 5,
    });

    // Store higher-confidence version
    const result: ExtractionResult = {
      facts: [
        { type: 'fact', content: 'Jake works on the finance team now', confidence: 1.0, importance: 8, entities: ['Jake'] },
      ],
      people: [],
    };

    const stored = await storeExtractionResult(db, result, 'test');

    expect(stored.memoriesStored).toBe(1);

    // Old memory should be superseded
    const old = getMemory(db, oldId);
    expect(old!.valid_until).not.toBeNull();
    expect(old!.superseded_by).not.toBeNull();
  });

  it('enriches existing people', async () => {
    // Create person with minimal info
    findPersonByName(db, 'Jake'); // doesn't exist yet
    storeExtractionResult(db, {
      facts: [],
      people: [{ name: 'Jake Wilson' }],
    }, 'test1');

    // Update with more info
    storeExtractionResult(db, {
      facts: [],
      people: [{ name: 'Jake Wilson', email: 'jake@corp.com', role: 'Manager' }],
    }, 'test2');

    const person = findPersonByName(db, 'Jake Wilson');
    expect(person!.email).toBe('jake@corp.com');
    expect(person!.role).toBe('Manager');
  });
});

describe('contentSimilarity', () => {
  it('returns 1.0 for identical strings', () => {
    const score = contentSimilarity('Jake works in finance', 'Jake works in finance');
    expect(score).toBe(1.0);
  });

  it('returns high score for near-duplicates', () => {
    const score = contentSimilarity(
      'Jake works on the finance team',
      'Jake is part of the finance team',
    );
    expect(score).toBeGreaterThan(0.5);
  });

  it('returns low score for unrelated strings', () => {
    const score = contentSimilarity(
      'Jake works on the finance team',
      'The weather is sunny today',
    );
    expect(score).toBeLessThan(0.3);
  });

  it('returns 0 for empty strings', () => {
    expect(contentSimilarity('', '')).toBe(0);
    expect(contentSimilarity('hello', '')).toBe(0);
  });
});
