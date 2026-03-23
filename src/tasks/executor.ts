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
import type { Collector } from '../sweeps/types.js';
import { executeSweep } from '../sweeps/executor.js';
import { extractFacts, storeExtractionResult } from '../memory/extractor.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TaskExecutorDeps {
  sql: Sql;
  anthropicClient: Anthropic;
  botClient: WebClient;
  fastPathTools: Array<{ definition: Anthropic.Tool; handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> }>;
  channelManager?: TaskChannelManager;
  ownerDmChannel?: string; // fallback if no task channel
  botUserId?: string;
  /** Registered sweep collectors (populated at startup if sweeps enabled) */
  sweepCollectors?: Collector[];
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

  // ── Sweep task dispatch (bypasses normal timeout — sweeps manage their own) ──
  if (task.title.startsWith('sweep:') && deps.sweepCollectors?.length) {
    return executeSweepTask(task, deps);
  }

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

/**
 * Execute a sweep task — collects from all sources and synthesizes.
 */
async function executeSweepTask(
  task: ScheduledTask,
  deps: TaskExecutorDeps,
): Promise<TaskExecutionResult> {
  const config = getConfig();

  try {
    const result = await executeSweep(deps.sweepCollectors!, {
      sql: deps.sql,
      dataDir: config.dataDir,
      collectOnly: !!process.env.SWEEP_COLLECT_ONLY,
    });

    // Process findings from workspace → extract facts → store to memory
    // Chunk the findings file so each piece fits within Haiku's context window
    const workspaceDir = (result as unknown as Record<string, unknown>).workspaceDir as string | undefined;
    let factsStored = 0;
    if (workspaceDir) {
      const findingsDir = join(workspaceDir, 'findings');
      try {
        const files = readdirSync(findingsDir).filter(f => !f.startsWith('.'));
        for (const fileName of files) {
          const content = readFileSync(join(findingsDir, fileName), 'utf-8').trim();
          if (!content || content.length < 10) continue;

          logger.info({ fileName, contentLength: content.length }, 'Sweep: processing findings file');

          // Split into chunks by ## headers (each section is independent)
          // Fall back to fixed-size chunks if no headers
          const MAX_CHUNK_CHARS = 6_000; // ~1.5K tokens input → Haiku output fits in 8K tokens
          const chunks = chunkByHeaders(content, MAX_CHUNK_CHARS);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            const fileSource = `sweep:${new Date().toISOString().split('T')[0]}:${fileName}:chunk${i + 1}`;
            try {
              const extracted = await extractFacts(deps.anthropicClient, config.models.classifier, chunk, fileSource, deps.sql);
              if (extracted.facts.length > 0) {
                const stored = await storeExtractionResult(deps.sql, extracted, fileSource);
                factsStored += stored.memoriesStored;
                logger.info({ chunk: i + 1, totalChunks: chunks.length, facts: extracted.facts.length, stored: stored.memoriesStored }, 'Sweep: chunk extracted');
              }
            } catch (err) {
              const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
              logger.warn({ error: errMsg, chunk: i + 1 }, 'Sweep: chunk extraction failed — continuing');
            }
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
        logger.warn({ error: errMsg }, 'Sweep: findings extraction failed');
      }
    }

    const summary = `Swept ${result.sourcesSwept} sources, collected ${result.itemsCollected} new items, stored ${factsStored} facts in ${Math.round(result.durationMs / 1000)}s.`;

    // Post result to task channel
    if (deps.channelManager && result.itemsCollected > 0) {
      await deps.channelManager.postNotification(`🔄 *Background sweep complete*\n\n${summary}`);
    }

    // Reschedule if recurring
    if (task.cron_expression) {
      await rescheduleRecurring(deps.sql, task.id, summary, task.cron_expression);
      const updatedTask = await getTask(deps.sql, task.id);
      if (updatedTask && deps.channelManager) {
        await deps.channelManager.updateTaskPin(updatedTask);
      }
    } else {
      await markCompleted(deps.sql, task.id, summary);
    }

    return { success: true, response: summary };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error: errMsg, taskId: task.id }, 'Sweep task failed');
    await markFailed(deps.sql, task.id, errMsg);

    if (deps.channelManager) {
      await deps.channelManager.postNotification(`⚠️ *Sweep failed*\n\nError: ${errMsg.slice(0, 500)}`);
    }

    return { success: false, response: '', error: errMsg };
  }
}

/**
 * Split markdown content into chunks by ## headers, respecting a max size.
 * Each chunk contains one or more sections. If a single section exceeds
 * maxChars, it gets its own chunk.
 */
function chunkByHeaders(content: string, maxChars: number): string[] {
  const sections = content.split(/^(?=## )/m);
  const chunks: string[] = [];
  let current = '';

  for (const section of sections) {
    if (current.length + section.length > maxChars && current.length > 0) {
      chunks.push(current.trim());
      current = section;
    } else {
      current += section;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  // If no headers found, fall back to fixed-size chunks
  if (chunks.length === 0 && content.length > 0) {
    for (let i = 0; i < content.length; i += maxChars) {
      chunks.push(content.slice(i, i + maxChars).trim());
    }
  }

  return chunks;
}
