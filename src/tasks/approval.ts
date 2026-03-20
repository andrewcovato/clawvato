/**
 * Task Approval — handles approval reactions on pinned task messages.
 *
 * When a task is pending_approval, the owner can:
 * - 👍 on the pinned message to approve
 * - Reply in thread to discuss/modify
 *
 * The pinned message itself serves as the approval surface —
 * no separate proposal message needed.
 */

import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { approveTask, getTask } from './store.js';
import type { TaskChannelManager } from './channel-manager.js';

/**
 * Handle a thumbs-up reaction on a message.
 * Checks if the message corresponds to a pending task's pinned message.
 */
export async function handleApprovalReaction(
  sql: Sql,
  channel: string,
  messageTs: string,
  channelManager?: TaskChannelManager,
): Promise<void> {
  // Find a pending task with this pin_message_ts
  const [task] = await sql`
    SELECT id, title FROM scheduled_tasks
    WHERE pin_message_ts = ${messageTs}
      AND status = 'pending_approval'
    LIMIT 1
  `;

  if (!task) return; // Not a pending task pin

  await approveTask(sql, task.id as string);

  // Update the pinned message to remove approval indicator
  if (channelManager) {
    const updatedTask = await getTask(sql, task.id as string);
    if (updatedTask) {
      await channelManager.updateTaskPin(updatedTask);
    }
  }

  logger.info({ taskId: task.id, title: task.title }, 'Task approved via reaction');
}
