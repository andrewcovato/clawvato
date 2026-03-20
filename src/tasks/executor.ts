/**
 * Task Executor — bridges scheduled tasks into the agent pipeline.
 *
 * When the scheduler fires a due task, the executor:
 * 1. Builds a synthetic message from the task title + description
 * 2. Assembles context (memory, working context)
 * 3. Routes through the classifier to pick the right model
 * 4. Executes via fast/medium path (same pipeline as Slack messages)
 * 5. Posts results to the task channel and updates the pinned message
 */

import Anthropic from '@anthropic-ai/sdk';
import type { WebClient } from '@slack/web-api';
import type { Sql } from '../db/index.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { NO_RESPONSE } from '../prompts.js';
import { assembleContext } from '../agent/context.js';
import { routeMessage } from '../agent/router.js';
import { executeFastPath } from '../agent/fast-path.js';
import type { ToolHandlerResult } from '../mcp/slack/server.js';
import { getTask, rescheduleRecurring, markCompleted, markFailed } from './store.js';
import type { ScheduledTask } from './store.js';
import type { TaskExecutionResult } from './scheduler.js';
import type { TaskChannelManager } from './channel-manager.js';

export interface TaskExecutorDeps {
  sql: Sql;
  anthropicClient: Anthropic;
  botClient: WebClient;
  fastPathTools: Array<{ definition: Anthropic.Tool; handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> }>;
  channelManager?: TaskChannelManager;
  ownerDmChannel?: string; // fallback if no task channel
  botUserId?: string;
}

/**
 * Execute a scheduled task through the agent pipeline.
 */
export async function executeScheduledTask(
  task: ScheduledTask,
  deps: TaskExecutorDeps,
): Promise<TaskExecutionResult> {
  const config = getConfig();
  const isSpawned = task.spawned_by_task;

  logger.info({ taskId: task.id, title: task.title, spawned: isSpawned }, 'Executing scheduled task');

  // Build the synthetic message
  let message = `[Scheduled Task] ${task.title}`;
  if (task.description) message += `\n\n${task.description}`;
  if (isSpawned) {
    message += '\n\n[SPAWNED TASK — you cannot create new tasks directly. ' +
      'If you need follow-up work done, describe it in your response and it will be proposed to the owner.]';
  }

  // Use the task channel (or owner DM as fallback) as the context channel
  const contextChannel = config.tasks.channelId ?? deps.ownerDmChannel ?? '';

  try {
    // Assemble context — same as a real Slack message
    const context = await assembleContext(
      deps.sql,
      deps.botClient,
      message,
      contextChannel,
      { botUserId: deps.botUserId, ownerUserId: config.ownerSlackUserId },
    );

    // Route to determine model tier
    const routing = await routeMessage(deps.anthropicClient, context.userPrompt);
    const model = routing.decision === 'fast'
      ? config.models.executor
      : config.models.reasoner;

    logger.info({ taskId: task.id, routing: routing.decision, model }, 'Task routed');

    // Execute via fast/medium path (direct API)
    const result = await executeFastPath(
      context.userPrompt,
      context.systemPrompt,
      { client: deps.anthropicClient, db: deps.sql, tools: deps.fastPathTools, model },
    );

    if (result.success && result.response && !result.response.includes(NO_RESPONSE)) {
      // Post result to task channel as a notification message
      const header = task.cron_expression ? `📊 *${task.title}* (${task.cron_expression})` : `📊 *${task.title}*`;
      const fullMessage = `${header}\n\n${result.response}`;

      if (deps.channelManager) {
        await deps.channelManager.postNotification(fullMessage);
      } else if (deps.ownerDmChannel) {
        // Fallback: post to owner DM
        try {
          await deps.botClient.chat.postMessage({
            channel: deps.ownerDmChannel,
            text: fullMessage,
          });
        } catch { /* non-critical */ }
      }

      // Update pin with new run times
      if (task.cron_expression) {
        await rescheduleRecurring(deps.sql, task.id, result.response, task.cron_expression);
        const updatedTask = await getTask(deps.sql, task.id);
        if (updatedTask && deps.channelManager) {
          await deps.channelManager.updateTaskPin(updatedTask);
        }
      } else {
        await markCompleted(deps.sql, task.id, result.response);
        if (deps.channelManager) {
          await deps.channelManager.removeTaskPin(task, 'completed');
        }
      }

      return { success: true, response: result.response };
    }

    // No noteworthy response — still update run times
    if (task.cron_expression) {
      await rescheduleRecurring(deps.sql, task.id, 'No noteworthy findings', task.cron_expression);
      const updatedTask = await getTask(deps.sql, task.id);
      if (updatedTask && deps.channelManager) {
        await deps.channelManager.updateTaskPin(updatedTask);
      }
    } else {
      await markCompleted(deps.sql, task.id, 'Completed — no output');
      if (deps.channelManager) {
        await deps.channelManager.removeTaskPin(task, 'completed');
      }
    }

    return { success: true, response: result.response ?? '' };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: errMsg, taskId: task.id }, 'Task execution failed');

    await markFailed(deps.sql, task.id, errMsg);

    // Notify in task channel
    if (deps.channelManager) {
      await deps.channelManager.postNotification(`⚠️ *Task failed: ${task.title}*\n\nError: ${errMsg.slice(0, 500)}`);
      await deps.channelManager.removeTaskPin(task, 'failed');
    }

    return { success: false, response: '', error: errMsg };
  }
}
