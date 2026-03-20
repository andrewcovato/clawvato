import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestSql } from '../helpers/pg-test.js';
import { computePatternHash, recordOccurrence, isGraduated, getGraduatedPatterns } from '../../src/training-wheels/graduation.js';

describe('Graduation Engine', () => {
  let sql: TestSql;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ sql, cleanup } = await createTestDb());
  });

  afterEach(async () => {
    await cleanup();
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
    it('creates a new pattern on first occurrence', async () => {
      const { graduated, pattern } = await recordOccurrence(
        sql, 'send_email', 'Send email to internal user', { scope: 'internal' }, 'approved'
      );

      expect(graduated).toBe(false);
      expect(pattern.action_type).toBe('send_email');
      expect(pattern.total_approvals).toBe(1);
      expect(pattern.total_occurrences).toBe(1);
    });

    it('increments counts on subsequent occurrences', async () => {
      for (let i = 0; i < 3; i++) {
        await recordOccurrence(sql, 'search', 'Search messages', {}, 'approved');
      }
      await recordOccurrence(sql, 'search', 'Search messages', {}, 'rejected');

      const { pattern } = await recordOccurrence(sql, 'search', 'Search messages', {}, 'approved');
      expect(pattern.total_occurrences).toBe(5);
      expect(pattern.total_approvals).toBe(4);
      expect(pattern.total_rejections).toBe(1);
    });

    it('does not graduate before threshold', async () => {
      for (let i = 0; i < 9; i++) {
        const { graduated } = await recordOccurrence(
          sql, 'list_events', 'List calendar events', {}, 'approved'
        );
        expect(graduated).toBe(false);
      }
    });

    it('graduates after 10 approvals with clean record', async () => {
      for (let i = 0; i < 9; i++) {
        await recordOccurrence(sql, 'list_events', 'List calendar events', {}, 'approved');
      }
      const { graduated } = await recordOccurrence(
        sql, 'list_events', 'List calendar events', {}, 'approved'
      );
      expect(graduated).toBe(true);
    });

    it('does not graduate non-graduatable actions', async () => {
      for (let i = 0; i < 15; i++) {
        const { graduated } = await recordOccurrence(
          sql, 'delete_file', 'Delete a file', {}, 'approved', true
        );
        expect(graduated).toBe(false);
      }
    });

    it('does not graduate with high rejection rate', async () => {
      // 10 approvals but 2 rejections (>5%)
      for (let i = 0; i < 10; i++) {
        await recordOccurrence(sql, 'post_msg', 'Post message', {}, 'approved');
      }
      await recordOccurrence(sql, 'post_msg', 'Post message', {}, 'rejected');
      const { graduated } = await recordOccurrence(
        sql, 'post_msg', 'Post message', {}, 'rejected'
      );
      expect(graduated).toBe(false);
    });
  });

  describe('isGraduated', () => {
    it('returns false for unknown patterns', async () => {
      expect(await isGraduated(sql, 'unknown_action')).toBe(false);
    });

    it('returns true for graduated patterns', async () => {
      for (let i = 0; i < 10; i++) {
        await recordOccurrence(sql, 'search_files', 'Search files', {}, 'approved');
      }
      expect(await isGraduated(sql, 'search_files')).toBe(true);
    });
  });

  describe('getGraduatedPatterns', () => {
    it('returns empty array when none graduated', async () => {
      expect(await getGraduatedPatterns(sql)).toHaveLength(0);
    });

    it('returns graduated patterns', async () => {
      for (let i = 0; i < 10; i++) {
        await recordOccurrence(sql, 'list_events', 'List events', {}, 'approved');
      }
      const graduated = await getGraduatedPatterns(sql);
      expect(graduated).toHaveLength(1);
      expect(graduated[0].action_type).toBe('list_events');
    });
  });
});
