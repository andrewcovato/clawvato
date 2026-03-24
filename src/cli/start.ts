/**
 * Start the Clawvato agent process.
 *
 * Startup crawl uses the same code path as live messages:
 * for each joined channel, enqueue a "you just came back online"
 * message with conversation context. The agent reads the channel
 * like a human and decides what to do.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { initDb, getDb, closeDb } from '../db/index.js';
import { hasCredential, requireCredential, getCredential } from '../credentials.js';
import { createSlackConnection } from '../slack/socket-mode.js';
import { createHybridAgent } from '../agent/hybrid.js';
import { startScheduler } from '../tasks/scheduler.js';
import { executeScheduledTask } from '../tasks/executor.js';
import Anthropic from '@anthropic-ai/sdk';
import type { WebClient } from '@slack/web-api';
import { createSlackCollector } from '../sweeps/slack-collector.js';
import { createGmailCollector } from '../sweeps/gmail-collector.js';
import { createFirefliesCollector } from '../sweeps/fireflies-collector.js';
import { createDriveCollector } from '../sweeps/drive-collector.js';
import type { Collector } from '../sweeps/types.js';
import { getGoogleAuth } from '../google/auth.js';
import { FirefliesClient } from '../fireflies/api.js';

export async function startAgent(): Promise<void> {
  const config = getConfig();

  logger.info({ dataDir: config.dataDir, trustLevel: config.trustLevel }, 'Starting Clawvato agent');

  // ── Initialize database ──
  await initDb();
  const db = getDb();
  const [version] = await db`SELECT version FROM schema_version ORDER BY version DESC LIMIT 1`;
  logger.info({ schemaVersion: (version?.version as number) ?? 0 }, 'Database connected');

  // Memory consolidation, re-embedding, and reflection are handled by the
  // plugin scheduler (clawvato-memory). No agent-side startup maintenance needed.

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
    logger.error('OWNER_SLACK_USER_ID is required. Set it via environment variable or clawvato config set ownerSlackUserId YOUR_ID');
    process.exit(1);
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
    // User token is optional
  }

  const slack = await createSlackConnection({ appToken, botToken, userToken });

  // ── Resolve bot user ID ──
  let botUserId: string | undefined;
  try {
    const auth = await slack.botClient.auth.test();
    botUserId = auth.user_id as string | undefined;
  } catch { /* non-critical */ }

  // ── Create the Hybrid Agent (fast path + deep path) ──
  const agent = await createHybridAgent({
    botClient: slack.botClient,
    userClient: slack.userClient,
  });

  // ── Wire batch processing ──
  slack.handler.onBatch(async (batch) => {
    await agent.processBatch(batch, slack.handler);
  });

  // ── Build executor dependencies ──
  const apiKey = process.env.ANTHROPIC_API_KEY ?? await requireCredential('anthropic-api-key');
  const taskAnthropicClient = new Anthropic({ apiKey });
  const taskFastPathTools = agent.getFastPathTools();

  // ── Register sweep collectors (used by hybrid executor fallback) ──
  const sweepCollectors: Collector[] = [];
  if (config.sweeps.enabled) {
    // Slack collector (requires user token for broad channel access)
    if (config.sweeps.slack.enabled && slack.userClient) {
      sweepCollectors.push(createSlackCollector(slack.userClient, db, {
        excludeChannels: config.sweeps.slack.excludeChannels,
        maxMessagesPerChannel: config.sweeps.slack.maxMessagesPerChannel,
        botUserId,
      }));
    }

    // Gmail + Drive collectors (share Google auth)
    if (config.sweeps.gmail.enabled || config.sweeps.drive.enabled) {
      const googleAuth = await getGoogleAuth();
      if (googleAuth) {
        if (config.sweeps.gmail.enabled) {
          sweepCollectors.push(createGmailCollector(googleAuth, db, {
            maxThreads: config.sweeps.gmail.maxThreads,
          }));
        }
        if (config.sweeps.drive.enabled) {
          sweepCollectors.push(createDriveCollector(googleAuth, db, {
            maxFiles: config.sweeps.drive.maxFiles,
          }));
        }
      }
    }

    // Fireflies collector
    if (config.sweeps.fireflies.enabled) {
      const ffKey = process.env.FIREFLIES_API_KEY ?? await getCredential('fireflies-api-key').catch(() => undefined);
      if (ffKey) {
        sweepCollectors.push(createFirefliesCollector(new FirefliesClient(ffKey), db, {
          maxMeetings: config.sweeps.fireflies.maxMeetings,
        }));
      }
    }

    logger.info({ collectors: sweepCollectors.map(c => c.name) }, 'Sweep collectors registered');
  }

  // ── Task scheduler ──
  // Sweeps are now handled by the sidecar (task-scheduler-standalone.ts).
  // The hybrid scheduler here is for fallback only.
  const scheduler = startScheduler({
    sql: db,
    executeTask: async (task) => {
      return executeScheduledTask(task, {
        sql: db,
        anthropicClient: taskAnthropicClient,
        botClient: slack.botClient,
        fastPathTools: taskFastPathTools,
        botUserId,
        sweepCollectors,
      });
    },
  });

  // ── Graceful shutdown ──
  const shutdown = async () => {
    logger.info('Shutting down...');
    try { writeFileSync(join(config.dataDir, 'last-active.txt'), String(Date.now()), 'utf-8'); } catch { /* */ }
    scheduler.stop();
    await agent.shutdown();
    await slack.stop();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // ── Start Socket Mode connection ──
  await slack.start();

  logger.info('Clawvato agent is running. Listening to all joined channels.');
  logger.info('Press Ctrl+C to stop.');

  // ── Startup crawl (non-blocking, skip on quick redeploys) ──
  const lastActiveFile = join(config.dataDir, 'last-active.txt');
  let shouldCrawl = true;
  try {
    const lastActive = readFileSync(lastActiveFile, 'utf-8').trim();
    const offlineMs = Date.now() - parseInt(lastActive, 10);
    if (offlineMs < 5 * 60 * 1000) {
      shouldCrawl = false;
      logger.info({ offlineMs }, 'Skipping startup crawl — offline less than 5 minutes');
    }
  } catch { /* no file = first run, crawl */ }

  // Write current timestamp
  writeFileSync(lastActiveFile, String(Date.now()), 'utf-8');

  if (shouldCrawl) {
    crawlOnStartup(slack.botClient, slack.handler, config.ownerSlackUserId)
      .then(() => logger.info('Startup crawl complete'))
      .catch((error) => logger.warn({ error }, 'Startup crawl failed'));
  }

  // Socket Mode keeps the process alive via the WebSocket connection
}

