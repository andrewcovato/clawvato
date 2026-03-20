import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestSql } from '../helpers/pg-test.js';
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  findTaskByTitle,
  getDueTasks,
  getPendingApprovals,
  markRunning,
  markCompleted,
  markFailed,
  rescheduleRecurring,
  approveTask,
  markReminderSent,
  updatePinTs,
  computeNextRun,
} from '../../src/tasks/store.js';

describe('task store', () => {
  let sql: TestSql;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ sql, cleanup } = await createTestDb());
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── CRUD ──

  it('creates and retrieves a task', async () => {
    const id = await createTask(sql, { title: 'Test task', description: 'Do the thing' });
    expect(id).toMatch(/^[0-9a-f]{8}-/);

    const task = await getTask(sql, id);
    expect(task).not.toBeNull();
    expect(task!.title).toBe('Test task');
    expect(task!.description).toBe('Do the thing');
    expect(task!.status).toBe('active');
    expect(task!.priority).toBe(5);
    expect(task!.created_by_type).toBe('owner');
  });

  it('creates a recurring task with computed next_run_at', async () => {
    const id = await createTask(sql, { title: 'Daily scan', cron_expression: 'daily' });
    const task = await getTask(sql, id);
    expect(task!.cron_expression).toBe('daily');
    expect(task!.next_run_at).not.toBeNull();
  });

  it('creates a task with delay', async () => {
    const before = Date.now();
    const id = await createTask(sql, {
      title: 'Delayed task',
      next_run_at: new Date(before + 120_000).toISOString(),
    });
    const task = await getTask(sql, id);
    expect(task!.next_run_at).not.toBeNull();
    const runAt = new Date(task!.next_run_at!).getTime();
    expect(runAt).toBeGreaterThan(before);
  });

  it('lists active tasks by default', async () => {
    await createTask(sql, { title: 'Active one' });
    await createTask(sql, { title: 'Cancelled one', status: 'cancelled' });
    await createTask(sql, { title: 'Active two' });

    const tasks = await listTasks(sql);
    expect(tasks.length).toBe(2);
    expect(tasks.map(t => t.title)).toContain('Active one');
    expect(tasks.map(t => t.title)).toContain('Active two');
  });

  it('lists tasks filtered by status', async () => {
    await createTask(sql, { title: 'Active' });
    await createTask(sql, { title: 'Cancelled', status: 'cancelled' });

    const cancelled = await listTasks(sql, { status: 'cancelled' });
    expect(cancelled.length).toBe(1);
    expect(cancelled[0].title).toBe('Cancelled');
  });

  it('updates a task and returns the updated record', async () => {
    const id = await createTask(sql, { title: 'Original', priority: 3 });
    const updated = await updateTask(sql, id, { title: 'Modified', priority: 8 });

    expect(updated).not.toBeNull();
    expect(updated!.title).toBe('Modified');
    expect(updated!.priority).toBe(8);
  });

  it('update recomputes next_run_at when cron changes', async () => {
    const id = await createTask(sql, { title: 'Task', cron_expression: 'daily' });
    const before = await getTask(sql, id);

    const updated = await updateTask(sql, id, { cron_expression: 'weekly' });
    expect(updated!.cron_expression).toBe('weekly');
    // next_run_at should be further out than before
    expect(new Date(updated!.next_run_at!).getTime())
      .toBeGreaterThan(new Date(before!.next_run_at!).getTime());
  });

  it('soft-deletes a task (sets cancelled)', async () => {
    const id = await createTask(sql, { title: 'To delete' });
    const success = await deleteTask(sql, id);
    expect(success).toBe(true);

    const task = await getTask(sql, id);
    expect(task!.status).toBe('cancelled');
  });

  it('findTaskByTitle matches fuzzy', async () => {
    await createTask(sql, { title: 'Daily Competitor News Scan' });
    const found = await findTaskByTitle(sql, 'competitor');
    expect(found).not.toBeNull();
    expect(found!.title).toBe('Daily Competitor News Scan');
  });

  it('findTaskByTitle ignores cancelled tasks', async () => {
    await createTask(sql, { title: 'Old task', status: 'cancelled' });
    const found = await findTaskByTitle(sql, 'Old');
    expect(found).toBeNull();
  });

  // ── Scheduler operations ──

  it('getDueTasks finds tasks with next_run_at in the past', async () => {
    await createTask(sql, {
      title: 'Due now',
      next_run_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await createTask(sql, {
      title: 'Future',
      next_run_at: new Date(Date.now() + 3_600_000).toISOString(),
    });

    const due = await getDueTasks(sql);
    expect(due.length).toBe(1);
    expect(due[0].title).toBe('Due now');
  });

  it('markRunning sets status', async () => {
    const id = await createTask(sql, { title: 'Task' });
    await markRunning(sql, id);
    const task = await getTask(sql, id);
    expect(task!.status).toBe('running');
  });

  it('markCompleted sets result and run_count', async () => {
    const id = await createTask(sql, { title: 'Task' });
    await markCompleted(sql, id, 'Done successfully');
    const task = await getTask(sql, id);
    expect(task!.status).toBe('completed');
    expect(task!.last_result).toBe('Done successfully');
    expect(task!.run_count).toBe(1);
  });

  it('markFailed sets error and run_count', async () => {
    const id = await createTask(sql, { title: 'Task' });
    await markFailed(sql, id, 'Something broke');
    const task = await getTask(sql, id);
    expect(task!.status).toBe('failed');
    expect(task!.last_error).toBe('Something broke');
    expect(task!.run_count).toBe(1);
  });

  it('rescheduleRecurring updates next_run_at and keeps active', async () => {
    const id = await createTask(sql, { title: 'Recurring', cron_expression: 'daily' });
    await markRunning(sql, id);
    await rescheduleRecurring(sql, id, 'Found 3 items', 'daily');

    const task = await getTask(sql, id);
    expect(task!.status).toBe('active');
    expect(task!.run_count).toBe(1);
    expect(task!.last_result).toBe('Found 3 items');
    expect(task!.next_run_at).not.toBeNull();
  });

  // ── Approval ──

  it('approveTask changes status from pending to active', async () => {
    const id = await createTask(sql, { title: 'Pending', status: 'pending_approval' });
    await approveTask(sql, id);
    const task = await getTask(sql, id);
    expect(task!.status).toBe('active');
    expect(task!.approved_at).not.toBeNull();
  });

  it('getPendingApprovals finds old pending tasks', async () => {
    const id = await createTask(sql, { title: 'Old pending', status: 'pending_approval' });
    // Manually backdate created_at
    await sql`UPDATE scheduled_tasks SET created_at = NOW() - interval '2 hours' WHERE id = ${id}`;

    const pending = await getPendingApprovals(sql, 3_600_000); // 1 hour
    expect(pending.length).toBe(1);
    expect(pending[0].title).toBe('Old pending');
  });

  it('markReminderSent prevents duplicate reminders', async () => {
    const id = await createTask(sql, { title: 'Pending', status: 'pending_approval' });
    await sql`UPDATE scheduled_tasks SET created_at = NOW() - interval '2 hours' WHERE id = ${id}`;

    await markReminderSent(sql, id);
    const pending = await getPendingApprovals(sql, 3_600_000);
    expect(pending.length).toBe(0);
  });

  // ── Pin tracking ──

  it('updatePinTs stores the pin message timestamp', async () => {
    const id = await createTask(sql, { title: 'Pinned' });
    await updatePinTs(sql, id, '1234567890.123456');
    const task = await getTask(sql, id);
    expect(task!.pin_message_ts).toBe('1234567890.123456');
  });

  // ── computeNextRun ──

  it('computes daily', () => {
    const now = new Date('2026-03-20T10:00:00');
    const next = computeNextRun('daily', now);
    expect(next!.getDate()).toBe(21);
  });

  it('computes weekly', () => {
    const now = new Date('2026-03-20T10:00:00');
    const next = computeNextRun('weekly', now);
    expect(next!.getDate()).toBe(27);
  });

  it('computes "daily at 6am" — next day if past', () => {
    const now = new Date('2026-03-20T10:00:00');
    const next = computeNextRun('daily at 6am', now);
    expect(next!.getDate()).toBe(21);
    expect(next!.getHours()).toBe(6);
    expect(next!.getMinutes()).toBe(0);
  });

  it('computes "daily at 6am" — today if not yet past', () => {
    const now = new Date('2026-03-20T04:00:00');
    const next = computeNextRun('daily at 6am', now);
    expect(next!.getDate()).toBe(20);
    expect(next!.getHours()).toBe(6);
  });

  it('computes "daily at 2:30pm"', () => {
    const now = new Date('2026-03-20T10:00:00');
    const next = computeNextRun('daily at 2:30pm', now);
    expect(next!.getDate()).toBe(20);
    expect(next!.getHours()).toBe(14);
    expect(next!.getMinutes()).toBe(30);
  });

  it('computes "every 3 hours"', () => {
    const now = new Date('2026-03-20T10:00:00');
    const next = computeNextRun('every 3 hours', now);
    expect(next!.getHours()).toBe(13);
  });

  it('returns null for unrecognized expression', () => {
    const next = computeNextRun('every full moon');
    expect(next).toBeNull();
  });
});
