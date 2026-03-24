#!/usr/bin/env npx tsx
/**
 * Standalone Sidecar — unified process for task scheduling + tiered sweeps.
 *
 * Three responsibilities:
 * 1. Tiered sweep runner — collectors run in-process, content sent to plugin /ingest
 * 2. Task poller — dispatches user-facing tasks to Slack for CC to handle
 * 3. Event feed — posts task/sweep events to the task channel
 *
 * Sweeps are categorized by urgency:
 * - frequent (hourly): Slack + Fireflies — high-velocity sources
 * - standard (6h): Drive — slow-changing files
 * - backfill (daily): all sources — safety net, catches anything missed
 *
 * All sweeps are incremental (high-water marks) and idempotent (plugin dedup).
 */

process.env.LOG_DESTINATION = 'stderr';

import { WebClient } from '@slack/web-api';
import { initDb, getDb } from '../db/index.js';
import { loadConfig, getConfig } from '../config.js';
import { logger } from '../logger.js';
import { hasCredential, requireCredential, getCredential } from '../credentials.js';
import { createSlackCollector } from '../sweeps/slack-collector.js';
import { createGmailCollector } from '../sweeps/gmail-collector.js';
import { createDriveCollector } from '../sweeps/drive-collector.js';
import { createFirefliesCollector } from '../sweeps/fireflies-collector.js';
import type { Collector, CollectorResult } from '../sweeps/types.js';
import { getHighWaterMark, setHighWaterMark } from '../sweeps/types.js';
import { getGoogleAuth } from '../google/auth.js';
import { FirefliesClient } from '../fireflies/api.js';
import {
  getDueTasks,
  getPendingApprovals,
  markRunning,
  markCompleted,
  markFailed,
  rescheduleRecurring,
  markReminderSent,
  type ScheduledTask,
} from '../tasks/store.js';

// Redirect console to stderr
const stderrWrite = (msg: string) => process.stderr.write(msg + '\n');
console.log = stderrWrite;
console.warn = stderrWrite;
console.error = stderrWrite;

// ── Initialize ──

loadConfig({});
const config = getConfig();
await initDb();
const sql = getDb();

const botToken = process.env.SLACK_BOT_TOKEN;
const ownerUserId = process.env.OWNER_SLACK_USER_ID;
const taskChannelId = config.tasks.channelId;
const pluginUrl = process.env.CLAWVATO_MEMORY_URL ?? 'https://clawvato-memory-production.up.railway.app';
const pluginAuthToken = process.env.MCP_AUTH_TOKEN ?? '';

if (!botToken) {
  console.error('FATAL: SLACK_BOT_TOKEN required for sidecar');
  process.exit(1);
}

const slackClient = new WebClient(botToken);

// ── Event Feed ──

async function postEvent(text: string): Promise<void> {
  const channel = taskChannelId || ownerUserId;
  if (!channel) return;
  try {
    await slackClient.chat.postMessage({ channel, text });
  } catch (err) {
    logger.warn({ error: err }, 'Failed to post event to task channel');
  }
}

// ── Sweep Infrastructure ──

// Build collectors (same init as start.ts)
const allCollectors: Map<string, Collector> = new Map();

async function initCollectors(): Promise<void> {
  // Slack
  const userToken = process.env.SLACK_USER_TOKEN;
  if (config.sweeps.slack.enabled && userToken) {
    const userClient = new WebClient(userToken);
    let botUserId: string | undefined;
    try {
      const auth = await slackClient.auth.test();
      botUserId = auth.user_id as string | undefined;
    } catch { /* */ }
    allCollectors.set('slack', createSlackCollector(userClient, sql, {
      excludeChannels: config.sweeps.slack.excludeChannels,
      maxMessagesPerChannel: config.sweeps.slack.maxMessagesPerChannel,
      botUserId,
    }));
  }

  // Gmail + Drive
  if (config.sweeps.gmail.enabled || config.sweeps.drive.enabled) {
    const googleAuth = await getGoogleAuth();
    if (googleAuth) {
      if (config.sweeps.gmail.enabled) {
        allCollectors.set('gmail', createGmailCollector(googleAuth, sql, {
          maxThreads: config.sweeps.gmail.maxThreads,
        }));
      }
      if (config.sweeps.drive.enabled) {
        allCollectors.set('drive', createDriveCollector(googleAuth, sql, {
          maxFiles: config.sweeps.drive.maxFiles,
        }));
      }
    }
  }

  // Fireflies
  if (config.sweeps.fireflies.enabled) {
    const ffKey = process.env.FIREFLIES_API_KEY ?? await getCredential('fireflies-api-key').catch(() => undefined);
    if (ffKey) {
      allCollectors.set('fireflies', createFirefliesCollector(new FirefliesClient(ffKey), sql, {
        maxMeetings: config.sweeps.fireflies.maxMeetings,
      }));
    }
  }

  logger.info({ collectors: [...allCollectors.keys()] }, 'Sweep collectors initialized');
}

