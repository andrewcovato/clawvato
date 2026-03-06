/**
 * Tests for the Slack MCP server.
 *
 * Mocks WebClient to test tool input/output without real Slack API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// We can't easily test the full createSdkMcpServer without the SDK runtime,
// so we test the tool handler logic by importing the module and extracting
// the handler functions. Since the module wraps everything in createSdkMcpServer,
// we mock that and capture the tools config.

let capturedTools: Array<{
  name: string;
  description: string;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}> = [];

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  createSdkMcpServer: (config: { tools: typeof capturedTools }) => {
    capturedTools = config.tools;
    return { type: 'sdk', config };
  },
}));

vi.mock('zod', async () => {
  const actual = await vi.importActual('zod');
  return actual;
});

// Import after mocks
const { createSlackMcpServer } = await import('../../src/mcp/slack/server.js');

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

describe('Slack MCP Server', () => {
  let botClient: ReturnType<typeof createMockWebClient>;
  let userClient: ReturnType<typeof createMockWebClient>;

  beforeEach(() => {
    botClient = createMockWebClient();
    userClient = createMockWebClient();
    capturedTools = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createSlackMcpServer(botClient as any, userClient as any);
  });

  function findTool(name: string) {
    const tool = capturedTools.find(t => t.name === name);
    if (!tool) throw new Error(`Tool ${name} not found. Available: ${capturedTools.map(t => t.name).join(', ')}`);
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
      const result = await tool.handler({ query: 'test', count: 10, sort: 'score' }, {});

      expect(result.content[0].text).toContain('Found 2 results');
      expect(result.content[0].text).toContain('Hello world');
      expect(result.content[0].text).toContain('Fix the bug');
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
      await tool.handler({ query: 'test' }, {});

      expect(userClient.search.messages).toHaveBeenCalled();
      expect(botClient.search.messages).not.toHaveBeenCalled();
    });

    it('handles no results', async () => {
      userClient.search.messages.mockResolvedValue({
        messages: { total: 0, matches: [] },
      });

      const tool = findTool('slack_search_messages');
      const result = await tool.handler({ query: 'nonexistent' }, {});

      expect(result.content[0].text).toContain('No messages found');
    });

    it('handles API errors', async () => {
      userClient.search.messages.mockRejectedValue(new Error('rate_limited'));

      const tool = findTool('slack_search_messages');
      const result = await tool.handler({ query: 'test' }, {});

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('rate_limited');
    });

    it('caps count at 50', async () => {
      userClient.search.messages.mockResolvedValue({
        messages: { total: 0, matches: [] },
      });

      const tool = findTool('slack_search_messages');
      await tool.handler({ query: 'test', count: 100 }, {});

      expect(userClient.search.messages).toHaveBeenCalledWith(
        expect.objectContaining({ count: 50 }),
      );
    });
  });

  describe('slack_post_message', () => {
    it('posts a message and returns confirmation', async () => {
      botClient.chat.postMessage.mockResolvedValue({ ts: '1234.5678' });

      const tool = findTool('slack_post_message');
      const result = await tool.handler({ channel: 'C123', text: 'Hello' }, {});

      expect(result.content[0].text).toContain('Message posted');
      expect(result.content[0].text).toContain('C123');
      expect(botClient.chat.postMessage).toHaveBeenCalledWith({
        channel: 'C123',
        text: 'Hello',
        thread_ts: undefined,
      });
    });

    it('posts to a thread', async () => {
      botClient.chat.postMessage.mockResolvedValue({ ts: '1234.5678' });

      const tool = findTool('slack_post_message');
      const result = await tool.handler({ channel: 'C123', text: 'Reply', thread_ts: '1111.2222' }, {});

      expect(result.content[0].text).toContain('thread');
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
      const result = await tool.handler({ channel: 'C123', thread_ts: '1111.0000' }, {});

      expect(result.content[0].text).toContain('2 messages');
      expect(result.content[0].text).toContain('Thread parent');
      expect(result.content[0].text).toContain('Reply 1');
    });

    it('handles empty thread', async () => {
      botClient.conversations.replies.mockResolvedValue({ messages: [] });

      const tool = findTool('slack_get_thread');
      const result = await tool.handler({ channel: 'C123', thread_ts: '1111.0000' }, {});

      expect(result.content[0].text).toContain('No messages');
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
      const result = await tool.handler({ user_id: 'U001' }, {});

      expect(result.content[0].text).toContain('Alice Smith');
      expect(result.content[0].text).toContain('Engineer');
      expect(result.content[0].text).toContain('alice@co.com');
    });

    it('handles user not found', async () => {
      botClient.users.info.mockResolvedValue({ user: null });

      const tool = findTool('slack_get_user_info');
      const result = await tool.handler({ user_id: 'U999' }, {});

      expect(result.content[0].text).toContain('not found');
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
      const result = await tool.handler({ channel: 'C123', limit: 20 }, {});

      expect(result.content[0].text).toContain('2');
      expect(result.content[0].text).toContain('Message 1');
    });

    it('caps limit at 100', async () => {
      botClient.conversations.history.mockResolvedValue({ messages: [] });

      const tool = findTool('slack_get_channel_history');
      await tool.handler({ channel: 'C123', limit: 200 }, {});

      expect(botClient.conversations.history).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 100 }),
      );
    });
  });

  describe('tool registration', () => {
    it('registers all 5 tools', () => {
      expect(capturedTools).toHaveLength(5);
      const names = capturedTools.map(t => t.name);
      expect(names).toContain('slack_search_messages');
      expect(names).toContain('slack_post_message');
      expect(names).toContain('slack_get_thread');
      expect(names).toContain('slack_get_user_info');
      expect(names).toContain('slack_get_channel_history');
    });

    it('falls back to botClient when no userClient for search', async () => {
      // Recreate without user client
      capturedTools = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createSlackMcpServer(botClient as any);

      botClient.search.messages.mockResolvedValue({
        messages: { total: 0, matches: [] },
      });

      const tool = findTool('slack_search_messages');
      await tool.handler({ query: 'test' }, {});

      expect(botClient.search.messages).toHaveBeenCalled();
    });
  });
});
