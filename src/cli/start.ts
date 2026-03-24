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
import { shouldConsolidate, consolidate } from '../memory/consolidation.js';
import { startScheduler } from '../tasks/scheduler.js';
import { executeScheduledTask } from '../tasks/executor.js';
import { handleApprovalReaction } from '../tasks/approval.js';
import { TaskChannelManager } from '../tasks/channel-manager.js';
import { setTaskApprovalHandler, setTaskThreadResolver } from '../slack/socket-mode.js';
import Anthropic from '@anthropic-ai/sdk';
import type { WebClient } from '@slack/web-api';
import { createSlackCollector } from '../sweeps/slack-collector.js';
import { createGmailCollector } from '../sweeps/gmail-collector.js';
import { createFirefliesCollector } from '../sweeps/fireflies-collector.js';
import { createDriveCollector } from '../sweeps/drive-collector.js';
import { registerSweepTask } from '../sweeps/executor.js';
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

  // ── Run memory consolidation if due (>24h since last run) ──
  if (await shouldConsolidate(db)) {
    try {
      const result = await consolidate(db);
      logger.info(result, 'Startup consolidation complete');
    } catch (error) {
      logger.warn({ error }, 'Startup consolidation failed — non-critical');
    }
  }

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
  // ── Task channel manager (created before agent so tools get it) ──
  let taskChannelManager: TaskChannelManager | undefined;
  if (config.tasks.channelId) {
    taskChannelManager = new TaskChannelManager({
      botClient: slack.botClient,
      messages: slack.handler.getMessages(),
      sql: db,
      channelId: config.tasks.channelId,
    });
  }

  const agent = await createHybridAgent({
    botClient: slack.botClient,
    userClient: slack.userClient,
    taskChannelManager,
  });

  // ── Wire batch processing ──
  slack.handler.onBatch(async (batch) => {
    await agent.processBatch(batch, slack.handler);
  });

  // Reconcile task pins on startup
  if (taskChannelManager) {
    try {
      const result = await taskChannelManager.reconcilePins();
      logger.info(result, 'Task pins reconciled on startup');
    } catch (err) {
      logger.warn({ error: err }, 'Task pin reconciliation failed — non-critical');
    }
  }

  // ── Build executor dependencies ──
  const apiKey = process.env.ANTHROPIC_API_KEY ?? await requireCredential('anthropic-api-key');
  const taskAnthropicClient = new Anthropic({ apiKey });
  const taskFastPathTools = agent.getFastPathTools();

  // ── Register sweep collectors ──
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

    // Register the recurring sweep task
    await registerSweepTask(db, config.sweeps.cron);
    logger.info({ collectors: sweepCollectors.map(c => c.name) }, 'Sweep collectors registered');
  }

  // ── Task scheduler ──
  const scheduler = startScheduler({
    sql: db,
    executeTask: async (task) => {
      return executeScheduledTask(task, {
        sql: db,
        anthropicClient: taskAnthropicClient,
        botClient: slack.botClient,
        fastPathTools: taskFastPathTools,
        channelManager: taskChannelManager,
        botUserId,
        sweepCollectors,
      });
    },
    postReminder: taskChannelManager ? async (task) => {
      if (!task.pin_message_ts) return;
      try {
        const reminderText = config.ownerSlackUserId
          ? `<@${config.ownerSlackUserId}> Reminder: this task is waiting for your approval. React :thumbsup: to approve, or reply to discuss.`
          : `Reminder: this task is waiting for your approval.`;
        await taskChannelManager!.postThreadReply(task.pin_message_ts, reminderText);
      } catch (err) {
        logger.debug({ error: err, taskId: task.id }, 'Failed to post task reminder');
      }
    } : undefined,
  });

  // ── Wire task approval reactions ──
  setTaskApprovalHandler(async (channel, messageTs) => {
    await handleApprovalReaction(db, channel, messageTs, taskChannelManager);
  });

  // ── Wire task thread resolver (deterministic task matching for thread replies) ──
  if (taskChannelManager) {
    setTaskThreadResolver(async (channel, threadTs) => {
      if (channel !== config.tasks.channelId) return null;
      const task = await taskChannelManager!.findTaskByPinTs(threadTs);
      if (!task) return null;
      return { taskId: task.id, title: task.title };
    });
  }

  // ── Periodic consolidation + pin sync ──
  const consolidationCheckMs = config.memory.consolidationCheckIntervalHours * 60 * 60 * 1000;
  const consolidationTimer = setInterval(async () => {
    try {
      if (await shouldConsolidate(db)) {
        const result = await consolidate(db);
        logger.info(result, 'Periodic consolidation complete');
      }
    } catch (error) {
      logger.warn({ error }, 'Periodic consolidation failed — non-critical');
    }

    // Periodic pin sync
    if (taskChannelManager) {
      try {
        await taskChannelManager.reconcilePins();
      } catch (error) {
        logger.debug({ error }, 'Periodic pin sync failed — non-critical');
      }
    }
  }, consolidationCheckMs);

  // ── Graceful shutdown ──
  const shutdown = async () => {
    logger.info('Shutting down...');
    try { writeFileSync(join(config.dataDir, 'last-active.txt'), String(Date.now()), 'utf-8'); } catch { /* */ }
    clearInterval(consolidationTimer);
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
  // Only crawl if bot has been offline for >5 minutes. This prevents
  // the bot from responding to old messages on every Railway redeploy.
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
 *
 * For each joined channel, enqueue a prompt that tells the agent
 * "you just came back online — review the conversation and respond
 * if anything needs your attention." The agent's processBatch will
 * fetch channel history automatically and Claude will decide what to do.
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
