/**
 * Task Queue Tools — fast-path tools for managing scheduled tasks.
 *
 * Four tools: list_tasks, create_task, update_task, delete_task.
 * All DB-only — no Slack side effects. Event feed handled by the sidecar.
 */

import type { Sql } from '../db/index.js';
import { getConfig } from '../config.js';
import type { ToolHandlerResult } from '../mcp/slack/server.js';
import type Anthropic from '@anthropic-ai/sdk';
import {
  createTask,
  getTask,
  listTasks,
  updateTask,
  deleteTask,
  findTaskByTitle,
  type ScheduledTask,
  type TaskCreatorType,
} from './store.js';

type FastPathTool = {
  definition: Anthropic.Tool;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
};

/**
 * Parse a relative delay string into milliseconds.
 * Supports: "2 minutes", "3 hours", "1 day", "2 weeks", "30 seconds", etc.
 */
function parseDelay(delay: string): number | null {
  const match = delay.trim().match(/^(\d+(?:\.\d+)?)\s*(second|minute|min|hour|day|week|month)s?$/i);
  if (!match) return null;

  const n = parseFloat(match[1]);
  const unit = match[2].toLowerCase();

  const MS: Record<string, number> = {
    second: 1000,
    minute: 60_000,
    min: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000, // 30 days
  };

  return MS[unit] ? n * MS[unit] : null;
}

