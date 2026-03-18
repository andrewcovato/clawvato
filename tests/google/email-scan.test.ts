/**
 * Tests for email scan — delta detection and memory integration.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';
import { initDb, getDb, closeDb } from '../../src/db/index.js';
import { insertMemory } from '../../src/memory/store.js';
import {
  getThreadExtractionState,
  supersedeThreadMemories,
} from '../../src/google/email-scan.js';

describe('email scan', () => {
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

  describe('getThreadExtractionState', () => {
    it('returns null for unextracted thread', () => {
      const db = getDb();
      const state = getThreadExtractionState(db, 'thread_abc');
      expect(state).toBeNull();
    });

    it('returns message count and memory IDs for extracted thread', () => {
      const db = getDb();
      insertMemory(db, {
        type: 'commitment',
        content: 'Sarah will send the proposal by Friday',
        source: 'gmail:thread_abc:3',
        importance: 8,
        confidence: 0.8,
        entities: ['Sarah'],
      });
      insertMemory(db, {
        type: 'fact',
        content: 'Budget approved for Q2',
        source: 'gmail:thread_abc:3',
        importance: 5,
        confidence: 0.7,
        entities: [],
      });

      const state = getThreadExtractionState(db, 'thread_abc');
      expect(state).not.toBeNull();
      expect(state!.messageCount).toBe(3);
      expect(state!.memoryIds).toHaveLength(2);
    });

    it('ignores superseded memories', () => {
      const db = getDb();
      insertMemory(db, {
        type: 'commitment',
        content: 'Old fact from thread',
        source: 'gmail:thread_abc:2',
        importance: 5,
        confidence: 0.7,
      });
      // Supersede it (without FK — just mark valid_until)
      db.prepare(
        "UPDATE memories SET valid_until = datetime('now') WHERE source LIKE 'gmail:thread_abc:2'"
      ).run();

      // Insert current version
      insertMemory(db, {
        type: 'commitment',
        content: 'Updated fact from thread',
        source: 'gmail:thread_abc:4',
        importance: 6,
        confidence: 0.8,
      });

      const state = getThreadExtractionState(db, 'thread_abc');
      expect(state).not.toBeNull();
      expect(state!.messageCount).toBe(4);
      expect(state!.memoryIds).toHaveLength(1); // Only the current one
    });

    it('does not match other threads with similar IDs', () => {
      const db = getDb();
      insertMemory(db, {
        type: 'fact',
        content: 'Fact from different thread',
        source: 'gmail:thread_xyz:2',
        importance: 5,
        confidence: 0.7,
      });

      const state = getThreadExtractionState(db, 'thread_abc');
      expect(state).toBeNull();
    });
  });

  describe('supersedeThreadMemories', () => {
    it('supersedes all current memories for a thread', () => {
      const db = getDb();
      insertMemory(db, {
        type: 'commitment',
        content: 'Old commitment',
        source: 'gmail:thread_abc:2',
        importance: 8,
        confidence: 0.8,
      });
      insertMemory(db, {
        type: 'fact',
        content: 'Old fact',
        source: 'gmail:thread_abc:2',
        importance: 5,
        confidence: 0.7,
      });

      const superseded = supersedeThreadMemories(db, 'thread_abc');
      expect(superseded).toHaveLength(2);

      // Verify they're marked as superseded
      const remaining = db.prepare(
        "SELECT id FROM memories WHERE source LIKE 'gmail:thread_abc:%' AND valid_until IS NULL"
      ).all();
      expect(remaining).toHaveLength(0);
    });

    it('does not affect other threads', () => {
      const db = getDb();
      insertMemory(db, {
        type: 'fact',
        content: 'Fact from thread ABC',
        source: 'gmail:thread_abc:2',
        importance: 5,
        confidence: 0.7,
      });
      insertMemory(db, {
        type: 'fact',
        content: 'Fact from thread XYZ',
        source: 'gmail:thread_xyz:3',
        importance: 5,
        confidence: 0.7,
      });

      supersedeThreadMemories(db, 'thread_abc');

      // thread_xyz should be unaffected
      const state = getThreadExtractionState(db, 'thread_xyz');
      expect(state).not.toBeNull();
      expect(state!.memoryIds).toHaveLength(1);
    });

    it('returns empty array for thread with no memories', () => {
      const db = getDb();
      const superseded = supersedeThreadMemories(db, 'nonexistent');
      expect(superseded).toHaveLength(0);
    });
  });

  describe('delta detection', () => {
    it('detects thread growth (new messages)', () => {
      const db = getDb();
      // Thread extracted at 2 messages
      insertMemory(db, {
        type: 'commitment',
        content: 'Sarah will send proposal',
        source: 'gmail:thread_abc:2',
        importance: 8,
        confidence: 0.8,
      });

      const state = getThreadExtractionState(db, 'thread_abc');
      expect(state!.messageCount).toBe(2);

      // Simulate thread growing to 4 messages
      const currentMessageCount = 4;
      const needsReExtraction = currentMessageCount > state!.messageCount;
      expect(needsReExtraction).toBe(true);
    });

    it('skips thread at same message count', () => {
      const db = getDb();
      insertMemory(db, {
        type: 'fact',
        content: 'Some fact',
        source: 'gmail:thread_abc:3',
        importance: 5,
        confidence: 0.7,
      });

      const state = getThreadExtractionState(db, 'thread_abc');
      const currentMessageCount = 3;
      const needsReExtraction = currentMessageCount > state!.messageCount;
      expect(needsReExtraction).toBe(false);
    });
  });
});
