import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { computePatternHash, recordOccurrence, isGraduated, getGraduatedPatterns } from '../../src/training-wheels/graduation.js';

describe('Graduation Engine', () => {
  let tmpDir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clawvato-grad-test-'));
    const dbPath = join(tmpDir, 'test.db');
    db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');

    // Load schema
    const schemaPath = join(process.cwd(), 'src', 'db', 'schema.sql');
    let schema = readFileSync(schemaPath, 'utf-8');
    schema = schema.replace(/^PRAGMA .+;$/gm, '');
    db.exec(schema);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('computePatternHash', () => {
    it('produces deterministic hashes', () => {
      const h1 = computePatternHash('send_email', { scope: 'internal' });
      const h2 = computePatternHash('send_email', { scope: 'internal' });
      expect(h1).toBe(h2);
    });

    it('produces different hashes for different action types', () => {
      const h1 = computePatternHash('send_email');
      const h2 = computePatternHash('search_messages');
      expect(h1).not.toBe(h2);
    });

    it('produces different hashes for different key params', () => {
      const h1 = computePatternHash('send_email', { scope: 'internal' });
      const h2 = computePatternHash('send_email', { scope: 'external' });
      expect(h1).not.toBe(h2);
    });

    it('is order-independent for params', () => {
      const h1 = computePatternHash('send_email', { scope: 'internal', to: 'user' });
      const h2 = computePatternHash('send_email', { to: 'user', scope: 'internal' });
      expect(h1).toBe(h2);
    });
  });

  describe('recordOccurrence', () => {
    it('creates a new pattern on first occurrence', () => {
      const { graduated, pattern } = recordOccurrence(
        db, 'send_email', 'Send email to internal user', { scope: 'internal' }, 'approved'
      );

      expect(graduated).toBe(false);
      expect(pattern.action_type).toBe('send_email');
      expect(pattern.total_approvals).toBe(1);
      expect(pattern.total_occurrences).toBe(1);
    });

    it('increments counts on subsequent occurrences', () => {
      for (let i = 0; i < 3; i++) {
        recordOccurrence(db, 'search', 'Search messages', {}, 'approved');
      }
      recordOccurrence(db, 'search', 'Search messages', {}, 'rejected');

      const { pattern } = recordOccurrence(db, 'search', 'Search messages', {}, 'approved');
      expect(pattern.total_occurrences).toBe(5);
      expect(pattern.total_approvals).toBe(4);
      expect(pattern.total_rejections).toBe(1);
    });

    it('does not graduate before threshold', () => {
      for (let i = 0; i < 9; i++) {
        const { graduated } = recordOccurrence(
          db, 'list_events', 'List calendar events', {}, 'approved'
        );
        expect(graduated).toBe(false);
      }
    });

    it('graduates after 10 approvals with clean record', () => {
      for (let i = 0; i < 9; i++) {
        recordOccurrence(db, 'list_events', 'List calendar events', {}, 'approved');
      }
      const { graduated } = recordOccurrence(
        db, 'list_events', 'List calendar events', {}, 'approved'
      );
      expect(graduated).toBe(true);
    });

    it('does not graduate non-graduatable actions', () => {
      for (let i = 0; i < 15; i++) {
        const { graduated } = recordOccurrence(
          db, 'delete_file', 'Delete a file', {}, 'approved', true
        );
        expect(graduated).toBe(false);
      }
    });

    it('does not graduate with high rejection rate', () => {
      // 10 approvals but 2 rejections (>5%)
      for (let i = 0; i < 10; i++) {
        recordOccurrence(db, 'post_msg', 'Post message', {}, 'approved');
      }
      recordOccurrence(db, 'post_msg', 'Post message', {}, 'rejected');
      const { graduated } = recordOccurrence(
        db, 'post_msg', 'Post message', {}, 'rejected'
      );
      expect(graduated).toBe(false);
    });
  });

  describe('isGraduated', () => {
    it('returns false for unknown patterns', () => {
      expect(isGraduated(db, 'unknown_action')).toBe(false);
    });

    it('returns true for graduated patterns', () => {
      for (let i = 0; i < 10; i++) {
        recordOccurrence(db, 'search_files', 'Search files', {}, 'approved');
      }
      expect(isGraduated(db, 'search_files')).toBe(true);
    });
  });

  describe('getGraduatedPatterns', () => {
    it('returns empty array when none graduated', () => {
      expect(getGraduatedPatterns(db)).toHaveLength(0);
    });

    it('returns graduated patterns', () => {
      for (let i = 0; i < 10; i++) {
        recordOccurrence(db, 'list_events', 'List events', {}, 'approved');
      }
      const graduated = getGraduatedPatterns(db);
      expect(graduated).toHaveLength(1);
      expect(graduated[0].action_type).toBe('list_events');
    });
  });
});