/**
 * Discover all channels the bot is a member of.
 * Fetches each type separately — Slack's API drops private channels
 * when types are combined in a single conversations.list call.
 */
async function getJoinedChannels(botClient: WebClient): Promise<Array<{ id: string; name: string }>> {
  const channelTypes = ['public_channel', 'private_channel', 'im', 'mpim'] as const;
  const joined: Array<{ id: string; name: string }> = [];

  for (const type of channelTypes) {
    try {
      const result = await botClient.conversations.list({
        types: type,
        exclude_archived: true,
        limit: 200,
      });
      for (const ch of (result.channels ?? [])) {
        if (!ch.id || !ch.is_member) continue;
        if (ch.is_im || ch.is_mpim) continue; // Skip DMs
        joined.push({ id: ch.id, name: ch.name ?? ch.id });
      }
    } catch {
      logger.debug({ type }, 'conversations.list failed for type — skipping');
    }
  }

  return joined;
}

/**
 * Startup crawl — uses the exact same code path as live messages.
 */
async function crawlOnStartup(
  botClient: WebClient,
  handler: { getQueue: () => { enqueue: (msg: { text: string; channel: string; userId: string; ts: string; receivedAt: number }) => void } },
  ownerUserId?: string,
): Promise<void> {
  const channels = await getJoinedChannels(botClient);
  logger.info({ channelCount: channels.length }, 'Startup crawl: checking channels');

  for (const channel of channels) {
    logger.info({ channel: channel.id, channelName: channel.name }, 'Startup crawl: enqueuing check');

    handler.getQueue().enqueue({
      text: 'You just came back online. Review the recent conversation above and respond if anything needs your attention — outstanding requests, unanswered questions, or anything you missed while offline. If everything has been handled, stay silent.',
      channel: channel.id,
      userId: ownerUserId ?? '',
      ts: `crawl-${Date.now()}`,
      receivedAt: Date.now(),
    });
  }
}