/**
 * Run a sweep tier — collect from specified sources, send to plugin /ingest.
 */
async function runSweepTier(tierName: string, sources: string[]): Promise<void> {
  const collectors = sources
    .map(s => allCollectors.get(s))
    .filter((c): c is Collector => c !== undefined);

  if (collectors.length === 0) {
    logger.debug({ tier: tierName }, 'No collectors available for tier — skipping');
    return;
  }

  logger.info({ tier: tierName, sources: collectors.map(c => c.name) }, 'Sweep tier starting');
  const startMs = Date.now();

  // Run collectors in parallel with error isolation
  const results = await Promise.allSettled(collectors.map(c => c.collect()));

  let totalItems = 0;
  let totalNew = 0;
  const failed: string[] = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const collectorName = collectors[i].name;

    if (result.status === 'rejected') {
      const errMsg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      logger.warn({ collector: collectorName, error: errMsg }, 'Collector failed');
      failed.push(`${collectorName}: ${errMsg.slice(0, 100)}`);
      continue;
    }

    const cr = result.value;
    totalItems += cr.itemsScanned;
    totalNew += cr.itemsNew;

    // Send content to plugin /ingest if there's anything new
    if (cr.contentChunks.length > 0 && cr.itemsNew > 0) {
      const text = cr.contentChunks.join('\n\n---\n\n');
      const source = `sweep:${collectorName}:${new Date().toISOString().split('T')[0]}`;

      try {
        const response = await fetch(`${pluginUrl}/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${pluginAuthToken}`,
          },
          body: JSON.stringify({ text, source, surface_id: 'cloud' }),
        });

        if (!response.ok) {
          logger.warn({ collector: collectorName, status: response.status }, 'Plugin /ingest failed');
        } else {
          const body = await response.json() as { result?: string };
          logger.info({ collector: collectorName, result: body.result }, 'Sweep content ingested');
        }
      } catch (err) {
        logger.warn({ collector: collectorName, error: err }, 'Plugin /ingest request failed');
      }
    }
  }

  const durationMs = Date.now() - startMs;

  // Track last-run for this tier
  await setHighWaterMark(sql, `sweep:tier:${tierName}:last_run`, new Date().toISOString());

  if (failed.length > 0) {
    const errSummary = failed.join('; ');
    logger.warn({ tier: tierName, failed: failed.length, duration: durationMs }, 'Sweep tier completed with failures');
    await postEvent(`⚠️ *Sweep ${tierName} partial failure*\n${errSummary}\n\nCollected ${totalNew} new items from ${collectors.length - failed.length}/${collectors.length} sources in ${Math.round(durationMs / 1000)}s.`);
  } else if (totalNew > 0) {
    logger.info({ tier: tierName, items: totalItems, new: totalNew, duration: durationMs }, 'Sweep tier complete');
    // Successful sweeps are silent — only log, no Slack post
  } else {
    logger.info({ tier: tierName, duration: durationMs }, 'Sweep tier complete — no new items');
  }
}

// ── Task Poller ──

