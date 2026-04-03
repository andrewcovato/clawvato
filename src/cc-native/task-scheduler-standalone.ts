#!/usr/bin/env npx tsx
/**
 * Standalone Sidecar — task poller + event feed.
 *
 * Two responsibilities:
 * 1. Task poller — dispatches user-facing tasks to Slack for CC to handle
 * 2. Event feed — posts task events to the task channel
 *
 * Sweeps have moved to brain-platform (sidecar/poll-scheduler.ts).
 */

process.env.LOG_DESTINATION = 'stderr';

import { WebClient } from '@slack/web-api';
import { initDb, getDb } from '../db/index.js';
import { loadConfig, getConfig } from '../config.js';
import { logger } from '../logger.js';
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
import { runMasterCrawl } from './master-crawl.js';
import { runUrgencyCheck } from './urgency-check.js';

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

// ── Master Crawl Cron ──

function parseCronHours(schedule: string): number[] {
  // Handles "0 8,18 * * *" → [8, 18]
  const parts = schedule.split(/\s+/);
  if (parts.length < 2) return [];
  return parts[1].split(',').map(Number).filter(n => !isNaN(n));
}

import { readFileSync, writeFileSync } from 'fs';

const LAST_CRAWL_FILE = '/tmp/last-master-crawl-hour';
let lastCrawlHour = -1;
let lastCrawlTime = new Date();
let crawlRunning = false;

// Restore last crawl hour from disk (prevents double-fire on sidecar restart)
try {
  lastCrawlHour = parseInt(readFileSync(LAST_CRAWL_FILE, 'utf-8').trim(), 10);
  logger.info({ lastCrawlHour }, 'Restored last crawl hour from disk');
} catch { /* first start */ }

function getEasternHour(date: Date): number {
  return parseInt(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: 'America/New_York' }).format(date),
    10,
  );
}

async function crawlTick(): Promise<void> {
  if (!config.crawl.enabled || crawlRunning) return;

  const now = new Date();
  const currentHour = getEasternHour(now);
  const crawlHours = parseCronHours(config.crawl.schedule);

  if (crawlHours.includes(currentHour) && currentHour !== lastCrawlHour) {
    lastCrawlHour = currentHour;
    try { writeFileSync(LAST_CRAWL_FILE, String(currentHour)); } catch { /* non-critical */ }
    crawlRunning = true;

    logger.info({ hour: currentHour }, 'Master crawl cron firing');
    try {
      const result = await runMasterCrawl({
        lookbackDays: config.crawl.lookbackDays,
        canvasId: process.env.CANVAS_ID ?? '',
        timeoutMs: config.crawl.timeoutMs,
        maxTurns: config.crawl.maxTurns,
      });
      lastCrawlTime = new Date();
      logger.info({ success: result.success, durationMs: result.durationMs }, 'Master crawl finished');
    } catch (err) {
      logger.error({ error: err }, 'Master crawl threw unexpectedly');
    } finally {
      crawlRunning = false;
    }
  }
}

// ── Urgency Check ──

async function urgencyTick(): Promise<void> {
  if (!config.urgencyCheck.enabled) return;
  try {
    await runUrgencyCheck({
      lastCrawlTime,
      keywords: config.urgencyCheck.keywords,
    });
  } catch (err) {
    logger.debug({ error: err }, 'Urgency check failed — non-critical');
  }
}

// ── Start ──

const taskPollMs = config.tasks.schedulerPollMs;
const urgencyMs = config.urgencyCheck.intervalMs;

logger.info({ taskPollMs, urgencyMs, crawlSchedule: config.crawl.schedule }, 'Sidecar starting — task poller + master crawl + urgency check');

// Task poller (every 60s)
setInterval(async () => {
  try {
    await taskTick();
  } catch (err) {
    logger.warn({ error: err }, 'Task tick failed');
  }
}, taskPollMs);

// Master crawl cron check (every 60s — checks if it's time to fire)
setInterval(async () => {
  try {
    await crawlTick();
  } catch (err) {
    logger.warn({ error: err }, 'Crawl tick failed');
  }
}, 60_000);

// Urgency check (every 5 min)
setInterval(async () => {
  try {
    await urgencyTick();
  } catch (err) {
    logger.warn({ error: err }, 'Urgency tick failed');
  }
}, urgencyMs);

// Initial ticks after brief delay
setTimeout(async () => {
  void taskTick().catch(err => logger.warn({ error: err }, 'Initial task tick failed'));

  // Manual crawl trigger: set RUN_CRAWL_NOW=1 env var to fire immediately on startup
  if (process.env.RUN_CRAWL_NOW === '1') {
    logger.info('RUN_CRAWL_NOW=1 detected — triggering immediate crawl');
    crawlRunning = true;
    try {
      const result = await runMasterCrawl({
        lookbackDays: config.crawl.lookbackDays,
        canvasId: process.env.CANVAS_ID ?? '',
        timeoutMs: config.crawl.timeoutMs,
        maxTurns: config.crawl.maxTurns,
      });
      lastCrawlTime = new Date();
      logger.info({ success: result.success, durationMs: result.durationMs }, 'Manual crawl finished');
    } catch (err) {
      logger.error({ error: err }, 'Manual crawl threw unexpectedly');
    } finally {
      crawlRunning = false;
    }
  } else {
    void crawlTick().catch(err => logger.warn({ error: err }, 'Initial crawl tick failed'));
  }
}, 5000);

logger.info('Sidecar running — task poller + master crawl + urgency check');

// Keep alive
process.on('SIGTERM', () => {
  logger.info('Sidecar shutting down');
  process.exit(0);
});
