import { describe, it, expect } from 'vitest';
import { scanForSecrets, assertNoSecrets } from '../../src/security/output-sanitizer.js';

describe('output-sanitizer', () => {
  describe('scanForSecrets', () => {
    it('detects Anthropic API keys', () => {
      const result = scanForSecrets('My key is sk-ant-api03-abc123def456_xyz789-more-stuff');
      expect(result.hasSecrets).toBe(true);
      expect(result.matches[0].type).toBe('anthropic_key');
      expect(result.redacted).toContain('[REDACTED:anthropic_key]');
    });

    it('detects Slack bot tokens', () => {
      const result = scanForSecrets('Token: xoxb-123456789-AbCdEfGhIjKl');
      expect(result.hasSecrets).toBe(true);
      expect(result.matches[0].type).toBe('slack_bot_token');
    });

    it('detects Slack app tokens', () => {
      const result = scanForSecrets('Token: xapp-1-A02B3C4D5E6-1234567890-abcdefghij');
      expect(result.hasSecrets).toBe(true);
      expect(result.matches[0].type).toBe('slack_app_token');
    });

    it('detects GitHub PATs', () => {
      const result = scanForSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
      expect(result.hasSecrets).toBe(true);
      expect(result.matches[0].type).toBe('github_pat');
    });

    it('detects AWS access keys', () => {
      const result = scanForSecrets('AKIAIOSFODNN7EXAMPLE');
      expect(result.hasSecrets).toBe(true);
      expect(result.matches[0].type).toBe('aws_access_key');
    });

    it('detects private key headers', () => {
      const result = scanForSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIB...');
      expect(result.hasSecrets).toBe(true);
      expect(result.matches[0].type).toBe('private_key');
    });

    it('detects SSNs', () => {
      const result = scanForSecrets('SSN: 123-45-6789');
      expect(result.hasSecrets).toBe(true);
      expect(result.matches[0].type).toBe('ssn');
    });

    it('returns clean for normal text', () => {
      const result = scanForSecrets('Hello, this is a normal message about the Q1 report.');
      expect(result.hasSecrets).toBe(false);
      expect(result.matches).toHaveLength(0);
      expect(result.redacted).toBe('Hello, this is a normal message about the Q1 report.');
    });

    it('detects multiple secrets in one string', () => {
      const text = 'Key: sk-ant-api03-longkeyhere123456 and token: xoxb-123456789-AbCdEfGhIjKl';
      const result = scanForSecrets(text);
      expect(result.hasSecrets).toBe(true);
      expect(result.matches.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('assertNoSecrets', () => {
    it('does not throw for clean text', () => {
      expect(() => assertNoSecrets('Hello world', 'test')).not.toThrow();
    });

    it('throws when secrets found', () => {
      expect(() =>
        assertNoSecrets('My key: sk-ant-api03-abc123def456_xyz789-more-stuff', 'email send'),
      ).toThrow(/Output sanitizer blocked email send/);
    });
  });
});
