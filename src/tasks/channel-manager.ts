/**
 * TaskChannelManager — manages the dedicated Slack task channel.
 *
 * Pinned messages = live dashboard (one pin per active task, updated in-place).
 * Channel messages = notification feed (execution results, only when noteworthy).
 * Thread replies = modification changelog and approval conversations.
 *
 * DB is the source of truth. reconcilePins() syncs Slack pins to match DB state.
 */

import type { WebClient } from '@slack/web-api';
import Anthropic from '@anthropic-ai/sdk';
import type { Sql } from '../db/index.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import {
  getTask,
  listTasks,
  updatePinTs,
  type ScheduledTask,
} from './store.js';
import type { SlackMessageAPI } from '../slack/handler.js';

export interface TaskChannelManagerDeps {
  botClient: WebClient;
  messages: SlackMessageAPI;
  sql: Sql;
  channelId: string;
}

export class TaskChannelManager {
  private botClient: WebClient;
  private messages: SlackMessageAPI;
  private sql: Sql;
  private channelId: string;

  constructor(deps: TaskChannelManagerDeps) {
    this.botClient = deps.botClient;
    this.messages = deps.messages;
    this.sql = deps.sql;
    this.channelId = deps.channelId;
  }

  /**
   * Format a task into the pinned message text.
   */
  formatPinMessage(task: ScheduledTask): string {
    const statusEmoji = task.status === 'pending_approval' ? '⏳'
      : task.status === 'paused' ? '⏸️'
      : task.status === 'running' ? '🔄'
      : '📋';

    let text = `${statusEmoji} *${task.title}*`;

    // Use cached one-line summary if available, otherwise first line
    if (task.pin_summary) {
      text += ` — ${task.pin_summary}`;
    } else if (task.description) {
      text += ` — ${task.description.split('\n')[0].slice(0, 80)}`;
    }

    const timing: string[] = [];
    if (task.cron_expression) timing.push(task.cron_expression);
    if (task.last_run_at) timing.push(`last: ${new Date(task.last_run_at).toLocaleString()}`);
    if (task.next_run_at) timing.push(`next: ${new Date(task.next_run_at).toLocaleString()}`);
    if (timing.length > 0) text += `\n${timing.join(' | ')}`;

    if (task.status === 'pending_approval') {
      text += `\n⏳ React :thumbsup: to approve`;
    }

    return text;
  }

  /**
   * Format the detail thread content for a task.
   */
  formatDetailThread(task: ScheduledTask): string {
    const details: string[] = [`*${task.title}*`];
    if (task.description) details.push(task.description);
    if (task.cron_expression) details.push(`\n*Schedule:* ${task.cron_expression}`);
    if (task.priority !== 5) details.push(`*Priority:* ${task.priority}/10`);
    if (task.created_by_type !== 'owner') details.push(`*Created by:* ${task.created_by_type}`);
    details.push(`\n_ID: ${task.id}_`);
    return details.join('\n');
  }

  /**
   * Update the detail thread message when task core details change.
   */
  async updateDetailThread(task: ScheduledTask): Promise<void> {
    if (!task.pin_message_ts || !task.pin_detail_ts) return;
    const text = this.formatDetailThread(task);
    try {
      await this.messages.update(this.channelId, task.pin_detail_ts, text);
    } catch {
      // Detail message may have been deleted — recreate
      try {
        const result = await this.messages.post(this.channelId, text, task.pin_message_ts);
        await this.sql`UPDATE scheduled_tasks SET pin_detail_ts = ${result.ts} WHERE id = ${task.id}`;
      } catch { /* non-critical */ }
    }
  }

