/**
 * Tests for the Slack Socket Mode adapter.
 *
 * Since `createSlackConnection` creates a real Bolt App that tries to connect,
 * we test the component logic via unit tests on the adapter patterns and
 * event filtering behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackHandler } from '../../src/slack/handler.js';
import { loadConfig } from '../../src/config.js';

// We can't instantiate a Bolt App without real tokens, so we test
// the SlackHandler integration patterns that socket-mode.ts wires up.

// Reset config before each test to avoid contamination from user's
// ~/.clawvato/config.json (which may have ownerSlackUserId set after setup).
beforeEach(() => {
  loadConfig({ ownerSlackUserId: '' });
});

function createMockReactions() {
  return {
    add: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockMessages() {
  return {
    post: vi.fn().mockResolvedValue({ ts: '1234.5678' }),
    update: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Socket Mode adapter patterns', () => {
  describe('Message handling', () => {
    it('adds eyes reaction on message receipt (debug signal)', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.handleMessage({
        text: 'hello',
        channel: 'C123',
        user: 'U001',
        ts: '1111.0000',
      });

      // Debug: 👀 = message received
      expect(reactions.add).toHaveBeenCalledWith('C123', '1111.0000', 'eyes');
    });
  });

  describe('Event filtering (socket-mode responsibilities)', () => {
    it('handler ignores non-owner messages when ownerSlackUserId is set', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      // Reload config with owner set (env stubs don't affect cached config)
      const { loadConfig } = await import('../../src/config.js');
      loadConfig({ ownerSlackUserId: 'U_OWNER' });

      await handler.handleMessage({
        text: 'hello',
        channel: 'C123',
        user: 'U_NOT_OWNER',
        ts: '1111.0000',
      });

      // Should NOT have added reaction (message ignored)
      expect(reactions.add).not.toHaveBeenCalled();

      // Reset
      loadConfig({ ownerSlackUserId: undefined });
    });

    it('handler processes owner messages with debug reaction', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      const { loadConfig } = await import('../../src/config.js');
      loadConfig({ ownerSlackUserId: 'U_OWNER' });

      await handler.handleMessage({
        text: 'hello',
        channel: 'C123',
        user: 'U_OWNER',
        ts: '1111.0000',
      });

      // Debug: 👀 = message received by owner
      expect(reactions.add).toHaveBeenCalledWith('C123', '1111.0000', 'eyes');

      // Reset
      loadConfig({ ownerSlackUserId: undefined });
    });
  });

  describe('Interrupt buffer (socket-mode integration)', () => {
    it('routes messages to interrupt buffer when task is active', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      // Set active task
      handler.setActiveTask('processing something', 'C123');

      await handler.handleMessage({
        text: 'actually do this instead',
        channel: 'C123',
        user: 'U001',
        ts: '2222.0000',
      });

      expect(handler.getInterruptBuffer()).toHaveLength(1);
      expect(handler.getInterruptBuffer()[0].text).toBe('actually do this instead');
    });

    it('drainInterrupt returns and removes first buffer item', () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      handler.setActiveTask('task', 'C123');

      // Manually push to buffer for testing
      // In real code, handleMessage does this
      handler['interruptBuffer'].push(
        { text: 'first', ts: '1' },
        { text: 'second', ts: '2' },
      );

      const drained = handler.drainInterrupt();
      expect(drained).toEqual({ text: 'first', ts: '1' });
      expect(handler.getInterruptBuffer()).toHaveLength(1);
    });

    it('drainInterrupt returns null when buffer is empty', () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      expect(handler.drainInterrupt()).toBeNull();
    });

    it('clearActiveTask also clears interrupt buffer', () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      handler.setActiveTask('task', 'C123');
      handler['interruptBuffer'].push({ text: 'interrupt', ts: '1' });

      handler.clearActiveTask();

      expect(handler.getActiveTask()).toBeNull();
      expect(handler.getInterruptBuffer()).toHaveLength(0);
    });
  });

  describe('ackInterrupt', () => {
    it('adds thumbsup reaction', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.ackInterrupt('C123', '1111.0000');

      expect(reactions.add).toHaveBeenCalledWith('C123', '1111.0000', 'thumbsup');
    });

    it('handles reaction failures gracefully', async () => {
      const reactions = createMockReactions();
      reactions.add.mockRejectedValue(new Error('too_many_reactions'));
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      // Should not throw
      await handler.ackInterrupt('C123', '1111.0000');
    });
  });

  describe('getMessages', () => {
    it('exposes message API for external use', () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      expect(handler.getMessages()).toBe(messages);
    });
  });

  describe('Assistant panel (handleAssistantMessage)', () => {
    function createMockAssistantAPIs() {
      return {
        setStatus: vi.fn().mockResolvedValue(undefined),
        setTitle: vi.fn().mockResolvedValue(undefined),
        say: vi.fn().mockResolvedValue(undefined),
      };
    }

    it('routes assistant messages to batch handler', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);
      const assistantAPIs = createMockAssistantAPIs();

      const batchHandler = vi.fn().mockResolvedValue(undefined);
      handler.onBatch(batchHandler);

      await handler.handleAssistantMessage({
        text: 'hello from assistant',
        channel: 'D123',
        user: 'U001',
        ts: '3333.0000',
        ...assistantAPIs,
      });

      // Should have called the batch handler
      expect(batchHandler).toHaveBeenCalledTimes(1);
      const batch = batchHandler.mock.calls[0][0];
      expect(batch.combinedText).toBe('hello from assistant');
      expect(batch.channel).toBe('D123');
    });

    it('sets status indicator on assistant message', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);
      const assistantAPIs = createMockAssistantAPIs();

      handler.onBatch(vi.fn().mockResolvedValue(undefined));

      await handler.handleAssistantMessage({
        text: 'hello',
        channel: 'D123',
        user: 'U001',
        ts: '3333.0000',
        ...assistantAPIs,
      });

      // Should have set status to "Thinking..."
      expect(assistantAPIs.setStatus).toHaveBeenCalledWith('Thinking...');
    });

    it('rejects non-owner messages with a polite message', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);
      const assistantAPIs = createMockAssistantAPIs();

      const { loadConfig } = await import('../../src/config.js');
      loadConfig({ ownerSlackUserId: 'U_OWNER' });

      const batchHandler = vi.fn().mockResolvedValue(undefined);
      handler.onBatch(batchHandler);

      await handler.handleAssistantMessage({
        text: 'hello from non-owner',
        channel: 'D123',
        user: 'U_NOT_OWNER',
        ts: '3333.0000',
        ...assistantAPIs,
      });

      // Should NOT have called batch handler
      expect(batchHandler).not.toHaveBeenCalled();
      // Should have sent rejection message via say()
      expect(assistantAPIs.say).toHaveBeenCalledWith(
        expect.stringContaining('only assist my owner'),
      );

      // Reset
      loadConfig({ ownerSlackUserId: undefined });
    });

    it('getAssistantAPI returns null when not in assistant mode', () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      expect(handler.getAssistantAPI()).toBeNull();
    });

    it('getAssistantAPI returns API during assistant processing', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);
      const assistantAPIs = createMockAssistantAPIs();

      let capturedAPI: unknown = null;
      handler.onBatch(async () => {
        // Capture the assistant API during processing
        capturedAPI = handler.getAssistantAPI();
      });

      await handler.handleAssistantMessage({
        text: 'hello',
        channel: 'D123',
        user: 'U001',
        ts: '3333.0000',
        ...assistantAPIs,
      });

      // API should have been available during processing
      expect(capturedAPI).not.toBeNull();
      // But should be null after processing completes
      expect(handler.getAssistantAPI()).toBeNull();
    });

    it('does not add reactions in assistant mode', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);
      const assistantAPIs = createMockAssistantAPIs();

      handler.onBatch(vi.fn().mockResolvedValue(undefined));

      await handler.handleAssistantMessage({
        text: 'hello',
        channel: 'D123',
        user: 'U001',
        ts: '3333.0000',
        ...assistantAPIs,
      });

      // Should NOT have used reaction API (assistant uses setStatus instead)
      expect(reactions.add).not.toHaveBeenCalled();
    });

    it('handles batch handler errors gracefully', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);
      const assistantAPIs = createMockAssistantAPIs();

      handler.onBatch(async () => {
        throw new Error('processing failed');
      });

      // Should not throw
      await handler.handleAssistantMessage({
        text: 'hello',
        channel: 'D123',
        user: 'U001',
        ts: '3333.0000',
        ...assistantAPIs,
      });

      // Should have sent error message via say()
      expect(assistantAPIs.say).toHaveBeenCalledWith(
        expect.stringContaining('error'),
      );
    });
  });
});
