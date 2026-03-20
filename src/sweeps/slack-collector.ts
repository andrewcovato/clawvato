/**
 * Slack Collector — incremental channel history sweep.
 *
 * Uses the user token (xoxp) for broad access across all channels
 * the owner is a member of, including private channels and DMs
 * that the bot may not be in.
 *
 * High-water marks are per-channel: sweep:slack:{channelId}
 */

import type { WebClient } from '@slack/web-api';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getHighWaterMark, setHighWaterMark, type Collector, type CollectorResult } from './types.js';

interface SlackSweepConfig {
  excludeChannels: string[];
  maxMessagesPerChannel: number;
}

/**
 * Create a Slack collector that sweeps all channels the user is in.
 */
export function createSlackCollector(
  userClient: WebClient,
  sql: Sql,
  config: SlackSweepConfig,
): Collector {
  return {
    name: 'slack',

    async collect(): Promise<CollectorResult> {
      let itemsScanned = 0;
      let itemsNew = 0;
      const contentChunks: string[] = [];

      // List all channels the user is a member of
      const channels = await listUserChannels(userClient, config.excludeChannels);
      logger.info({ channelCount: channels.length }, 'Slack sweep: discovered channels');

      for (const channel of channels) {
        try {
          const hwmKey = `slack:${channel.id}`;
          const lastTs = await getHighWaterMark(sql, hwmKey);

          const messages = await fetchNewMessages(
            userClient,
            channel.id,
            lastTs,
            config.maxMessagesPerChannel,
          );

          itemsScanned += messages.length;

          if (messages.length === 0) continue;

          // Format as markdown chunk
          const chunk = formatSlackChunk(channel.name, messages);
          contentChunks.push(chunk);
          itemsNew += messages.length;

          // Update high-water mark to newest message ts
          const newestTs = messages[messages.length - 1].ts;
          if (newestTs) {
            await setHighWaterMark(sql, hwmKey, newestTs);
          }

          logger.debug({ channel: channel.name, newMessages: messages.length }, 'Slack sweep: channel processed');
        } catch (err) {
          logger.debug({ error: err, channel: channel.name }, 'Slack sweep: channel failed — skipping');
        }
      }

      logger.info({ itemsScanned, itemsNew, chunks: contentChunks.length }, 'Slack sweep complete');

      return { source: 'slack', itemsScanned, itemsNew, contentChunks };
    },
  };
}

// ── Helpers ──

interface SlackChannel {
  id: string;
  name: string;
}

/**
 * List all channels the user is a member of via user token.
 * Fetches each type separately (Slack drops private channels when types are combined).
 */
async function listUserChannels(
  client: WebClient,
  excludeChannels: string[],
): Promise<SlackChannel[]> {
  const excludeSet = new Set(excludeChannels);
  const channelTypes = ['public_channel', 'private_channel', 'mpim', 'im'] as const;
  const channels: SlackChannel[] = [];

  for (const type of channelTypes) {
    try {
      let cursor: string | undefined;
      do {
        const result = await client.conversations.list({
          types: type,
          exclude_archived: true,
          limit: 200,
          cursor,
        });

        for (const ch of (result.channels ?? [])) {
          if (!ch.id || !ch.is_member) continue;
          if (excludeSet.has(ch.id)) continue;

          // For DMs/MPIMs, use a descriptive name
          let name = ch.name ?? ch.id;
          if (ch.is_im) name = `dm-${ch.user ?? ch.id}`;
          if (ch.is_mpim) name = `group-${ch.name ?? ch.id}`;

          channels.push({ id: ch.id, name });
        }

        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch {
      logger.debug({ type }, 'Slack sweep: conversations.list failed for type — skipping');
    }
  }

  return channels;
}

interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
}

/**
 * Fetch messages from a channel since the high-water mark.
 * Returns oldest-first order.
 */
async function fetchNewMessages(
  client: WebClient,
  channelId: string,
  sinceTs: string | null,
  maxMessages: number,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.conversations.history({
      channel: channelId,
      oldest: sinceTs ?? undefined,
      limit: Math.min(maxMessages - messages.length, 200),
      cursor,
    });

    for (const msg of (result.messages ?? [])) {
      if (msg.subtype) continue; // Skip system messages
      if (!msg.ts || !msg.text) continue;
      // Skip if this IS the high-water mark message (oldest is inclusive)
      if (sinceTs && msg.ts === sinceTs) continue;

      messages.push({ ts: msg.ts, user: msg.user, text: msg.text });

      if (messages.length >= maxMessages) break;
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor && messages.length < maxMessages);

  // Return oldest-first
  return messages.reverse();
}

/**
 * Format messages from a channel into a markdown chunk for synthesis.
 */
function formatSlackChunk(channelName: string, messages: SlackMessage[]): string {
  const lines = messages.map(m => {
    const user = m.user ?? 'unknown';
    const text = (m.text ?? '').slice(0, 2000);
    return `@${user}: ${text}`;
  });

  return `## Slack: #${channelName}\n\n${lines.join('\n\n')}`;
}