async function taskTick(): Promise<void> {
  // Check for approval reminders
  try {
    const pending = await getPendingApprovals(sql, config.tasks.reminderDelayMs);
    for (const task of pending) {
      try {
        const channel = taskChannelId || ownerUserId;
        if (channel) {
          const reminderText = ownerUserId
            ? `<@${ownerUserId}> Reminder: task "*${task.title}*" is waiting for approval. Say "approve ${task.title}" to activate.`
            : `Reminder: task "${task.title}" is waiting for approval.`;
          await slackClient.chat.postMessage({ channel, text: reminderText });
        }
        await markReminderSent(sql, task.id);
      } catch (err) {
        logger.debug({ error: err, taskId: task.id }, 'Reminder failed — non-critical');
      }
    }
  } catch (err) {
    logger.debug({ error: err }, 'Approval check failed — non-critical');
  }

  // Find and dispatch due tasks
  const dueTasks = await getDueTasks(sql);
  if (dueTasks.length === 0) return;

  logger.info({ count: dueTasks.length }, 'Found due tasks');

  for (const task of dueTasks.slice(0, config.tasks.maxConcurrentTasks)) {
    await markRunning(sql, task.id);

    try {
      await postTaskToSlack(task);

      if (task.cron_expression) {
        await rescheduleRecurring(sql, task.id, 'Dispatched to CC via Slack', task.cron_expression);
        logger.info({ taskId: task.id, title: task.title }, 'Recurring task dispatched — rescheduled');
      } else {
        await markCompleted(sql, task.id, 'Dispatched to CC via Slack');
        logger.info({ taskId: task.id, title: task.title }, 'One-shot task dispatched');
      }

      await postEvent(`📋 *Task dispatched*: ${task.title}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await markFailed(sql, task.id, errMsg);
      logger.warn({ taskId: task.id, error: errMsg }, 'Task dispatch failed');
      await postEvent(`⚠️ *Task failed*: ${task.title}\n${errMsg.slice(0, 200)}`);
    }
  }
}

async function postTaskToSlack(task: ScheduledTask): Promise<void> {
  const channel = taskChannelId || ownerUserId;
  if (!channel) {
    logger.warn({ taskId: task.id }, 'No task channel or owner ID — cannot post task');
    return;
  }

  const text = `📋 *Scheduled task due*: ${task.title}\n${task.description ?? ''}\n\nPlease handle this task. If it requires externally-visible actions, report what you recommend and wait for approval.`;

  await slackClient.chat.postMessage({ channel, text });
  logger.info({ taskId: task.id, title: task.title, channel }, 'Task posted to Slack for CC');
}

// ── Startup ──

await initCollectors();

// Check for overdue sweep tiers and run immediately
async function runOverdueTiers(): Promise<void> {
  const tiers = config.sweeps.tiers;

  for (const [name, tier] of Object.entries(tiers)) {
    const lastRun = await getHighWaterMark(sql, `sweep:tier:${name}:last_run`);
    const overdue = !lastRun || (Date.now() - new Date(lastRun).getTime()) > tier.intervalMs;

    if (overdue) {
      logger.info({ tier: name, lastRun }, 'Sweep tier overdue — running now');
      try {
        await runSweepTier(name, tier.sources);
      } catch (err) {
        logger.warn({ tier: name, error: err }, 'Overdue sweep tier failed');
      }
    }
  }
}

// ── Start timers ──

const taskPollMs = config.tasks.schedulerPollMs;
const tiers = config.sweeps.tiers;

logger.info({
  taskPollMs,
  sweepTiers: Object.fromEntries(
    Object.entries(tiers).map(([name, t]) => [name, { sources: t.sources, intervalMs: t.intervalMs }])
  ),
}, 'Sidecar starting');

// Task poller
setInterval(async () => {
  try {
    await taskTick();
  } catch (err) {
    logger.warn({ error: err }, 'Task tick failed');
  }
}, taskPollMs);

// Sweep tier timers
for (const [name, tier] of Object.entries(tiers)) {
  setInterval(async () => {
    try {
      await runSweepTier(name, tier.sources);
    } catch (err) {
      logger.warn({ tier: name, error: err }, 'Sweep tier failed');
    }
  }, tier.intervalMs);
}

// Initial task tick after brief delay
setTimeout(() => void taskTick().catch(err => logger.warn({ error: err }, 'Initial task tick failed')), 5000);

// Run overdue sweep tiers on startup (after collectors init)
setTimeout(() => void runOverdueTiers().catch(err => logger.warn({ error: err }, 'Overdue tier check failed')), 10_000);

logger.info('Sidecar running — task poller + tiered sweeps');

// Keep alive
process.on('SIGTERM', () => {
  logger.info('Sidecar shutting down');
  process.exit(0);
});
