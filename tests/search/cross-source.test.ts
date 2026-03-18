/**
 * Tests for cross-source search — adapter logic, scoring, and assembly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import { initDb, getDb, closeDb } from '../../src/db/index.js';
import { insertMemory } from '../../src/memory/store.js';
import { MemoryAdapter } from '../../src/search/adapters.js';

describe('cross-source search', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clawvato-test-'));
    loadConfig({ dataDir: tmpDir });
    initDb();
  });

  afterEach(() => {
    closeDb();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('MemoryAdapter', () => {
    it('searches memories with FTS query', async () => {
      const db = getDb();
      insertMemory(db, {
        type: 'commitment',
        content: 'Sarah will send the Acme proposal by Friday',
        source: 'gmail:thread123:3',
        importance: 8,
        confidence: 0.8,
        entities: ['Sarah'],
      });
      insertMemory(db, {
        type: 'fact',
        content: 'Budget approved for Q2 project',
        source: 'slack:C123:ts123',
        importance: 5,
        confidence: 0.7,
        entities: [],
      });

      const adapter = new MemoryAdapter(db);
      const results = await adapter.search({ ftsQuery: 'Acme OR proposal' }, 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].source).toBe('memory');
      expect(results[0].snippet).toContain('Acme proposal');
      expect(results[0].memoryHit).toBe(true);
    });

    it('filters by source prefix', async () => {
      const db = getDb();
      insertMemory(db, {
        type: 'commitment',
        content: 'Email commitment about proposal',
        source: 'gmail:thread123:3',
        importance: 8,
        confidence: 0.8,
      });
      insertMemory(db, {
        type: 'commitment',
        content: 'Meeting commitment about proposal',
        source: 'fireflies:meeting456:2026-03-15',
        importance: 8,
        confidence: 0.8,
      });

      const adapter = new MemoryAdapter(db);
      const gmailOnly = await adapter.search({
        ftsQuery: 'commitment OR proposal',
        sourcePrefix: 'gmail',
      }, 10);

      // Should find at least the gmail one
      const gmailResults = gmailOnly.filter(r => r.title.includes('gmail'));
      expect(gmailResults.length).toBeGreaterThan(0);
    });

    it('returns empty for no matches', async () => {
      const db = getDb();
      const adapter = new MemoryAdapter(db);
      const results = await adapter.search({ ftsQuery: 'nonexistent_xyz_query' }, 10);
      expect(results).toHaveLength(0);
    });

    it('handles empty query gracefully', async () => {
      const db = getDb();
      const adapter = new MemoryAdapter(db);
      const results = await adapter.search({}, 10);
      expect(results).toHaveLength(0);
    });
  });

  describe('SearchHit structure', () => {
    it('memory adapter returns correct hit structure', async () => {
      const db = getDb();
      insertMemory(db, {
        type: 'decision',
        content: 'Decided to go with vendor X for the cloud migration',
        source: 'fireflies:meeting789:2026-03-10',
        importance: 7,
        confidence: 0.9,
        entities: ['vendor X'],
      });

      const adapter = new MemoryAdapter(db);
      const results = await adapter.search({ ftsQuery: 'vendor OR cloud OR migration' }, 10);

      expect(results.length).toBeGreaterThan(0);
      const hit = results[0];
      expect(hit).toHaveProperty('id');
      expect(hit).toHaveProperty('source', 'memory');
      expect(hit).toHaveProperty('title');
      expect(hit).toHaveProperty('snippet');
      expect(hit).toHaveProperty('date');
      expect(hit).toHaveProperty('participants');
      expect(hit).toHaveProperty('memoryHit', true);
    });
  });
});