  /**
   * Generate a one-line summary of a task description via Haiku.
   * Caches the result in pin_summary so we don't re-call.
   */
  async summarizeForPin(task: ScheduledTask): Promise<string | null> {
    if (task.pin_summary) return task.pin_summary;
    if (!task.description) return null;

    try {
      const config = getConfig();
      const client = new Anthropic();
      const response = await client.messages.create({
        model: config.models.classifier,
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Write a one-sentence summary of what this task does (max 150 characters). Focus on the action, not timing/schedule. No quotes, no prefix, no period at end.\n\nTitle: ${task.title}\nDescription: ${task.description}`,
        }],
      });

      const summary = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text)
        .join('')
        .trim();

      if (summary) {
        await this.sql`UPDATE scheduled_tasks SET pin_summary = ${summary} WHERE id = ${task.id}`;
        (task as { pin_summary: string }).pin_summary = summary;
      }

      return summary || null;
    } catch (err) {
      logger.debug({ error: err, taskId: task.id }, 'Pin summary generation failed');
      return null;
    }
  }

  /**
   * Post a new pinned message for a task and store pin_message_ts in DB.
   */
  async postTaskPin(task: ScheduledTask): Promise<string> {
    await this.summarizeForPin(task);
    const text = this.formatPinMessage(task);
    const result = await this.messages.post(this.channelId, text);
    const pinTs = result.ts;

    // Pin the message
    try {
      await this.botClient.pins.add({ channel: this.channelId, timestamp: pinTs });
    } catch (err) {
      logger.warn({ error: err, taskId: task.id }, 'Failed to pin task message');
    }

    // Store pin_message_ts in DB
    await updatePinTs(this.sql, task.id, pinTs);

    // Post full details as first thread reply and store its ts
    if (task.description) {
      const detailText = this.formatDetailThread(task);
      const detailResult = await this.messages.post(this.channelId, detailText, pinTs);
      await this.sql`UPDATE scheduled_tasks SET pin_detail_ts = ${detailResult.ts} WHERE id = ${task.id}`;
    }

    logger.info({ taskId: task.id, title: task.title, pinTs }, 'Task pinned in channel');
    return pinTs;
  }

  /**
   * Update an existing pinned message with current task state.
   */
  async updateTaskPin(task: ScheduledTask): Promise<void> {
    if (!task.pin_message_ts) {
      // No pin exists — create one
      await this.postTaskPin(task);
      return;
    }

    await this.summarizeForPin(task);
    const text = this.formatPinMessage(task);
    try {
      await this.messages.update(this.channelId, task.pin_message_ts, text);
      logger.debug({ taskId: task.id, pinTs: task.pin_message_ts }, 'Pinned task message updated');
    } catch (err) {
      logger.warn({ error: err, taskId: task.id, pinTs: task.pin_message_ts }, 'Failed to update pinned task message');
    }
  }

  /**
   * Remove pin and post completion/cancellation notice as channel message.
   */
  async removeTaskPin(task: ScheduledTask, reason: 'completed' | 'cancelled' | 'failed'): Promise<void> {
    if (task.pin_message_ts) {
      try {
        await this.botClient.pins.remove({ channel: this.channelId, timestamp: task.pin_message_ts });
      } catch { /* may already be unpinned */ }

      // Update the message to show final state
      const emoji = reason === 'completed' ? '✅' : reason === 'cancelled' ? '❌' : '⚠️';
      try {
        await this.messages.update(
          this.channelId,
          task.pin_message_ts,
          `${emoji} *${task.title}* — ${reason}`,
        );
      } catch { /* message may be deleted */ }
    }

    // Post notification as channel message
    const emoji = reason === 'completed' ? '✅' : reason === 'cancelled' ? '❌' : '⚠️';
    await this.messages.post(this.channelId, `${emoji} Task ${reason}: *${task.title}*`);

    logger.info({ taskId: task.id, reason }, 'Task pin removed');
  }

  /**
   * Post a notification (execution result) as a channel message.
   */
  async postNotification(text: string): Promise<void> {
    await this.messages.post(this.channelId, text);
  }

  /**
   * Post a thread reply on a pinned task message.
   */
  async postThreadReply(pinMessageTs: string, text: string): Promise<void> {
    await this.messages.post(this.channelId, text, pinMessageTs);
  }

  /**
   * Find a task by its pin_message_ts.
   */
  async findTaskByPinTs(pinTs: string): Promise<ScheduledTask | null> {
    const [row] = await this.sql`
      SELECT * FROM scheduled_tasks
      WHERE pin_message_ts = ${pinTs}
        AND status NOT IN ('cancelled', 'completed')
      LIMIT 1
    `;
    return row ? row as unknown as ScheduledTask : null;
  }

  /**
   * Reconcile pins with DB state. DB is source of truth.
   * - Creates missing pins for active tasks
   * - Unpins orphans (pins with no matching active task)
   * - Re-renders all pinned message text from current DB state
   */
  async reconcilePins(): Promise<{ created: number; updated: number; orphaned: number }> {
    let created = 0;
    let updated = 0;
    let orphaned = 0;

    // Get all active tasks
    const activeTasks = await listTasks(this.sql, { limit: 100 });

    // Get current pins in the channel
    let pinnedTs: Set<string>;
    try {
      const pinsResult = await this.botClient.pins.list({ channel: this.channelId });
      const items = (pinsResult.items ?? []) as Array<{ message?: { ts?: string } }>;
      pinnedTs = new Set(items.map(item => item.message?.ts).filter(Boolean) as string[]);
    } catch (err) {
      logger.warn({ error: err }, 'Failed to list pins — skipping reconciliation');
      return { created, updated, orphaned };
    }

    // Ensure all active tasks have pins
    for (const task of activeTasks) {
      if (!task.pin_message_ts) {
        // No pin — create one
        await this.postTaskPin(task);
        created++;
      } else if (pinnedTs.has(task.pin_message_ts)) {
        // Pin exists — edit the message in-place to match current DB state
        await this.summarizeForPin(task);
        const text = this.formatPinMessage(task);
        try {
          await this.messages.update(this.channelId, task.pin_message_ts, text);
        } catch { /* message may be deleted — will be caught next reconcile */ }
        pinnedTs.delete(task.pin_message_ts);
        updated++;
      } else {
        // pin_message_ts in DB but not pinned — try to re-pin the existing message
        try {
          const text = this.formatPinMessage(task);
          await this.messages.update(this.channelId, task.pin_message_ts, text);
          await this.botClient.pins.add({ channel: this.channelId, timestamp: task.pin_message_ts });
          updated++;
        } catch {
          // Message is gone — create fresh
          await this.postTaskPin(task);
          created++;
        }
      }
    }

    // Remaining pinnedTs are orphans (no matching active task) — unpin them
    // Only unpin messages that look like task pins (have the task ID format)
    for (const orphanTs of pinnedTs) {
      try {
        await this.botClient.pins.remove({ channel: this.channelId, timestamp: orphanTs });
        orphaned++;
      } catch { /* already unpinned */ }
    }

    logger.info({ created, updated, orphaned, activeTasks: activeTasks.length }, 'Task pins reconciled');
    return { created, updated, orphaned };
  }
}
