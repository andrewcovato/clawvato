import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, resetAllRateLimits } from '../../src/security/rate-limiter.js';

describe('rate-limiter', () => {
  beforeEach(() => {
    resetAllRateLimits();
  });

  it('allows requests within limit', () => {
    const result = checkRateLimit('test.tool');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBeDefined();
  });

  it('tracks remaining count', () => {
    const r1 = checkRateLimit('test.tool');
    const r2 = checkRateLimit('test.tool');
    expect(r2.remaining!).toBe(r1.remaining! - 1);
  });

  it('blocks after exceeding limit', () => {
    // Default limit is 60/min for unknown tools
    for (let i = 0; i < 60; i++) {
      const result = checkRateLimit('burst.tool');
      expect(result.allowed).toBe(true);
    }
    const blocked = checkRateLimit('burst.tool');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toContain('Rate limit exceeded');
  });

  it('uses tighter limits for email sending', () => {
    // gmail.send_email has 20/hour limit
    for (let i = 0; i < 20; i++) {
      const result = checkRateLimit('gmail.send_email');
      expect(result.allowed).toBe(true);
    }
    const blocked = checkRateLimit('gmail.send_email');
    expect(blocked.allowed).toBe(false);
  });

  it('resets properly', () => {
    for (let i = 0; i < 60; i++) {
      checkRateLimit('reset.test');
    }
    expect(checkRateLimit('reset.test').allowed).toBe(false);

    resetAllRateLimits();
    expect(checkRateLimit('reset.test').allowed).toBe(true);
  });
});