export function createTaskTools(sql: Sql): FastPathTool[] {
  /**
   * Resolve a task by ID or title fragment. Handles short ID expansion.
   */
  async function resolveTask(args: Record<string, unknown>): Promise<ScheduledTask | null> {
    let taskId = args.id as string | undefined;
    if (!taskId && args.title_match) {
      const found = await findTaskByTitle(sql, args.title_match as string);
      return found;
    }
    if (!taskId) return null;

    // Short ID expansion
    if (taskId.length < 36) {
      const [match] = await sql`
        SELECT id FROM scheduled_tasks WHERE id LIKE ${taskId + '%'} LIMIT 1
      `;
      if (match) taskId = match.id as string;
    }

    return getTask(sql, taskId);
  }

  return [
    // ── list_tasks ──
    {
      definition: {
        name: 'list_tasks',
        description:
          'List scheduled tasks. Shows active, paused, and pending approval tasks by default.',
        input_schema: {
          type: 'object' as const,
          properties: {
            status: {
              type: 'string',
              description: 'Filter by status: active, paused, pending_approval, completed, failed, cancelled, or "all"',
            },
            limit: { type: 'number', description: 'Max results (default 20)' },
          },
          required: [],
        },
      },
      handler: async (args) => {
        const status = args.status as string | undefined;
        const limit = (args.limit as number) ?? 20;

        const opts = status === 'all'
          ? { limit }
          : status
            ? { status, limit }
            : { limit };

        const tasks = await listTasks(sql, opts);

        if (tasks.length === 0) {
          return { content: status ? `No tasks with status "${status}".` : 'No active tasks.' };
        }

        // Group by status for clean output
        const grouped: Record<string, ScheduledTask[]> = {};
        for (const t of tasks) {
          (grouped[t.status] ??= []).push(t);
        }

        const sections: string[] = [];
        const statusOrder = ['running', 'active', 'pending_approval', 'paused', 'completed', 'failed'];
        const statusEmoji: Record<string, string> = {
          running: '🔄', active: '📋', pending_approval: '⏳', paused: '⏸️',
          completed: '✅', failed: '❌', cancelled: '🚫',
        };

        for (const s of statusOrder) {
          const group = grouped[s];
          if (!group) continue;
          const lines = group.map(t => {
            const schedule = t.cron_expression ? `  ${t.cron_expression}` : t.due_at ? `  due ${new Date(t.due_at).toLocaleDateString()}` : '';
            const nextRun = t.next_run_at ? `  → next: ${new Date(t.next_run_at).toLocaleString()}` : '';
            const lastResult = t.last_error ? `  ⚠️ ${t.last_error.slice(0, 80)}` : '';
            return `  ${statusEmoji[s] ?? '•'} *${t.title}*${schedule}${nextRun}${lastResult}\n    _${t.id.slice(0, 8)}_`;
          });
          sections.push(`*${s.replace('_', ' ').toUpperCase()}*\n${lines.join('\n')}`);
        }

        return { content: `${tasks.length} task(s):\n\n${sections.join('\n\n')}` };
      },
    },

    // ── create_task ──
    {
      definition: {
        name: 'create_task',
        description:
          'Create a scheduled task. For recurring tasks, set cron_expression ("daily", "weekly", "hourly", ' +
          '"every 3 hours", "every 2 days"). For one-shot tasks, set due_at or delay ("2 minutes", "3 hours", "1 day"). ' +
          'IMPORTANT: created_by_type defaults to "owner" — use this when the owner asks you to create a task. ' +
          'Only set created_by_type to "agent" when YOU independently decide to create a task that the owner ' +
          'did NOT explicitly ask for.',
        input_schema: {
          type: 'object' as const,
          properties: {
            title: { type: 'string', description: 'Short task title' },
            description: { type: 'string', description: 'Detailed instructions or context' },
            priority: { type: 'number', description: '1-10, higher = more important (default 5)' },
            due_at: { type: 'string', description: 'ISO datetime deadline for one-shot tasks' },
            next_run_at: { type: 'string', description: 'ISO datetime for first execution' },
            delay: { type: 'string', description: 'Run after this delay: "2 minutes", "3 hours", "1 day", "2 weeks"' },
            cron_expression: { type: 'string', description: '"daily", "daily at 6am", "weekly at 9am", "monthly", "hourly", "every N hours/days"' },
            created_by_type: { type: 'string', enum: ['owner', 'agent'], description: 'Who is creating this (default: owner)' },
            labels: { type: 'array', items: { type: 'string' }, description: 'Tags for organization' },
          },
          required: ['title'],
        },
      },
      handler: async (args) => {
        const config = getConfig();
        const createdByType = (args.created_by_type as TaskCreatorType) ?? 'owner';

        // Check self-assignment config
        if (createdByType === 'agent' && !config.tasks.allowSelfAssignment) {
          return { content: 'Self-assignment is disabled. The owner must create tasks directly.' };
        }

        // Determine approval requirement
        let status: 'active' | 'pending_approval' = 'active';
        if (createdByType === 'agent' && !config.tasks.autoApproveAgentTasks) {
          status = 'pending_approval';
        }

        // Compute next_run_at from delay if provided
        let nextRunAt = args.next_run_at as string | undefined;
        if (!nextRunAt && args.delay) {
          const delayMs = parseDelay(args.delay as string);
          if (delayMs) nextRunAt = new Date(Date.now() + delayMs).toISOString();
        }

        const id = await createTask(sql, {
          title: args.title as string,
          description: args.description as string | undefined,
          priority: args.priority as number | undefined,
          due_at: args.due_at as string | undefined,
          next_run_at: nextRunAt,
          cron_expression: args.cron_expression as string | undefined,
          created_by_type: createdByType,
          labels: args.labels as string[] | undefined,
          status,
        });

        const scheduleInfo = args.cron_expression
          ? ` (${args.cron_expression})`
          : args.delay
            ? ` (in ${args.delay})`
            : args.due_at
              ? ` (due ${args.due_at})`
              : '';

        const approvalNote = status === 'pending_approval' ? ' Pending owner approval.' : '';

        return {
          content: `Task created: "${args.title}"${scheduleInfo}${approvalNote}\nID: ${id.slice(0, 8)}`,
        };
      },
    },

    // ── update_task ──
    {
      definition: {
        name: 'update_task',
        description:
          'Update a task by ID or title fragment. Can change schedule, priority, title, description, or status (active/paused/cancelled).',
        input_schema: {
          type: 'object' as const,
          properties: {
            id: { type: 'string', description: 'Task ID (first 8 chars is enough)' },
            title_match: { type: 'string', description: 'Fuzzy title match if ID not known' },
            title: { type: 'string', description: 'New title' },
            description: { type: 'string', description: 'New description' },
            priority: { type: 'number', description: 'New priority 1-10' },
            cron_expression: { type: 'string', description: 'New schedule' },
            status: { type: 'string', enum: ['active', 'paused', 'cancelled'], description: 'New status' },
          },
          required: [],
        },
      },
      handler: async (args) => {
        const task = await resolveTask(args);
        if (!task) return { content: args.title_match ? `No task found matching "${args.title_match}".` : 'Provide either id or title_match.' };

        const updates: Record<string, unknown> = {};
        if (args.title) updates.title = args.title;
        if (args.description) updates.description = args.description;
        if (args.priority) updates.priority = args.priority;
        if (args.cron_expression !== undefined) updates.cron_expression = args.cron_expression;
        if (args.status) updates.status = args.status;

        if (Object.keys(updates).length === 0) return { content: 'No updates provided.' };

        const updatedTask = await updateTask(sql, task.id, updates as Parameters<typeof updateTask>[2]);
        if (!updatedTask) return { content: `Task ${task.id.slice(0, 8)} not found.` };

        return { content: `Task ${task.id.slice(0, 8)} updated: ${Object.keys(updates).join(', ')}` };
      },
    },

    // ── delete_task ──
    {
      definition: {
        name: 'delete_task',
        description: 'Cancel a task by ID or title fragment.',
        input_schema: {
          type: 'object' as const,
          properties: {
            id: { type: 'string', description: 'Task ID (first 8 chars is enough)' },
            title_match: { type: 'string', description: 'Fuzzy title match if ID not known' },
          },
          required: [],
        },
      },
      handler: async (args) => {
        const task = await resolveTask(args);
        if (!task) return { content: args.title_match ? `No task found matching "${args.title_match}".` : 'Provide either id or title_match.' };

        await deleteTask(sql, task.id);
        return { content: `Task ${task.id.slice(0, 8)} cancelled.` };
      },
    },
  ];
}
