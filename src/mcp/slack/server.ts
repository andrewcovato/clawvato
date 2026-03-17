/**
 * Slack Tools — tool definitions and handlers for the Anthropic API.
 *
 * Exposes Slack operations as Anthropic tool definitions with handler functions.
 * No MCP/SDK overhead — tools are called directly in the agent loop.
 *
 * Tools:
 *   slack_search_messages     — search.messages (user token for full access)
 *   slack_post_message        — chat.postMessage (outbound)
 *   slack_get_thread          — conversations.replies (read)
 *   slack_get_user_info       — users.info (read)
 *   slack_get_channel_history — conversations.history (read)
 */

import type { WebClient } from '@slack/web-api';
import type Anthropic from '@anthropic-ai/sdk';

/** Result from a tool handler */
export interface ToolHandlerResult {
  content: string;
  isError?: boolean;
}

/** A tool definition paired with its handler */
export interface SlackTool {
  definition: Anthropic.Tool;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
}

/**
 * Create Slack tool definitions and handlers backed by real Slack WebClients.
 */
export function createSlackTools(
  botClient: WebClient,
  userClient?: WebClient,
): SlackTool[] {
  return [
    // ── Search Messages ──
    {
      definition: {
        name: 'slack_search_messages',
        description:
          'Search Slack messages across channels. Returns matching messages with context. ' +
          'Requires a user token for full access; falls back to bot token (limited to public channels the bot is in).',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query (Slack search syntax supported)' },
            count: { type: 'number', description: 'Number of results (max 50, default 10)' },
            sort: { type: 'string', enum: ['score', 'timestamp'], description: 'Sort order (default: score)' },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = args.query as string;
        const count = Math.min((args.count as number) ?? 10, 50);
        const sort = (args.sort as string) ?? 'score';
        const client = userClient ?? botClient;

        try {
          const result = await client.search.messages({
            query,
            count,
            sort: sort as 'score' | 'timestamp',
          });

          const matches = result.messages?.matches ?? [];
          if (matches.length === 0) {
            return { content: `No messages found for "${query}".` };
          }

          const lines = matches.map((m, i) => {
            const rec = m as Record<string, unknown>;
            const channel = rec.channel?.toString() ?? 'unknown';
            const user = rec.username?.toString() ?? 'unknown';
            const text = rec.text?.toString() ?? '';
            const ts = rec.ts?.toString() ?? '';
            return `${i + 1}. [#${channel}] @${user} (${ts}): ${text.slice(0, 200)}`;
          });

          return {
            content: `Found ${result.messages?.total ?? matches.length} results for "${query}":\n\n${lines.join('\n')}`,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Search failed: ${msg}`, isError: true };
        }
      },
    },

    // ── Post Message ──
    {
      definition: {
        name: 'slack_post_message',
        description:
          'Post a message to a Slack channel or thread. ' +
          'Use channel ID (e.g., C0ABC123) not channel name.',
        input_schema: {
          type: 'object' as const,
          properties: {
            channel: { type: 'string', description: 'Channel ID to post to' },
            text: { type: 'string', description: 'Message text (supports Slack markdown)' },
            thread_ts: { type: 'string', description: 'Thread timestamp to reply to' },
          },
          required: ['channel', 'text'],
        },
      },
      handler: async (args) => {
        const channel = args.channel as string;
        const text = args.text as string;
        const thread_ts = args.thread_ts as string | undefined;

        try {
          const result = await botClient.chat.postMessage({
            channel,
            text,
            thread_ts,
          });

          return {
            content: `Message posted to ${channel}${thread_ts ? ' (thread)' : ''} (ts: ${result.ts})`,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Failed to post message: ${msg}`, isError: true };
        }
      },
    },

    // ── Get Thread ──
    {
      definition: {
        name: 'slack_get_thread',
        description: 'Retrieve all messages in a Slack thread.',
        input_schema: {
          type: 'object' as const,
          properties: {
            channel: { type: 'string', description: 'Channel ID containing the thread' },
            thread_ts: { type: 'string', description: 'Thread parent timestamp' },
            limit: { type: 'number', description: 'Max messages to return (default 50, max 200)' },
          },
          required: ['channel', 'thread_ts'],
        },
      },
      handler: async (args) => {
        const channel = args.channel as string;
        const thread_ts = args.thread_ts as string;
        const limit = Math.min((args.limit as number) ?? 50, 200);

        try {
          const result = await botClient.conversations.replies({
            channel,
            ts: thread_ts,
            limit,
          });

          const messages = result.messages ?? [];
          if (messages.length === 0) {
            return { content: 'No messages found in thread.' };
          }

          const lines = messages.map((m) => {
            const user = m.user ?? 'unknown';
            const text = m.text ?? '';
            return `@${user}: ${text.slice(0, 300)}`;
          });

          return {
            content: `Thread (${messages.length} messages):\n\n${lines.join('\n\n')}`,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Failed to get thread: ${msg}`, isError: true };
        }
      },
    },

    // ── Get User Info ──
    {
      definition: {
        name: 'slack_get_user_info',
        description: 'Get information about a Slack user by their user ID.',
        input_schema: {
          type: 'object' as const,
          properties: {
            user_id: { type: 'string', description: 'Slack user ID (e.g., U0ABC123)' },
          },
          required: ['user_id'],
        },
      },
      handler: async (args) => {
        const user_id = args.user_id as string;

        try {
          const result = await botClient.users.info({ user: user_id });
          const u = result.user;
          if (!u) {
            return { content: `User ${user_id} not found.` };
          }

          const profile = u.profile;
          const lines = [
            `Name: ${u.real_name ?? u.name ?? 'unknown'}`,
            profile?.title ? `Title: ${profile.title}` : null,
            profile?.email ? `Email: ${profile.email}` : null,
            `Timezone: ${u.tz ?? 'unknown'}`,
            `Status: ${profile?.status_text || 'none'}`,
            `Is Bot: ${u.is_bot ? 'yes' : 'no'}`,
          ].filter(Boolean);

          return { content: lines.join('\n') };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Failed to get user info: ${msg}`, isError: true };
        }
      },
    },

    // ── Get Channel History ──
    {
      definition: {
        name: 'slack_get_channel_history',
        description: 'Get recent messages from a Slack channel.',
        input_schema: {
          type: 'object' as const,
          properties: {
            channel: { type: 'string', description: 'Channel ID' },
            limit: { type: 'number', description: 'Number of messages (max 100, default 20)' },
          },
          required: ['channel'],
        },
      },
      handler: async (args) => {
        const channel = args.channel as string;
        const limit = Math.min((args.limit as number) ?? 20, 100);

        try {
          const result = await botClient.conversations.history({
            channel,
            limit,
          });

          const messages = result.messages ?? [];
          if (messages.length === 0) {
            return { content: 'No recent messages in this channel.' };
          }

          const lines = messages.map((m) => {
            const user = m.user ?? (m.bot_id ? `bot:${m.bot_id}` : 'unknown');
            const text = m.text ?? '';
            return `@${user}: ${text.slice(0, 300)}`;
          });

          return {
            content: `Recent messages (${messages.length}):\n\n${lines.join('\n\n')}`,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Failed to get history: ${msg}`, isError: true };
        }
      },
    },
  ];
}
