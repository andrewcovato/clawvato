/**
 * Slack Collector — incremental channel history sweep.
 *
 * Uses the user token (xoxp) for broad access across all channels
 * the owner is a member of, including private channels and DMs
 * that the bot may not be in.
 *
 * Cadence filter: fetches last N messages from each channel and checks
 * for activity gaps. Channels with large gaps (weeks of silence) are
 * skipped — they're dead channels not worth sweeping.
 *
 * High-water marks are per-channel: sweep:slack:{channelId}
 */

import type { WebClient } from '@slack/web-api';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getHighWaterMark, setHighWaterMark, type Collector, type CollectorResult } from './types.js';
import { retryWithBackoff } from './retry.js';

export interface SlackSweepConfig {
  excludeChannels: string[];
  maxMessagesPerChannel: number;
  /** Max gap (ms) between consecutive messages before channel is considered inactive. Default: 21 days */
  maxGapMs?: number;
  /** Number of recent messages to check for cadence. Default: 5 */
  cadenceSampleSize?: number;
  /** Upper bound timestamp — don't collect messages after this (for backfill). Slack ts format. */
  beforeTs?: string;
  /** Bot user ID — auto-excluded from DM sweep */
  botUserId?: string;
}

/**
 * Create a Slack collector that sweeps active channels the user is in.
 */
export function createSlackCollector(
  userClient: WebClient,
  sql: Sql,
  config: SlackSweepConfig,
): Collector {
  const maxGapMs = config.maxGapMs ?? 21 * 86_400_000; // 21 days
  const cadenceSampleSize = config.cadenceSampleSize ?? 5;

  return {
    name: 'slack',

    async collect(): Promise<CollectorResult> {
      let itemsScanned = 0;
      let itemsNew = 0;
      const contentChunks: string[] = [];

      // List all channels the user is a member of (with retry for transient failures)
      const allChannels = await retryWithBackoff(
        'slack:listUserChannels',
        () => listUserChannels(userClient, config.excludeChannels, config.botUserId),
      );
      logger.info({ channelCount: allChannels.length }, 'Slack sweep: discovered channels');

      // Cadence filter — check recent activity, skip dead channels (with retry)
      const activeChannels = await retryWithBackoff(
        'slack:filterActiveChannels',
        () => filterActiveChannels(userClient, allChannels, cadenceSampleSize, maxGapMs),
      );
      logger.info({
        active: activeChannels.length,
        skipped: allChannels.length - activeChannels.length,
      }, 'Slack sweep: cadence filter applied');

      for (const channel of activeChannels) {
        try {
          const hwmKey = `slack:${channel.id}`;
          const lastTs = await getHighWaterMark(sql, hwmKey);

          const messages = await retryWithBackoff(
            `slack:fetchMessages:${channel.id}`,
            () => fetchNewMessages(
              userClient,
              channel.id,
              lastTs,
              config.maxMessagesPerChannel,
              config.beforeTs,
            ),
          );

          itemsScanned += messages.length;

          if (messages.length === 0) continue;

          // Format as markdown chunk — skip bot messages
          const humanMessages = messages.filter(m => !m.botId);
          if (humanMessages.length === 0) continue;

          const chunk = formatSlackChunk(channel.name, humanMessages);
          contentChunks.push(chunk);
          itemsNew += humanMessages.length;

          // Update high-water mark to newest message ts
          const newestTs = messages[messages.length - 1].ts;
          if (newestTs) {
            await setHighWaterMark(sql, hwmKey, newestTs);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
          logger.warn({ error: errMsg, channel: channel.name, channelId: channel.id }, 'Slack sweep: channel failed — skipping');
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
 * Auto-excludes DMs with the bot.
 */
async function listUserChannels(
  client: WebClient,
  excludeChannels: string[],
  botUserId?: string,
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

          // Skip DMs with the bot itself
          if (ch.is_im && botUserId && ch.user === botUserId) continue;

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

/**
 * Filter channels by activity cadence.
 * Fetches the last N messages from each channel and checks for large gaps.
 * If any gap between consecutive messages exceeds maxGapMs, the channel is inactive.
 */
async function filterActiveChannels(
  client: WebClient,
  channels: SlackChannel[],
  sampleSize: number,
  maxGapMs: number,
): Promise<SlackChannel[]> {
  const active: SlackChannel[] = [];

  for (const channel of channels) {
    try {
      const result = await client.conversations.history({
        channel: channel.id,
        limit: sampleSize,
      });

      const messages = (result.messages ?? []).filter(m => !m.subtype && m.ts);

      if (messages.length === 0) continue; // No messages at all — skip

      if (messages.length < 2) {
        // Only 1 message — include if it's recent (within maxGapMs from now)
        const msgTime = parseFloat(messages[0].ts!) * 1000;
        if (Date.now() - msgTime < maxGapMs) {
          active.push(channel);
        }
        continue;
      }

      // Check gaps between consecutive messages (newest first from API)
      let hasLargeGap = false;
      for (let i = 0; i < messages.length - 1; i++) {
        const newer = parseFloat(messages[i].ts!) * 1000;
        const older = parseFloat(messages[i + 1].ts!) * 1000;
        const gap = newer - older;
        if (gap > maxGapMs) {
          hasLargeGap = true;
          break;
        }
      }

      // Also check gap from most recent message to now
      const mostRecentMs = parseFloat(messages[0].ts!) * 1000;
      if (Date.now() - mostRecentMs > maxGapMs) {
        hasLargeGap = true;
      }

      if (!hasLargeGap) {
        active.push(channel);
      }
    } catch {
      // Can't read channel — skip it
    }
  }

  return active;
}

interface SlackMessage {
  ts: string;
  user?: string;
  text?: string;
  botId?: string;
}

/**
 * Fetch messages from a channel since the high-water mark.
 * Optionally capped by a `before` timestamp for backfill.
 * Returns oldest-first order.
 */
async function fetchNewMessages(
  client: WebClient,
  channelId: string,
  sinceTs: string | null,
  maxMessages: number,
  beforeTs?: string,
): Promise<SlackMessage[]> {
  const messages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.conversations.history({
      channel: channelId,
      oldest: sinceTs ?? undefined,
      latest: beforeTs,
      limit: Math.min(maxMessages - messages.length, 200),
      cursor,
    });

    for (const msg of (result.messages ?? [])) {
      if (msg.subtype) continue;
      if (!msg.ts || !msg.text) continue;
      if (sinceTs && msg.ts === sinceTs) continue;

      messages.push({
        ts: msg.ts,
        user: msg.user,
        text: msg.text,
        botId: msg.bot_id ?? undefined,
      });

      if (messages.length >= maxMessages) break;
    }

    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor && messages.length < maxMessages);

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
