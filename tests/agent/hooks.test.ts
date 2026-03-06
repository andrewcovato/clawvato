/**
 * Tests for the Agent SDK hook adapters.
 *
 * Tests the PreToolUse and PostToolUse hook callbacks that bridge
 * our security modules to the Agent SDK's hook system.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPreToolUseHook, createPostToolUseHook, type InterruptState } from '../../src/agent/hooks.js';
import { SlackHandler, type SlackReactionAPI, type SlackMessageAPI } from '../../src/slack/handler.js';
import type { DatabaseSync } from 'node:sqlite';

// Mock the security modules
vi.mock('../../src/hooks/pre-tool-use.js', () => ({
  preToolUse: vi.fn().mockReturnValue({ allowed: true }),
}));

vi.mock('../../src/hooks/post-tool-use.js', () => ({
  postToolUse: vi.fn().mockReturnValue({ sanitizedOutput: 'output' }),
}));

vi.mock('../../src/training-wheels/policy-engine.js', () => ({
  evaluatePolicy: vi.fn().mockReturnValue({ autoApproved: true, reason: 'test' }),
}));

vi.mock('../../src/training-wheels/graduation.js', () => ({
  isGraduated: vi.fn().mockReturnValue(false),
  recordOccurrence: vi.fn(),
}));

vi.mock('../../src/slack/interrupt-classifier.js', () => ({
  classifyInterrupt: vi.fn().mockResolvedValue({ type: 'cancel', shouldAsk: false, confidence: 0.9 }),
  generateClarificationMessage: vi.fn().mockReturnValue('Could you clarify?'),
}));

vi.mock('../../src/config.js', () => ({
  getConfig: vi.fn().mockReturnValue({
    trustLevel: 1,
    ownerSlackUserId: 'U_OWNER',
    dataDir: '/tmp/clawvato-test',
  }),
}));

function createMockHandler(): SlackHandler {
  const reactions: SlackReactionAPI = {
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
  const messages: SlackMessageAPI = {
    post: vi.fn().mockResolvedValue({ ts: '1234' }),
    update: vi.fn().mockResolvedValue(undefined),
  };
  return new SlackHandler(reactions, messages);
}

function createMockDb(): DatabaseSync {
  return {
    prepare: vi.fn().mockReturnValue({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn().mockReturnValue([]),
    }),
    exec: vi.fn(),
    close: vi.fn(),
  } as unknown as DatabaseSync;
}

const mockAbortSignal = new AbortController().signal;

describe('createPreToolUseHook', () => {
  let handler: SlackHandler;
  let db: DatabaseSync;
  let interruptState: InterruptState;
  let classifierFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = createMockHandler();
    db = createMockDb();
    interruptState = { type: null };
    classifierFn = vi.fn().mockResolvedValue('cancel');
    vi.clearAllMocks();
  });

  it('allows tool calls when no interrupts and security passes', async () => {
    const hook = createPreToolUseHook(handler, db, classifierFn, interruptState);

    const result = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'slack_search_messages', tool_input: { query: 'test' } },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(result.continue).toBe(true);
  });

  it('blocks when security check fails', async () => {
    const { preToolUse } = await import('../../src/hooks/pre-tool-use.js');
    (preToolUse as ReturnType<typeof vi.fn>).mockReturnValueOnce({ allowed: false, reason: 'Rate limit exceeded' });

    const hook = createPreToolUseHook(handler, db, classifierFn, interruptState);

    const result = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'slack_post_message', tool_input: {} },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(result.decision).toBe('block');
    expect(result.reason).toContain('Rate limit');
  });

  it('handles cancel interrupt', async () => {
    // Set up an active task and push an interrupt
    handler.setActiveTask('Current task', 'C123');
    handler['interruptBuffer'].push({ text: 'scratch that', ts: '2222.0000' });

    const { classifyInterrupt } = await import('../../src/slack/interrupt-classifier.js');
    (classifyInterrupt as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'cancel',
      shouldAsk: false,
      confidence: 0.95,
    });

    const hook = createPreToolUseHook(handler, db, classifierFn, interruptState);

    const result = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'slack_search_messages', tool_input: {} },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(result.decision).toBe('block');
    expect(interruptState.type).toBe('cancel');
  });

  it('handles redirect interrupt', async () => {
    handler.setActiveTask('Current task', 'C123');
    handler['interruptBuffer'].push({ text: 'actually do Y instead', ts: '2222.0000' });

    const { classifyInterrupt } = await import('../../src/slack/interrupt-classifier.js');
    (classifyInterrupt as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'redirect',
      shouldAsk: false,
      confidence: 0.9,
    });

    const hook = createPreToolUseHook(handler, db, classifierFn, interruptState);

    const result = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'slack_search_messages', tool_input: {} },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(result.decision).toBe('block');
    expect(interruptState.type).toBe('redirect');
    expect(interruptState.newMessage).toBe('actually do Y instead');
  });

  it('handles additive interrupt (allows tool call)', async () => {
    handler.setActiveTask('Current task', 'C123');
    handler['interruptBuffer'].push({ text: 'also check X', ts: '2222.0000' });

    const { classifyInterrupt } = await import('../../src/slack/interrupt-classifier.js');
    (classifyInterrupt as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'additive',
      shouldAsk: false,
      confidence: 0.85,
    });

    const hook = createPreToolUseHook(handler, db, classifierFn, interruptState);

    const result = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'slack_search_messages', tool_input: {} },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(result.continue).toBe(true);
    expect(interruptState.type).toBe('additive');
  });

  it('generates clarification when classification confidence is low', async () => {
    handler.setActiveTask('Current task', 'C123');
    handler['interruptBuffer'].push({ text: 'hmm something', ts: '2222.0000' });

    const { classifyInterrupt } = await import('../../src/slack/interrupt-classifier.js');
    (classifyInterrupt as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      type: 'cancel',
      shouldAsk: true,
      confidence: 0.3,
    });

    const hook = createPreToolUseHook(handler, db, classifierFn, interruptState);

    const result = await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'slack_search_messages', tool_input: {} },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(result.decision).toBe('block');
    expect(interruptState.type).toBe('cancel');
    expect(interruptState.clarificationMessage).toBeTruthy();
  });

  it('passes sender ID to security check', async () => {
    const { preToolUse } = await import('../../src/hooks/pre-tool-use.js');

    const hook = createPreToolUseHook(handler, db, classifierFn, interruptState, 'U_OWNER');

    await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'test_tool', tool_input: {} },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(preToolUse).toHaveBeenCalledWith(
      expect.objectContaining({ senderSlackId: 'U_OWNER' }),
    );
  });

  it('derives server name from MCP tool name prefix', async () => {
    const { preToolUse } = await import('../../src/hooks/pre-tool-use.js');

    const hook = createPreToolUseHook(handler, db, classifierFn, interruptState);

    await hook(
      { hook_event_name: 'PreToolUse', tool_name: 'mcp__slack__search_messages', tool_input: {} },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(preToolUse).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'slack' }),
    );
  });
});

describe('createPostToolUseHook', () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createMockDb();
    vi.clearAllMocks();
  });

  it('calls postToolUse for audit and sanitization', async () => {
    const { postToolUse } = await import('../../src/hooks/post-tool-use.js');

    const hook = createPostToolUseHook(db);
    const result = await hook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'slack_search_messages',
        tool_input: { query: 'test' },
        tool_response: 'Found 3 results',
      },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(postToolUse).toHaveBeenCalled();
    expect(result.continue).toBe(true);
  });

  it('records graduation occurrence', async () => {
    const { recordOccurrence } = await import('../../src/training-wheels/graduation.js');

    const hook = createPostToolUseHook(db);
    await hook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'slack_post_message',
        tool_input: { channel: 'C123', text: 'hi' },
        tool_response: 'Message posted',
      },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(recordOccurrence).toHaveBeenCalledWith(
      db,
      'slack_post_message',
      expect.any(String),
      expect.any(Object),
      'approved',
    );
  });

  it('returns sanitized output when changed', async () => {
    const { postToolUse } = await import('../../src/hooks/post-tool-use.js');
    (postToolUse as ReturnType<typeof vi.fn>).mockReturnValueOnce({
      sanitizedOutput: '[REDACTED]',
    });

    const hook = createPostToolUseHook(db);
    const result = await hook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'test_tool',
        tool_input: {},
        tool_response: 'sk-ant-secret-key-here',
      },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(result.hookSpecificOutput).toBeDefined();
    expect(result.hookSpecificOutput?.updatedMCPToolOutput).toBe('[REDACTED]');
  });

  it('handles error responses', async () => {
    const hook = createPostToolUseHook(db);
    const result = await hook(
      {
        hook_event_name: 'PostToolUse',
        tool_name: 'test_tool',
        tool_input: {},
        tool_response: { isError: true, content: [{ type: 'text', text: 'Failed' }] },
      },
      'tool-use-1',
      { signal: mockAbortSignal },
    );

    expect(result.continue).toBe(true);
  });
});
