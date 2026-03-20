/**
 * Task Store — CRUD operations for the scheduled_tasks table.
 *
 * All functions take a postgres Sql instance so they're testable
 * without global state. Uses snake_case interfaces to match Postgres columns.
 */

import type { Sql } from '../db/index.js';
import { generateId } from '../db/index.js';
import { logger } from '../logger.js';

// ── Types ──

export type TaskStatus = 'active' | 'paused' | 'running' | 'completed' | 'failed' | 'cancelled' | 'pending_approval';
export type TaskCreatorType = 'owner' | 'agent' | 'user' | 'system' | 'external';

export interface ScheduledTask {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  due_at: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  cron_expression: string | null;
  created_by_type: TaskCreatorType;
  created_by_id: string | null;
  spawned_by_task: boolean;
  external_id: string | null;
  external_source: string | null;
  labels: string; // JSON array
  run_count: number;
  last_result: string | null;
  last_error: string | null;
  pin_message_ts: string | null;
  pin_detail_ts: string | null;
  pin_summary: string | null;
  approved_at: string | null;
  approval_slack_ts: string | null;
  approval_channel: string | null;
  reminder_sent: boolean;
  created_at: string;
  updated_at: string;
}

export interface NewTask {
  title: string;
  description?: string;
  priority?: number;
  due_at?: string;
  next_run_at?: string;
  cron_expression?: string;
  created_by_type?: TaskCreatorType;
  created_by_id?: string;
  spawned_by_task?: boolean;
  labels?: string[];
  external_id?: string;
  external_source?: string;
  status?: TaskStatus;
}

// ── CRUD ──

export async function createTask(sql: Sql, task: NewTask): Promise<string> {
  const id = generateId();
  const labels = JSON.stringify(task.labels ?? []);

  // Compute next_run_at from cron_expression if not explicitly set
  let nextRunAt = task.next_run_at ?? null;
  if (!nextRunAt && task.cron_expression) {
    const computed = computeNextRun(task.cron_expression);
    nextRunAt = computed?.toISOString() ?? null;
  }
  // For one-shot tasks with due_at but no next_run_at, run at due_at
  if (!nextRunAt && task.due_at) {
    nextRunAt = task.due_at;
  }

  await sql`
    INSERT INTO scheduled_tasks (
      id, title, description, status, priority,
      due_at, next_run_at, cron_expression,
      created_by_type, created_by_id, spawned_by_task,
      external_id, external_source, labels
    ) VALUES (
      ${id}, ${task.title}, ${task.description ?? null},
      ${task.status ?? 'active'}, ${task.priority ?? 5},
      ${task.due_at ?? null}, ${nextRunAt},
      ${task.cron_expression ?? null},
      ${task.created_by_type ?? 'owner'}, ${task.created_by_id ?? null},
      ${task.spawned_by_task ?? false},
      ${task.external_id ?? null}, ${task.external_source ?? null},
      ${labels}
    )
  `;

  logger.info({ id, title: task.title, status: task.status ?? 'active', cron: task.cron_expression }, 'Task created');
  return id;
}

export async function getTask(sql: Sql, id: string): Promise<ScheduledTask | null> {
  const [row] = await sql`SELECT * FROM scheduled_tasks WHERE id = ${id}`;
  return row ? row as unknown as ScheduledTask : null;
}

export async function listTasks(
  sql: Sql,
  opts?: { status?: string; limit?: number; created_by_type?: string },
): Promise<ScheduledTask[]> {
  const limit = opts?.limit ?? 50;

  if (opts?.status && opts?.created_by_type) {
    return await sql`
      SELECT * FROM scheduled_tasks
      WHERE status = ${opts.status} AND created_by_type = ${opts.created_by_type}
      ORDER BY priority DESC, created_at DESC LIMIT ${limit}
    ` as unknown as ScheduledTask[];
  } else if (opts?.status) {
    return await sql`
      SELECT * FROM scheduled_tasks WHERE status = ${opts.status}
      ORDER BY priority DESC, created_at DESC LIMIT ${limit}
    ` as unknown as ScheduledTask[];
  } else if (opts?.created_by_type) {
    return await sql`
      SELECT * FROM scheduled_tasks WHERE created_by_type = ${opts.created_by_type}
      ORDER BY priority DESC, created_at DESC LIMIT ${limit}
    ` as unknown as ScheduledTask[];
  }

  // Default: show active + paused + pending_approval (not completed/cancelled/failed)
  return await sql`
    SELECT * FROM scheduled_tasks
    WHERE status IN ('active', 'paused', 'pending_approval', 'running')
    ORDER BY priority DESC, created_at DESC LIMIT ${limit}
  ` as unknown as ScheduledTask[];
}

