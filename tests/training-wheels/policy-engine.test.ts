import { describe, it, expect } from 'vitest';
import { evaluatePolicy, categorizeAction } from '../../src/training-wheels/policy-engine.js';

describe('categorizeAction', () => {
  it('categorizes read actions', () => {
    expect(categorizeAction('search_messages')).toBe('read');
    expect(categorizeAction('list_events')).toBe('read');
    expect(categorizeAction('get_file')).toBe('read');
    expect(categorizeAction('find_free_time')).toBe('read');
    expect(categorizeAction('check_availability')).toBe('read');
  });

  it('categorizes destructive actions', () => {
    expect(categorizeAction('delete_file')).toBe('destructive');
    expect(categorizeAction('remove_permission')).toBe('destructive');
    expect(categorizeAction('revoke_access')).toBe('destructive');
  });

  it('categorizes outbound actions', () => {
    expect(categorizeAction('send_email')).toBe('outbound');
    expect(categorizeAction('post_message')).toBe('outbound');
    expect(categorizeAction('reply_to_thread')).toBe('outbound');
  });

  it('defaults to write for unknown actions', () => {
    expect(categorizeAction('update_event')).toBe('write');
    expect(categorizeAction('create_file')).toBe('write');
  });
});

describe('evaluatePolicy', () => {
  describe('trust level 0', () => {
    it('requires confirmation for everything', () => {
      expect(evaluatePolicy('search_messages', false, 0).autoApproved).toBe(false);
      expect(evaluatePolicy('send_email', false, 0).autoApproved).toBe(false);
      expect(evaluatePolicy('update_event', false, 0).autoApproved).toBe(false);
    });
  });

  describe('trust level 1', () => {
    it('auto-approves read actions', () => {
      expect(evaluatePolicy('search_messages', false, 1).autoApproved).toBe(true);
      expect(evaluatePolicy('list_events', false, 1).autoApproved).toBe(true);
      expect(evaluatePolicy('get_file', false, 1).autoApproved).toBe(true);
    });

    it('requires confirmation for writes', () => {
      expect(evaluatePolicy('send_email', false, 1).autoApproved).toBe(false);
      expect(evaluatePolicy('update_event', false, 1).autoApproved).toBe(false);
    });

    it('requires confirmation for destructive actions', () => {
      expect(evaluatePolicy('delete_file', false, 1).autoApproved).toBe(false);
    });
  });

  describe('trust level 2', () => {
    it('auto-approves graduated patterns', () => {
      expect(evaluatePolicy('send_email', true, 2).autoApproved).toBe(true);
    });

    it('requires confirmation for non-graduated patterns', () => {
      expect(evaluatePolicy('send_email', false, 2).autoApproved).toBe(false);
    });

    it('still requires confirmation for destructive actions even if graduated', () => {
      expect(evaluatePolicy('delete_file', true, 2).autoApproved).toBe(false);
    });
  });

  describe('trust level 3', () => {
    it('auto-approves most actions', () => {
      expect(evaluatePolicy('send_email', false, 3).autoApproved).toBe(true);
      expect(evaluatePolicy('update_event', false, 3).autoApproved).toBe(true);
      expect(evaluatePolicy('create_file', false, 3).autoApproved).toBe(true);
    });

    it('still requires confirmation for destructive actions', () => {
      expect(evaluatePolicy('delete_file', false, 3).autoApproved).toBe(false);
      expect(evaluatePolicy('remove_permission', false, 3).autoApproved).toBe(false);
    });
  });

  describe('confirmation types', () => {
    it('uses block_kit for destructive actions', () => {
      const result = evaluatePolicy('delete_file', false, 0);
      expect(result.confirmationType).toBe('block_kit');
    });

    it('uses block_kit for outbound actions', () => {
      const result = evaluatePolicy('send_email', false, 1);
      expect(result.confirmationType).toBe('block_kit');
    });

    it('uses reaction for simple writes', () => {
      const result = evaluatePolicy('update_event', false, 1);
      expect(result.confirmationType).toBe('reaction');
    });
  });
});
