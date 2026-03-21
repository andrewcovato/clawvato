/**
 * Task Scheduler — polls for due tasks and executes them through the agent pipeline.
 *
 * Runs on a configurable interval (default 60s). Each tick:
 * 1. Finds tasks where next_run_at <= NOW() and status = 'active'
 * 2. Executes them sequentially (maxConcurrentTasks = 1 for safety)
 * 3. Checks for pending approval reminders
 *
 * The scheduler does NOT contain execution logic — it delegates to
 * an injected executeTask callback, keeping the scheduler testable
 * and decoupled from the agent pipeline.
 */

import type { Sql } from '../db/index.js';
import { getConfig } from '../config.js';
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
} from './store.js';

export interface TaskExecutionResult {
  success: boolean;
  response: string;
  error?: string;
}

export interface SchedulerOptions {
  sql: Sql;
  /** Execute a due task — injected from the agent layer */
  executeTask: (task: ScheduledTask) => Promise<TaskExecutionResult>;
  /** Post a reminder for an unapproved task. Optional — uses channelManager if available. */
  postReminder?: (task: ScheduledTask) => Promise<void>;
}

export function startScheduler(opts: SchedulerOptions): { stop: () => void } {
  const config = getConfig();
  const pollMs = config.tasks.schedulerPollMs;

  logger.info({ pollMs }, 'Task scheduler started');

  const timer = setInterval(async () => {
    try {
      await runSchedulerTick(opts);
    } catch (err) {
      logger.warn({ error: err }, 'Scheduler tick failed');
    }
  }, pollMs);

  // Run one tick on startup (after a brief delay to let everything initialize)
  setTimeout(() => void runSchedulerTick(opts).catch(err => {
    logger.warn({ error: err }, 'Initial scheduler tick failed');
  }), 5000);

  return {
    stop: () => {
      clearInterval(timer);
      logger.info('Task scheduler stopped');
    },
  };
}

async function runSchedulerTick(opts: SchedulerOptions): Promise<void> {
  const { sql } = opts;
  const config = getConfig();

  // ── 1. Check for pending approval reminders ──
  try {
    const pendingTasks = await getPendingApprovals(sql, config.tasks.reminderDelayMs);
    for (const task of pendingTasks) {
      try {
        if (opts.postReminder) await opts.postReminder(task);
        await markReminderSent(sql, task.id);
        logger.info({ taskId: task.id, title: task.title }, 'Task approval reminder sent');
      } catch (err) {
        logger.debug({ error: err, taskId: task.id }, 'Failed to send task reminder — non-critical');
      }
    }
  } catch (err) {
    logger.debug({ error: err }, 'Pending approval check failed — non-critical');
  }

  // ── 2. Find and execute due tasks ──
  const dueTasks = await getDueTasks(sql);
  if (dueTasks.length === 0) return;

  logger.info({ count: dueTasks.length }, 'Scheduler found due tasks');

  // Execute sequentially (maxConcurrentTasks = 1 for safety)
  for (const task of dueTasks.slice(0, config.tasks.maxConcurrentTasks)) {
    await markRunning(sql, task.id);

    try {
      // Sweep tasks manage their own timeout — don't wrap in Promise.race
      const isSweep = task.title.startsWith('sweep:');
      const taskPromise = opts.executeTask(task);
      const result = isSweep
        ? await taskPromise
        : await Promise.race([
            taskPromise,
            new Promise<TaskExecutionResult>((_, reject) =>
              setTimeout(() => reject(new Error('Task execution timeout')), config.tasks.taskExecutionTimeoutMs)
            ),
          ]);

      if (result.success) {
        if (task.cron_expression) {
          // Recurring — reschedule
          await rescheduleRecurring(sql, task.id, result.response, task.cron_expression);
          logger.info({ taskId: task.id, title: task.title }, 'Recurring task completed — rescheduled');
        } else {
          // One-shot — mark completed
          await markCompleted(sql, task.id, result.response);
          logger.info({ taskId: task.id, title: task.title }, 'One-shot task completed');
        }
      } else {
        await markFailed(sql, task.id, result.error ?? 'Unknown error');
        logger.warn({ taskId: task.id, title: task.title, error: result.error }, 'Task execution failed');
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await markFailed(sql, task.id, errMsg);
      logger.warn({ taskId: task.id, title: task.title, error: errMsg }, 'Task execution threw');
    }
  }
}
