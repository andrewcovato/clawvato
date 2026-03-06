/**
 * Tests for the setup wizard validation functions.
 * These are pure functions — no I/O needed.
 */

import { describe, it, expect } from 'vitest';
import {
  validateAnthropicKey,
  validateSlackBotToken,
  validateSlackAppToken,
  validateSlackUserToken,
  validateSlackUserId,
  validateTrustLevel,
} from '../../src/cli/setup.js';

describe('validateAnthropicKey', () => {
  it('accepts valid Anthropic API keys', () => {
    expect(validateAnthropicKey('sk-ant-api03-abcdefghijklmnop')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    const result = validateAnthropicKey('');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('empty');
  });

  it('rejects keys without sk-ant- prefix', () => {
    const result = validateAnthropicKey('sk-proj-abcdefghijklmnop');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('sk-ant-');
  });

  it('rejects keys that are too short', () => {
    const result = validateAnthropicKey('sk-ant-abc');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('short');
  });

  it('trims whitespace', () => {
    expect(validateAnthropicKey('  sk-ant-api03-abcdefghijklmnop  ')).toEqual({ valid: true });
  });
});

describe('validateSlackBotToken', () => {
  it('accepts valid bot tokens', () => {
    expect(validateSlackBotToken('xoxb-1234567890-abcdefghijkl')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    expect(validateSlackBotToken('').valid).toBe(false);
  });

  it('rejects tokens without xoxb- prefix', () => {
    const result = validateSlackBotToken('xoxp-1234567890-abcdefghijkl');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('xoxb-');
  });

  it('rejects tokens that are too short', () => {
    expect(validateSlackBotToken('xoxb-abc').valid).toBe(false);
  });
});

describe('validateSlackAppToken', () => {
  it('accepts valid app tokens', () => {
    expect(validateSlackAppToken('xapp-1-A0B1C2D3E4F5-1234567890')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    expect(validateSlackAppToken('').valid).toBe(false);
  });

  it('rejects tokens without xapp- prefix', () => {
    const result = validateSlackAppToken('xoxb-1234567890-abcdefghijkl');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('xapp-');
  });
});

describe('validateSlackUserToken', () => {
  it('accepts valid user tokens', () => {
    expect(validateSlackUserToken('xoxp-1234567890-abcdefghijkl')).toEqual({ valid: true });
  });

  it('accepts empty string (optional)', () => {
    expect(validateSlackUserToken('')).toEqual({ valid: true });
  });

  it('accepts whitespace-only string (optional)', () => {
    expect(validateSlackUserToken('   ')).toEqual({ valid: true });
  });

  it('rejects tokens without xoxp- prefix', () => {
    const result = validateSlackUserToken('xoxb-1234567890-abcdefghijkl');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('xoxp-');
  });
});

describe('validateSlackUserId', () => {
  it('accepts valid user IDs', () => {
    expect(validateSlackUserId('U0ABC12345')).toEqual({ valid: true });
  });

  it('accepts short user IDs', () => {
    expect(validateSlackUserId('U0AB')).toEqual({ valid: true });
  });

  it('rejects empty string', () => {
    expect(validateSlackUserId('').valid).toBe(false);
  });

  it('rejects IDs not starting with U', () => {
    const result = validateSlackUserId('W0ABC12345');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('U');
  });

  it('rejects lowercase IDs', () => {
    const result = validateSlackUserId('U0abc12345');
    expect(result.valid).toBe(false);
  });

  it('trims whitespace', () => {
    expect(validateSlackUserId('  U0ABC12345  ')).toEqual({ valid: true });
  });
});

describe('validateTrustLevel', () => {
  it('accepts 0', () => {
    expect(validateTrustLevel('0')).toEqual({ valid: true, value: 0 });
  });

  it('accepts 1', () => {
    expect(validateTrustLevel('1')).toEqual({ valid: true, value: 1 });
  });

  it('accepts 2', () => {
    expect(validateTrustLevel('2')).toEqual({ valid: true, value: 2 });
  });

  it('accepts 3', () => {
    expect(validateTrustLevel('3')).toEqual({ valid: true, value: 3 });
  });

  it('defaults to 1 on empty input', () => {
    expect(validateTrustLevel('')).toEqual({ valid: true, value: 1 });
  });

  it('defaults to 1 on whitespace-only input', () => {
    expect(validateTrustLevel('   ')).toEqual({ valid: true, value: 1 });
  });

  it('rejects negative numbers', () => {
    const result = validateTrustLevel('-1');
    expect(result.valid).toBe(false);
  });

  it('rejects numbers > 3', () => {
    const result = validateTrustLevel('4');
    expect(result.valid).toBe(false);
  });

  it('rejects non-numeric input', () => {
    const result = validateTrustLevel('abc');
    expect(result.valid).toBe(false);
  });
});
