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

// Reset config before each test to avoid contamination from user's
// ~/.clawvato/config.json (which may have ownerSlackUserId set after setup).
// Set a default owner so tests that send messages as 'U001' are processed.
beforeEach(() => {
  loadConfig({ ownerSlackUserId: 'U001' });
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
    delete: vi.fn().mockResolvedValue(undefined),
  };
}

describe('Socket Mode adapter patterns', () => {
  describe('Message handling', () => {
    it('adds eyes reaction on message receipt', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.handleMessage({
        text: 'hello',
        channel: 'C123',
        user: 'U001',
        ts: '1111.0000',
      });

      expect(reactions.add).toHaveBeenCalledWith('C123', '1111.0000', 'eyes');
    });
  });

  describe('Event filtering (socket-mode responsibilities)', () => {
    it('handler ignores non-owner messages when ownerSlackUserId is set', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      const { loadConfig } = await import('../../src/config.js');
      loadConfig({ ownerSlackUserId: 'U_OWNER' });

      await handler.handleMessage({
        text: 'hello',
        channel: 'C123',
        user: 'U_NOT_OWNER',
        ts: '1111.0000',
      });

      expect(reactions.add).not.toHaveBeenCalled();

      loadConfig({ ownerSlackUserId: 'U001' });
    });

    it('handler processes owner messages with eyes reaction', async () => {
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

      expect(reactions.add).toHaveBeenCalledWith('C123', '1111.0000', 'eyes');

      loadConfig({ ownerSlackUserId: 'U001' });
    });
  });

  describe('Reaction lifecycle', () => {
    it('startProcessing removes eyes, adds brain, delays progress message', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.startProcessing('test task', 'C123', ['1111.0000', '2222.0000']);

      // Should remove 👀 from both messages
      expect(reactions.remove).toHaveBeenCalledWith('C123', '1111.0000', 'eyes');
      expect(reactions.remove).toHaveBeenCalledWith('C123', '2222.0000', 'eyes');

      // Should add 🧠 to the last message
      expect(reactions.add).toHaveBeenCalledWith('C123', '2222.0000', 'brain');

      // Should NOT post progress message immediately (20s delay)
      expect(messages.post).not.toHaveBeenCalled();

      // Should have an active task
      expect(handler.getActiveTask()).not.toBeNull();

      // Cleanup timer
      await handler.completeProcessing();
    });

    it('updateProgress queues text when progress message not yet posted', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.startProcessing('test task', 'C123', ['1111.0000']);

      // Progress message hasn't been posted yet (delay hasn't fired)
      await handler.updateProgress('Checking your calendar...');

      // Should NOT have called update (no message to update yet)
      expect(messages.update).not.toHaveBeenCalled();

      // The pending text should be used when the delay fires
      expect(handler.getActiveTask()?.pendingProgressText).toContain('Checking your calendar');

      await handler.completeProcessing();
    });

    it('updateProgress updates message after it has been posted', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.startProcessing('test task', 'C123', ['1111.0000']);

      // Simulate the delay timer firing by calling postProgressMessage directly
      await handler['postProgressMessage']();

      // Now update should work
      await handler.updateProgress('Checking your calendar...');
      expect(messages.update).toHaveBeenCalledWith('C123', '1234.5678', expect.stringContaining('Checking your calendar'));

      await handler.completeProcessing();
    });

    it('updateProgress skips redundant updates', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.startProcessing('test task', 'C123', ['1111.0000']);
      await handler['postProgressMessage']();

      await handler.updateProgress('Checking your calendar...');
      await handler.updateProgress('Checking your calendar...');

      // Should only update once (same text)
      expect(messages.update).toHaveBeenCalledTimes(1);

      await handler.completeProcessing();
    });

    it('completeProcessing removes brain and cleans up without progress message', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.startProcessing('test task', 'C123', ['1111.0000']);

      // Complete before the 20s delay — no progress message was posted
      await handler.completeProcessing();

      // Should remove 🧠 from the last message
      expect(reactions.remove).toHaveBeenCalledWith('C123', '1111.0000', 'brain');

      // Should NOT try to delete a progress message (none was posted)
      expect(messages.delete).not.toHaveBeenCalled();

      expect(handler.getActiveTask()).toBeNull();
    });

    it('completeProcessing deletes progress message if it was posted', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.startProcessing('test task', 'C123', ['1111.0000']);
      await handler['postProgressMessage']();

      await handler.completeProcessing();

      expect(messages.delete).toHaveBeenCalledWith('C123', '1234.5678');
      expect(handler.getActiveTask()).toBeNull();
    });

    it('completeProcessing is safe to call when no task is active', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.completeProcessing();

      expect(reactions.remove).not.toHaveBeenCalled();
      expect(messages.delete).not.toHaveBeenCalled();
    });
  });

  describe('Interrupt buffer', () => {
    it('routes messages to interrupt buffer when task is active', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.startProcessing('processing something', 'C123', ['0000.0000']);

      await handler.handleMessage({
        text: 'actually do this instead',
        channel: 'C123',
        user: 'U001',
        ts: '2222.0000',
      });

      expect(handler.getInterruptBuffer()).toHaveLength(1);
      expect(handler.getInterruptBuffer()[0].text).toBe('actually do this instead');
    });

    it('drainInterrupt returns and removes first buffer item', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.startProcessing('task', 'C123', ['0000.0000']);

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

    it('completeProcessing also clears interrupt buffer', async () => {
      const reactions = createMockReactions();
      const messages = createMockMessages();
      const handler = new SlackHandler(reactions, messages);

      await handler.startProcessing('task', 'C123', ['0000.0000']);
      handler['interruptBuffer'].push({ text: 'interrupt', ts: '1' });

      await handler.completeProcessing();

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

      expect(batchHandler).not.toHaveBeenCalled();
      expect(assistantAPIs.say).toHaveBeenCalledWith(
        expect.stringContaining('only assist my owner'),
      );

      loadConfig({ ownerSlackUserId: 'U001' });
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
        capturedAPI = handler.getAssistantAPI();
      });

      await handler.handleAssistantMessage({
        text: 'hello',
        channel: 'D123',
        user: 'U001',
        ts: '3333.0000',
        ...assistantAPIs,
      });

      expect(capturedAPI).not.toBeNull();
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

      await handler.handleAssistantMessage({
        text: 'hello',
        channel: 'D123',
        user: 'U001',
        ts: '3333.0000',
        ...assistantAPIs,
      });

      expect(assistantAPIs.say).toHaveBeenCalledWith(
        expect.stringContaining('error'),
      );
    });
  });
});
