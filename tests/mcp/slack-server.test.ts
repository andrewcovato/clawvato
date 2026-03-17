/**
 * Tests for the Slack tools.
 *
 * Mocks WebClient to test tool input/output without real Slack API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSlackTools, type SlackTool } from '../../src/mcp/slack/server.js';

function createMockWebClient() {
  return {
    search: {
      messages: vi.fn(),
    },
    chat: {
      postMessage: vi.fn(),
    },
    conversations: {
      replies: vi.fn(),
      history: vi.fn(),
    },
    users: {
      info: vi.fn(),
    },
  };
}

describe('Slack Tools', () => {
  let botClient: ReturnType<typeof createMockWebClient>;
  let userClient: ReturnType<typeof createMockWebClient>;
  let tools: SlackTool[];

  beforeEach(() => {
    botClient = createMockWebClient();
    userClient = createMockWebClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tools = createSlackTools(botClient as any, userClient as any);
  });

  function findTool(name: string) {
    const tool = tools.find(t => t.definition.name === name);
    if (!tool) throw new Error(`Tool ${name} not found. Available: ${tools.map(t => t.definition.name).join(', ')}`);
    return tool;
  }

  describe('slack_search_messages', () => {
    it('returns formatted search results', async () => {
      userClient.search.messages.mockResolvedValue({
        messages: {
          total: 2,
          matches: [
            { channel: 'general', username: 'alice', text: 'Hello world', ts: '1234' },
            { channel: 'dev', username: 'bob', text: 'Fix the bug', ts: '5678' },
          ],
        },
      });

      const tool = findTool('slack_search_messages');
      const result = await tool.handler({ query: 'test', count: 10, sort: 'score' });

      expect(result.content).toContain('Found 2 results');
      expect(result.content).toContain('Hello world');
      expect(result.content).toContain('Fix the bug');
      expect(userClient.search.messages).toHaveBeenCalledWith({
        query: 'test',
        count: 10,
        sort: 'score',
      });
    });

    it('uses userClient when available', async () => {
      userClient.search.messages.mockResolvedValue({
        messages: { total: 0, matches: [] },
      });

      const tool = findTool('slack_search_messages');
      await tool.handler({ query: 'test' });

      expect(userClient.search.messages).toHaveBeenCalled();
      expect(botClient.search.messages).not.toHaveBeenCalled();
    });

    it('handles no results', async () => {
      userClient.search.messages.mockResolvedValue({
        messages: { total: 0, matches: [] },
      });

      const tool = findTool('slack_search_messages');
      const result = await tool.handler({ query: 'nonexistent' });

      expect(result.content).toContain('No messages found');
    });

    it('handles API errors', async () => {
      userClient.search.messages.mockRejectedValue(new Error('rate_limited'));

      const tool = findTool('slack_search_messages');
      const result = await tool.handler({ query: 'test' });

      expect(result.isError).toBe(true);
      expect(result.content).toContain('rate_limited');
    });

    it('caps count at 50', async () => {
      userClient.search.messages.mockResolvedValue({
        messages: { total: 0, matches: [] },
      });

      const tool = findTool('slack_search_messages');
      await tool.handler({ query: 'test', count: 100 });

      expect(userClient.search.messages).toHaveBeenCalledWith(
        expect.objectContaining({ count: 50 }),
      );
    });
  });

  describe('slack_post_message', () => {
    it('posts a message and returns confirmation', async () => {
      botClient.chat.postMessage.mockResolvedValue({ ts: '1234.5678' });

      const tool = findTool('slack_post_message');
      const result = await tool.handler({ channel: 'C123', text: 'Hello' });

      expect(result.content).toContain('Message posted');
      expect(result.content).toContain('C123');
      expect(botClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: 'Hello',
        thread_ts: undefined,
      });
    });

    it('posts to a thread', async () => {
      botClient.chat.postMessage.mockResolvedValue({ ts: '1234.5678' });

      const tool = findTool('slack_post_message');
      const result = await tool.handler({ channel: 'C123', text: 'Reply', thread_ts: '1111.2222' });

      expect(result.content).toContain('thread');
      expect(botClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: 'Reply',
        thread_ts: '1111.2222',
      });
    });
  });

  describe('slack_get_thread', () => {
    it('returns formatted thread messages', async () => {
      botClient.conversations.replies.mockResolvedValue({
        messages: [
          { user: 'U001', text: 'Thread parent' },
          { user: 'U002', text: 'Reply 1' },
        ],
      });

      const tool = findTool('slack_get_thread');
      const result = await tool.handler({ channel: 'C123', thread_ts: '1111.0000' });

      expect(result.content).toContain('2 messages');
      expect(result.content).toContain('Thread parent');
      expect(result.content).toContain('Reply 1');
    });

    it('handles empty thread', async () => {
      botClient.conversations.replies.mockResolvedValue({ messages: [] });

      const tool = findTool('slack_get_thread');
      const result = await tool.handler({ channel: 'C123', thread_ts: '1111.0000' });

      expect(result.content).toContain('No messages');
    });
  });

  describe('slack_get_user_info', () => {
    it('returns formatted user info', async () => {
      botClient.users.info.mockResolvedValue({
        user: {
          real_name: 'Alice Smith',
          name: 'alice',
          profile: { title: 'Engineer', email: 'alice@co.com', status_text: 'Working' },
          tz: 'America/New_York',
          is_bot: false,
        },
      });

      const tool = findTool('slack_get_user_info');
      const result = await tool.handler({ user_id: 'U001' });

      expect(result.content).toContain('Alice Smith');
      expect(result.content).toContain('Engineer');
      expect(result.content).toContain('alice@co.com');
    });

    it('handles user not found', async () => {
      botClient.users.info.mockResolvedValue({ user: null });

      const tool = findTool('slack_get_user_info');
      const result = await tool.handler({ user_id: 'U999' });

      expect(result.content).toContain('not found');
    });
  });

  describe('slack_get_channel_history', () => {
    it('returns formatted channel history', async () => {
      botClient.conversations.history.mockResolvedValue({
        messages: [
          { user: 'U001', text: 'Message 1' },
          { user: 'U002', text: 'Message 2' },
        ],
      });

      const tool = findTool('slack_get_channel_history');
      const result = await tool.handler({ channel: 'C123', limit: 20 });

      expect(result.content).toContain('2');
      expect(result.content).toContain('Message 1');
    });

    it('caps limit at 100', async () => {
      botClient.conversations.history.mockResolvedValue({ messages: [] });

      const tool = findTool('slack_get_channel_history');
      await tool.handler({ channel: 'C123', limit: 200 });

      expect(botClient.conversations.history).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });
  });

  describe('tool registration', () => {
    it('registers all 5 tools', () => {
      expect(tools).toHaveLength(5);
      const names = tools.map(t => t.definition.name);
      expect(names).toContain('slack_search_messages');
      expect(names).toContain('slack_post_message');
      expect(names).toContain('slack_get_thread');
      expect(names).toContain('slack_get_user_info');
      expect(names).toContain('slack_get_channel_history');
    });

    it('falls back to botClient when no userClient for search', async () => {
      // Recreate without user client
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const botOnlyTools = createSlackTools(botClient as any);

      botClient.search.messages.mockResolvedValue({
        messages: { total: 0, matches: [] },
      });

      const tool = botOnlyTools.find(t => t.definition.name === 'slack_search_messages')!;
      await tool.handler({ query: 'test' });

      expect(botClient.search.messages).toHaveBeenCalled();
    });
  });
});
