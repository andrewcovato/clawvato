/**
 * Tests for the Slack Socket Mode adapter.
 *
 * Since `createSlackConnection` creates a real Bolt App that tries to connect,
 * we test the component logic via unit tests on the adapter patterns and
 * event filtering behavior.
 */

import { describe, it, expect, vi } from 'vitest';
import { SlackHandler } from '../../src/slack/handler.js';

// We can't instantiate a Bolt App without real tokens, so we test
// the SlackHandler integration patterns that socket-mode.ts wires up.

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
  describe('SlackReactionAPI adapter', () => {
    it('adds reactions via handler', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      // Simulate what socket-mode.ts does — the handler uses the reaction API
      await handler.handleMessage({
        text: 'hello',
        channel: 'C123',
        user: 'U001',
        ts: '1111.0000',
      });

      // Handler should have added ⏳ reaction
      expect(reactions.add).toHaveBeenCalledWith('C123', '1111.0000', 'hourglass_flowing_sand');
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

    it('handler processes owner messages', async () => {
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

      // Should have added reaction (message accepted)
      expect(reactions.add).toHaveBeenCalled();

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
    it('removes hourglass and adds thumbsup', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.ackInterrupt('C123', '1111.0000');

      expect(reactions.remove).toHaveBeenCalledWith('C123', '1111.0000', 'hourglass_flowing_sand');
      expect(reactions.add).toHaveBeenCalledWith('C123', '1111.0000', 'thumbsup');
    });

    it('handles reaction failures gracefully', async () => {
      const reactions = createMockReactions();
      reactions.remove.mockRejectedValue(new Error('already_reacted'));
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
});
