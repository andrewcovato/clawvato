import { describe, it, expect } from 'vitest';
import { verifySender, classifyInbound } from '../../src/security/sender-verify.js';

const OWNER_ID = 'U12345OWNER';

describe('sender-verify', () => {
  describe('verifySender', () => {
    it('returns true for owner', () => {
      expect(verifySender(OWNER_ID, OWNER_ID)).toBe(true);
    });

    it('returns false for non-owner', () => {
      expect(verifySender('U99999OTHER', OWNER_ID)).toBe(false);
    });

    it('returns false for empty sender', () => {
      expect(verifySender('', OWNER_ID)).toBe(false);
    });
  });

  describe('classifyInbound', () => {
    it('classifies owner Slack message as instruction', () => {
      const result = classifyInbound(
        { source: 'slack', senderSlackId: OWNER_ID },
        OWNER_ID,
      );
      expect(result).toBe('instruction');
    });

    it('classifies non-owner Slack message as data', () => {
      const result = classifyInbound(
        { source: 'slack', senderSlackId: 'U99999OTHER' },
        OWNER_ID,
      );
      expect(result).toBe('data');
    });

    it('classifies email as data', () => {
      const result = classifyInbound(
        { source: 'email', senderEmail: 'someone@corp.com' },
        OWNER_ID,
      );
      expect(result).toBe('data');
    });

    it('classifies GitHub event as data', () => {
      const result = classifyInbound(
        { source: 'github' },
        OWNER_ID,
      );
      expect(result).toBe('data');
    });

    it('classifies file content as data', () => {
      const result = classifyInbound(
        { source: 'file' },
        OWNER_ID,
      );
      expect(result).toBe('data');
    });
  });
});
