/**
 * Start the Clawvato agent process.
 *
 * This is the full bootstrap that:
 * 1. Validates required credentials (Anthropic, Slack)
 * 2. Verifies database connectivity
 * 3. Connects to Slack via Socket Mode
 * 4. Creates the Agent SDK orchestrator
 * 5. Wires handler.onBatch → agent.processBatch
 * 6. Handles graceful shutdown
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { getDb, closeDb } from '../db/index.js';
import { hasCredential, requireCredential } from '../credentials.js';
import { createSlackConnection } from '../slack/socket-mode.js';
import { createAgent } from '../agent/index.js';
import type { WebClient } from '@slack/web-api';

export async function startAgent(): Promise<void> {
  const config = getConfig();

  logger.info({ dataDir: config.dataDir, trustLevel: config.trustLevel }, 'Starting Clawvato agent');

  // ── Verify database ──
  const db = getDb();
  const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as
    | { version: number }
    | undefined;
  logger.info({ schemaVersion: version?.version ?? 0 }, 'Database connected');

  // ── Verify required credentials ──
  const missingCreds: string[] = [];
  if (!await hasCredential('anthropic-api-key')) missingCreds.push('anthropic-api-key');
  if (!await hasCredential('slack-bot-token')) missingCreds.push('slack-bot-token');
  if (!await hasCredential('slack-app-token')) missingCreds.push('slack-app-token');

  if (missingCreds.length > 0) {
    logger.error(
      { missing: missingCreds },
      'Missing required credentials. Run: clawvato setup',
    );
    console.error(`\nMissing credentials: ${missingCreds.join(', ')}`);
    console.error('Run `clawvato setup` to configure all required credentials.\n');
    process.exit(1);
  }

  // ── Verify owner config ──
  if (!config.ownerSlackUserId) {
    logger.warn('No ownerSlackUserId configured — agent will not verify senders');
    logger.warn('Set with: clawvato config set ownerSlackUserId YOUR_SLACK_USER_ID');
  }

  // ── Log startup summary ──
  const trustLabels = ['FULL SUPERVISION', 'TRUSTED READS', 'TRUSTED ROUTINE', 'FULL AUTONOMY'];
  logger.info({
    trustLevel: `${config.trustLevel} (${trustLabels[config.trustLevel]})`,
    model: config.models.executor,
  }, 'Agent configuration loaded');

  // ── Connect to Slack via Socket Mode ──
  const botToken = await requireCredential('slack-bot-token');
  const appToken = await requireCredential('slack-app-token');
  let userToken: string | undefined;
  try {
    userToken = (await hasCredential('slack-user-token'))
      ? await requireCredential('slack-user-token')
      : undefined;
  } catch {
    // User token is optional — search will be limited
  }

  const slack = await createSlackConnection({ appToken, botToken, userToken });

  // ── Create the Agent ──
  const agent = await createAgent({
    botClient: slack.botClient,
    userClient: slack.userClient,
  });

  // ── Wire batch processing ──
  slack.handler.onBatch(async (batch) => {
    await agent.processBatch(batch, slack.handler);
  });

  // ── Graceful shutdown ──
  const shutdown = async () => {
    logger.info('Shutting down...');
    saveLastActiveTimestamp(config.dataDir);
    await agent.shutdown();
    await slack.stop();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // ── Start Socket Mode connection ──
  await slack.start();

  logger.info('Clawvato agent is running. Listening to all joined channels.');
  logger.info('Press Ctrl+C to stop.');

  // ── Crawl for missed messages ──
  await crawlMissedMessages(slack.botClient, config.dataDir);

  // ── Record startup time (for next launch's crawl) ──
  saveLastActiveTimestamp(config.dataDir);

  // Socket Mode keeps the process alive via the WebSocket connection
}

/** Path to the file that stores last-active timestamp */
function lastActiveFile(dataDir: string): string {
  return join(dataDir, 'last-active.txt');
}

/** Save current timestamp so next startup knows when we went offline */
function saveLastActiveTimestamp(dataDir: string): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(lastActiveFile(dataDir), Date.now().toString(), 'utf-8');
  } catch (error) {
    logger.debug({ error }, 'Failed to save last-active timestamp');
  }
}

/** Read the last-active timestamp (returns epoch ms, or 0 if not found) */
function readLastActiveTimestamp(dataDir: string): number {
  try {
    const content = readFileSync(lastActiveFile(dataDir), 'utf-8').trim();
    return parseInt(content, 10) || 0;
  } catch {
    return 0; // First launch or file missing
  }
}

/**
 * On startup, check joined channels for messages the bot missed while offline.
 * If there are many missed messages, announce presence and offer to catch up.
 */
async function crawlMissedMessages(botClient: WebClient, dataDir: string): Promise<void> {
  const lastActive = readLastActiveTimestamp(dataDir);
  if (lastActive === 0) {
    logger.info('First launch — skipping missed message crawl');
    return;
  }

  const offlineDuration = Date.now() - lastActive;
  logger.info({ offlineMs: offlineDuration }, 'Checking for missed messages');

  // Don't crawl if we were only offline briefly (< 2 minutes)
  if (offlineDuration < 120_000) {
    logger.info('Was offline < 2 minutes — skipping crawl');
    return;
  }

  try {
    // Get channels the bot is a member of
    const channelsResult = await botClient.conversations.list({
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: true,
      limit: 100,
    });

    const channels = (channelsResult.channels ?? []).filter(c => c.is_member);
    logger.info({ channelCount: channels.length }, 'Checking joined channels for missed messages');

    // Convert lastActive to Slack timestamp format (seconds.microseconds)
    const oldestTs = (lastActive / 1000).toFixed(6);

    for (const channel of channels) {
      if (!channel.id) continue;

      // Skip DMs for the announcement — we'll respond when they message us
      const isDM = channel.is_im || channel.is_mpim;
      if (isDM) continue;

      try {
        const history = await botClient.conversations.history({
          channel: channel.id,
          oldest: oldestTs,
          limit: 50,
        });

        const messages = (history.messages ?? []).filter(m => !m.bot_id && m.subtype === undefined);
        if (messages.length >= 5) {
          // Significant activity while we were offline — announce
          const channelName = channel.name ?? channel.id;
          logger.info(
            { channel: channel.id, channelName, missedCount: messages.length },
            'Found missed messages — announcing presence',
          );

          await botClient.chat.postMessage({
            channel: channel.id,
            text: `I'm back online — looks like I missed ${messages.length} messages in here while I was away. Want me to catch up on anything?`,
          });
        }
      } catch (error) {
        // Some channels may not be accessible
        logger.debug({ channel: channel.id, error }, 'Failed to check channel history');
      }
    }
  } catch (error) {
    logger.warn({ error }, 'Failed to crawl missed messages');
  }
}
