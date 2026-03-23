#!/usr/bin/env npx tsx
/**
 * Standalone Task Scheduler — sidecar process for CC-Native Engine.
 *
 * Polls the scheduled_tasks table and posts due tasks to Slack.
 * CC picks them up as channel events and handles execution.
 *
 * This replaces the in-process scheduler from the hybrid engine.
 * Instead of calling the agent pipeline directly, it simply posts
 * a message to Slack (the task channel or owner DM), which CC
 * receives as a regular channel event.
 *
 * Also handles:
 * - Sweep task triggering (posts to Slack for CC to handle)
 * - Approval reminders (posts thread replies on pinned task messages)
 * - Recurring task rescheduling
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
  console.error('FATAL: SLACK_BOT_TOKEN required for task scheduler');
  process.exit(1);
}

const slackClient = new WebClient(botToken);

logger.info({ pollMs: config.tasks.schedulerPollMs, taskChannelId }, 'Standalone task scheduler starting');

// ── Post a task to Slack for CC to handle ──

async function postTaskToSlack(task: ScheduledTask): Promise<void> {
  const channel = taskChannelId || ownerUserId;
  if (!channel) {
    logger.warn({ taskId: task.id }, 'No task channel or owner ID — cannot post task');
    return;
  }

  const isSweep = task.title.startsWith('sweep:');

  const text = isSweep
    ? `🔄 *Sweep task due*: ${task.title}\n\nRun the background sweep: collect from all sources, synthesize, and extract facts to memory.`
    : `📋 *Scheduled task due*: ${task.title}\n${task.description ?? ''}\n\nPlease handle this task. If it requires externally-visible actions, report what you recommend and wait for approval.`;

  try {
    await slackClient.chat.postMessage({
      channel,
      text,
      // Post in thread if task has a pinned message
      thread_ts: task.pin_message_ts ?? undefined,
    });
    logger.info({ taskId: task.id, title: task.title, channel }, 'Task posted to Slack for CC');
  } catch (err) {
    logger.error({ error: err, taskId: task.id }, 'Failed to post task to Slack');
    throw err;
  }
}

// ── Scheduler tick ──

async function tick(): Promise<void> {
  // Check for approval reminders
  try {
    const pending = await getPendingApprovals(sql, config.tasks.reminderDelayMs);
    for (const task of pending) {
      try {
        if (task.pin_message_ts && taskChannelId) {
          const reminderText = ownerUserId
            ? `<@${ownerUserId}> Reminder: this task is waiting for your approval.`
            : 'Reminder: this task is waiting for approval.';
          await slackClient.chat.postMessage({
            channel: taskChannelId,
            text: reminderText,
            thread_ts: task.pin_message_ts,
          });
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
      // Post to Slack — CC will pick it up as a channel event
      await postTaskToSlack(task);

      // Mark as completed (the actual execution happens in CC)
      // For recurring tasks, reschedule immediately
      if (task.cron_expression) {
        await rescheduleRecurring(sql, task.id, 'Dispatched to CC via Slack', task.cron_expression);
        logger.info({ taskId: task.id, title: task.title }, 'Recurring task dispatched — rescheduled');
      } else {
        await markCompleted(sql, task.id, 'Dispatched to CC via Slack');
        logger.info({ taskId: task.id, title: task.title }, 'One-shot task dispatched');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await markFailed(sql, task.id, errMsg);
      logger.warn({ taskId: task.id, error: errMsg }, 'Task dispatch failed');
    }
  }
}

// ── Poll loop ──

const pollMs = config.tasks.schedulerPollMs;

setInterval(async () => {
  try {
    await tick();
  } catch (err) {
    logger.warn({ error: err }, 'Scheduler tick failed');
  }
}, pollMs);

// Initial tick after brief delay
setTimeout(() => void tick().catch(err => logger.warn({ error: err }, 'Initial tick failed')), 5000);

logger.info('Standalone task scheduler running');

// Keep alive
process.on('SIGTERM', () => {
  logger.info('Task scheduler shutting down');
  process.exit(0);
});