export async function updatePinTs(sql: Sql, id: string, pinTs: string): Promise<void> {
  await sql`UPDATE scheduled_tasks SET pin_message_ts = ${pinTs}, updated_at = NOW() WHERE id = ${id}`;
}

export async function updateTask(
  sql: Sql,
  id: string,
  updates: Partial<Pick<ScheduledTask, 'title' | 'description' | 'status' | 'priority' | 'due_at' | 'cron_expression' | 'labels'>>,
): Promise<ScheduledTask | null> {
  const task = await getTask(sql, id);
  if (!task) return null;

  // Recompute next_run_at if cron_expression changed
  let nextRunAt: string | null | undefined;
  if (updates.cron_expression !== undefined) {
    if (updates.cron_expression) {
      const computed = computeNextRun(updates.cron_expression);
      nextRunAt = computed?.toISOString() ?? null;
    } else {
      nextRunAt = null; // cron cleared — becomes one-shot
    }
  }

  await sql`
    UPDATE scheduled_tasks SET
      title = COALESCE(${updates.title ?? null}, title),
      description = COALESCE(${updates.description ?? null}, description),
      status = COALESCE(${updates.status ?? null}, status),
      priority = COALESCE(${updates.priority ?? null}, priority),
      due_at = COALESCE(${updates.due_at ?? null}, due_at),
      cron_expression = COALESCE(${updates.cron_expression ?? null}, cron_expression),
      labels = COALESCE(${updates.labels ? JSON.stringify(updates.labels) : null}, labels),
      next_run_at = COALESCE(${nextRunAt ?? null}, next_run_at),
      updated_at = NOW()
    WHERE id = ${id}
  `;

  logger.info({ id, updates: Object.keys(updates) }, 'Task updated');
  return getTask(sql, id);
}

export async function deleteTask(sql: Sql, id: string): Promise<boolean> {
  const result = await sql`
    UPDATE scheduled_tasks SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${id} AND status != 'cancelled'
  `;
  return Number(result.count ?? 0) > 0;
}

export async function findTaskByTitle(sql: Sql, fragment: string): Promise<ScheduledTask | null> {
  const [row] = await sql`
    SELECT * FROM scheduled_tasks
    WHERE title ILIKE ${`%${fragment}%`}
      AND status NOT IN ('cancelled', 'completed')
    ORDER BY updated_at DESC LIMIT 1
  `;
  return row ? row as unknown as ScheduledTask : null;
}

// ── Scheduler operations ──

export async function getDueTasks(sql: Sql): Promise<ScheduledTask[]> {
  return await sql`
    SELECT * FROM scheduled_tasks
    WHERE status = 'active'
      AND next_run_at IS NOT NULL
      AND next_run_at <= NOW()
    ORDER BY priority DESC, next_run_at ASC
  ` as unknown as ScheduledTask[];
}

export async function getPendingApprovals(sql: Sql, olderThanMs: number): Promise<ScheduledTask[]> {
  const cutoff = new Date(Date.now() - olderThanMs).toISOString();
  return await sql`
    SELECT * FROM scheduled_tasks
    WHERE status = 'pending_approval'
      AND reminder_sent = false
      AND created_at < ${cutoff}
  ` as unknown as ScheduledTask[];
}

