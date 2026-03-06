/**
 * Slack MCP Server — exposes Slack tools to the Agent SDK.
 *
 * Uses `createSdkMcpServer()` for in-process MCP (no subprocess overhead).
 * The Agent SDK auto-discovers these tools via the `mcpServers` config.
 *
 * Tools exposed:
 *   slack_search_messages — search.messages (user token for full access)
 *   slack_post_message    — chat.postMessage (outbound)
 *   slack_get_thread      — conversations.replies (read)
 *   slack_get_user_info   — users.info (read)
 *   slack_get_channel_history — conversations.history (read)
 *
 * Each tool returns structured text (not raw JSON) so the model can
 * reason about results naturally.
 */

import { z } from 'zod';
import type { WebClient } from '@slack/web-api';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';

// The SDK handler receives args as Record<string, unknown> at runtime,
// even though inputSchema defines the shape. We use `as any` on
// each tool definition to bridge the generic constraint.

type AnyToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;
};

/**
 * Create a Slack MCP server with tools backed by real Slack WebClients.
 *
 * @param botClient - Slack WebClient authenticated with bot token (required)
 * @param userClient - Slack WebClient with user token (optional, enables search)
 */
export function createSlackMcpServer(
  botClient: WebClient,
  userClient?: WebClient,
) {
  const tools: AnyToolDef[] = [
    // ── Search Messages ──
    {
      name: 'slack_search_messages',
      description:
        'Search Slack messages across channels. Returns matching messages with context. ' +
        'Requires a user token for full access; falls back to bot token (limited to public channels the bot is in).',
      inputSchema: {
        query: z.string().describe('Search query (Slack search syntax supported)'),
        count: z.number().optional().default(10).describe('Number of results (max 50)'),
        sort: z.enum(['score', 'timestamp']).optional().default('score').describe('Sort order'),
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
            return { content: [{ type: 'text' as const, text: `No messages found for "${query}".` }] };
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
            content: [{
              type: 'text' as const,
              text: `Found ${result.messages?.total ?? matches.length} results for "${query}":\n\n${lines.join('\n')}`,
            }],
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text' as const, text: `Search failed: ${msg}` }], isError: true };
        }
      },
    },

    // ── Post Message ──
    {
      name: 'slack_post_message',
      description:
        'Post a message to a Slack channel or thread. ' +
        'Use channel ID (e.g., C0ABC123) not channel name.',
      inputSchema: {
        channel: z.string().describe('Channel ID to post to'),
        text: z.string().describe('Message text (supports Slack markdown)'),
        thread_ts: z.string().optional().describe('Thread timestamp to reply to'),
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
            content: [{
              type: 'text' as const,
              text: `Message posted to ${channel}${thread_ts ? ' (thread)' : ''} (ts: ${result.ts})`,
            }],
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text' as const, text: `Failed to post message: ${msg}` }], isError: true };
        }
      },
    },

    // ── Get Thread ──
    {
      name: 'slack_get_thread',
      description: 'Retrieve all messages in a Slack thread.',
      inputSchema: {
        channel: z.string().describe('Channel ID containing the thread'),
        thread_ts: z.string().describe('Thread parent timestamp'),
        limit: z.number().optional().default(50).describe('Max messages to return'),
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
            return { content: [{ type: 'text' as const, text: 'No messages found in thread.' }] };
          }

          const lines = messages.map((m) => {
            const user = m.user ?? 'unknown';
            const text = m.text ?? '';
            return `@${user}: ${text.slice(0, 300)}`;
          });

          return {
            content: [{
              type: 'text' as const,
              text: `Thread (${messages.length} messages):\n\n${lines.join('\n\n')}`,
            }],
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text' as const, text: `Failed to get thread: ${msg}` }], isError: true };
        }
      },
    },

    // ── Get User Info ──
    {
      name: 'slack_get_user_info',
      description: 'Get information about a Slack user by their user ID.',
      inputSchema: {
        user_id: z.string().describe('Slack user ID (e.g., U0ABC123)'),
      },
      handler: async (args) => {
        const user_id = args.user_id as string;

        try {
          const result = await botClient.users.info({ user: user_id });
          const u = result.user;
          if (!u) {
            return { content: [{ type: 'text' as const, text: `User ${user_id} not found.` }] };
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

          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text' as const, text: `Failed to get user info: ${msg}` }], isError: true };
        }
      },
    },

    // ── Get Channel History ──
    {
      name: 'slack_get_channel_history',
      description: 'Get recent messages from a Slack channel.',
      inputSchema: {
        channel: z.string().describe('Channel ID'),
        limit: z.number().optional().default(20).describe('Number of messages (max 100)'),
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
            return { content: [{ type: 'text' as const, text: 'No recent messages in this channel.' }] };
          }

          const lines = messages.map((m) => {
            const user = m.user ?? (m.bot_id ? `bot:${m.bot_id}` : 'unknown');
            const text = m.text ?? '';
            return `@${user}: ${text.slice(0, 300)}`;
          });

          return {
            content: [{
              type: 'text' as const,
              text: `Recent messages (${messages.length}):\n\n${lines.join('\n\n')}`,
            }],
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text' as const, text: `Failed to get history: ${msg}` }], isError: true };
        }
      },
    },
  ];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createSdkMcpServer({ name: 'slack', version: '1.0.0', tools: tools as any });
}