export async function markRunning(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE scheduled_tasks SET status = 'running', updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function markCompleted(sql: Sql, id: string, result: string): Promise<void> {
  await sql`
    UPDATE scheduled_tasks SET
      status = 'completed',
      last_run_at = NOW(),
      last_result = ${result.slice(0, 10_000)},
      run_count = run_count + 1,
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function markFailed(sql: Sql, id: string, error: string): Promise<void> {
  await sql`
    UPDATE scheduled_tasks SET
      status = 'failed',
      last_run_at = NOW(),
      last_error = ${error.slice(0, 5_000)},
      run_count = run_count + 1,
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function rescheduleRecurring(sql: Sql, id: string, result: string, cronExpression: string): Promise<void> {
  const nextRun = computeNextRun(cronExpression);
  await sql`
    UPDATE scheduled_tasks SET
      status = 'active',
      last_run_at = NOW(),
      next_run_at = ${nextRun?.toISOString() ?? null},
      last_result = ${result.slice(0, 10_000)},
      run_count = run_count + 1,
      updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function approveTask(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE scheduled_tasks SET
      status = 'active',
      approved_at = NOW(),
      updated_at = NOW()
    WHERE id = ${id}
  `;
  logger.info({ id }, 'Task approved');
}

export async function markReminderSent(sql: Sql, id: string): Promise<void> {
  await sql`
    UPDATE scheduled_tasks SET reminder_sent = true, updated_at = NOW()
    WHERE id = ${id}
  `;
}

// ── Schedule computation ──

/**
 * Parse a time string like "6am", "6:30am", "14:00", "2pm" into hours and minutes.
 */
function parseTime(timeStr: string): { hours: number; minutes: number } | null {
  // "6am", "6:30am", "6:30pm", "14:00", "2pm"
  const match = timeStr.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!match) return null;

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2] ?? '0', 10);
  const ampm = match[3]?.toLowerCase();

  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return { hours, minutes };
}

/**
 * Compute the next run time from a cron expression.
 * Supports:
 * - Simple keywords: daily, weekly, monthly, hourly
 * - With time: "daily at 6am", "daily at 8:30am", "weekly at 9am"
 * - Intervals: "every 3 hours", "every 2 days"
 */
export function computeNextRun(cronExpression: string, fromDate?: Date): Date | null {
  const now = fromDate ?? new Date();
  const expr = cronExpression.toLowerCase().trim();

  // "daily at 6am", "daily at 8:30am", "weekly at 9am", etc.
  const atMatch = expr.match(/^(daily|weekly|monthly)\s+at\s+(.+)$/);
  if (atMatch) {
    const period = atMatch[1];
    const time = parseTime(atMatch[2].trim());
    if (!time) {
      logger.warn({ cronExpression }, 'Could not parse time in cron expression');
      return null;
    }

    const next = new Date(now);
    next.setHours(time.hours, time.minutes, 0, 0);

    // If that time already passed today, move to next period
    if (next <= now) {
      if (period === 'daily') next.setDate(next.getDate() + 1);
      else if (period === 'weekly') next.setDate(next.getDate() + 7);
      else if (period === 'monthly') next.setMonth(next.getMonth() + 1);
    }
    return next;
  }

  if (expr === 'hourly') {
    return new Date(now.getTime() + 60 * 60 * 1000);
  }
  if (expr === 'daily') {
    const next = new Date(now);
    next.setDate(next.getDate() + 1);
    return next;
  }
  if (expr === 'weekly') {
    const next = new Date(now);
    next.setDate(next.getDate() + 7);
    return next;
  }
  if (expr === 'monthly') {
    const next = new Date(now);
    next.setMonth(next.getMonth() + 1);
    return next;
  }

  // "every N hours/days/minutes" pattern
  const everyMatch = expr.match(/^every\s+(\d+)\s+(hour|day|minute|min)s?$/);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2];
    const ms = unit === 'day' ? n * 24 * 60 * 60 * 1000
      : unit === 'hour' ? n * 60 * 60 * 1000
      : n * 60 * 1000; // minute/min
    return new Date(now.getTime() + ms);
  }

  logger.warn({ cronExpression }, 'Unrecognized cron expression — task will not auto-schedule');
  return null;
}
