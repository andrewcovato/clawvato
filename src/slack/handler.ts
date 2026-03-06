/**
 * Slack Event Handler — receives events from Socket Mode and routes them.
 *
 * This module sits between raw Slack events and the agent loop. It:
 * 1. Filters events to owner-only messages (single-principal authority)
 * 2. Routes messages to the EventQueue for accumulation
 * 3. Routes typing events to the EventQueue
 * 4. Manages the reaction lifecycle (⏳ → 🧠 → response)
 * 5. Routes mid-processing messages to the interrupt classifier
 *
 * Socket Mode is used instead of HTTP webhooks because:
 * - No public endpoint needed (local-first architecture)
 * - WebSocket connection is persistent and low-latency
 * - Handles reconnection automatically via @slack/socket-mode
 */

import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { EventQueue, type AccumulatedBatch, type QueuedMessage } from './event-queue.js';

export interface SlackReactionAPI {
  add(channel: string, timestamp: string, reaction: string): Promise<void>;
  remove(channel: string, timestamp: string, reaction: string): Promise<void>;
}

export interface SlackMessageAPI {
  post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  update(channel: string, ts: string, text: string): Promise<void>;
}

export type ProcessingState = 'idle' | 'accumulating' | 'processing';

interface ActiveTask {
  description: string;
  channel: string;
  threadTs?: string;
  ackMessageTs?: string; // The ACK message we can edit for milestone updates
  startedAt: number;
}

/**
 * SlackHandler manages the lifecycle of incoming Slack events.
 *
 * Usage:
 *   const handler = new SlackHandler(reactionAPI, messageAPI);
 *   handler.onBatch(async (batch) => { ... process with agent ... });
 *   handler.handleMessage(event);   // from Socket Mode
 *   handler.handleTyping(event);    // from Socket Mode
 */
export class SlackHandler {
  private queue: EventQueue;
  private reactions: SlackReactionAPI;
  private messages: SlackMessageAPI;
  private batchHandler?: (batch: AccumulatedBatch) => Promise<void>;
  private activeTask: ActiveTask | null = null;
  /** Messages that arrived while agent is processing — checked at PreToolUse checkpoints */
  private interruptBuffer: Array<{ text: string; ts: string }> = [];

  constructor(reactions: SlackReactionAPI, messages: SlackMessageAPI) {
    this.reactions = reactions;
    this.messages = messages;
    this.queue = new EventQueue();

    // When the queue emits a batch, process it
    this.queue.on('batch', (batch: AccumulatedBatch) => {
      void this.processBatch(batch);
    });
  }

  /**
   * Register the batch processing callback (typically the agent loop).
   */
  onBatch(handler: (batch: AccumulatedBatch) => Promise<void>): void {
    this.batchHandler = handler;
  }

  /**
   * Get the event queue (for direct access to mode settings, etc.)
   */
  getQueue(): EventQueue {
    return this.queue;
  }

  /**
   * Get the message API (for posting/updating messages from the orchestrator).
   */
  getMessages(): SlackMessageAPI {
    return this.messages;
  }

  /**
   * Handle an incoming message event from Socket Mode.
   * Only processes messages from the owner.
   */
  async handleMessage(event: {
    text: string;
    channel: string;
    thread_ts?: string;
    user: string;
    ts: string;
  }): Promise<void> {
    const config = getConfig();

    // Single-principal authority: ignore non-owner messages
    if (config.ownerSlackUserId && event.user !== config.ownerSlackUserId) {
      logger.debug(
        { user: event.user, channel: event.channel },
        'Ignoring message from non-owner',
      );
      return;
    }

    const msg: QueuedMessage = {
      text: event.text,
      channel: event.channel,
      threadTs: event.thread_ts,
      userId: event.user,
      ts: event.ts,
      receivedAt: Date.now(),
    };

    // If agent is actively processing on this channel, route to interrupt buffer
    if (this.activeTask && this.activeTask.channel === event.channel) {
      // Only buffer interrupts in the same thread context
      const sameThread =
        (!this.activeTask.threadTs && !event.thread_ts) ||
        this.activeTask.threadTs === event.thread_ts;

      if (sameThread) {
        this.interruptBuffer.push({ text: event.text, ts: event.ts });
        logger.debug(
          { channel: event.channel, bufferSize: this.interruptBuffer.length },
          'Message routed to interrupt buffer',
        );
        // Add ⏳ to show we see it (will be swapped to 👍 when ACK'd)
        try {
          await this.reactions.add(event.channel, event.ts, 'hourglass_flowing_sand');
        } catch {
          // Non-critical
        }
        return;
      }
    }

    // Normal path: add ⏳ reaction and enqueue for accumulation
    try {
      await this.reactions.add(event.channel, event.ts, 'hourglass_flowing_sand');
    } catch {
      // Non-critical — reactions can fail silently
    }

    this.queue.enqueue(msg);
  }

  /**
   * Handle a user_typing event from Socket Mode.
   */
  handleTyping(event: { channel: string; thread_ts?: string; user: string }): void {
    const config = getConfig();
    if (config.ownerSlackUserId && event.user !== config.ownerSlackUserId) return;

    this.queue.handleTyping(event.channel, event.thread_ts);
  }

  /**
   * Check if there's an active task and return it.
   */
  getActiveTask(): ActiveTask | null {
    return this.activeTask;
  }

  /**
   * Set the active task description (called by the agent loop when starting work).
   */
  setActiveTask(description: string, channel: string, threadTs?: string, ackTs?: string): void {
    this.activeTask = {
      description,
      channel,
      threadTs,
      ackMessageTs: ackTs,
      startedAt: Date.now(),
    };
  }

  /**
   * Clear the active task (called when the agent finishes or cancels work).
   */
  clearActiveTask(): void {
    this.activeTask = null;
    this.interruptBuffer = [];
  }

  /**
   * Drain one interrupt from the buffer. Called by PreToolUse hook
   * at checkpoint between tool calls.
   * Returns the interrupt text, or null if no interrupts pending.
   */
  drainInterrupt(): { text: string; ts: string } | null {
    return this.interruptBuffer.shift() ?? null;
  }

  /**
   * Get a read-only view of the interrupt buffer (for testing).
   */
  getInterruptBuffer(): ReadonlyArray<{ text: string; ts: string }> {
    return this.interruptBuffer;
  }

  /**
   * Acknowledge an interrupt message with 👍 (replacing ⏳).
   */
  async ackInterrupt(channel: string, messageTs: string): Promise<void> {
    try {
      await this.reactions.remove(channel, messageTs, 'hourglass_flowing_sand');
    } catch {
      // Non-critical
    }
    try {
      await this.reactions.add(channel, messageTs, 'thumbsup');
    } catch {
      // Non-critical
    }
  }

  /**
   * Update the ACK message with a milestone update.
   * Used for long-running tasks to show progress.
   */
  async updateMilestone(milestoneText: string): Promise<void> {
    if (!this.activeTask?.ackMessageTs) return;

    try {
      await this.messages.update(
        this.activeTask.channel,
        this.activeTask.ackMessageTs,
        milestoneText,
      );
    } catch (error) {
      logger.debug({ error }, 'Failed to update milestone — non-critical');
    }
  }

  /**
   * Shutdown — clear all queues and timers.
   */
  shutdown(): void {
    this.queue.clear();
    this.activeTask = null;
    this.interruptBuffer = [];
    this.queue.removeAllListeners();
  }

  private async processBatch(batch: AccumulatedBatch): Promise<void> {
    // Remove ⏳ from all messages in the batch, add 🧠 to the last one
    for (const msg of batch.messages) {
      try {
        await this.reactions.remove(msg.channel, msg.ts, 'hourglass_flowing_sand');
      } catch {
        // Non-critical
      }
    }

    const lastMsg = batch.messages[batch.messages.length - 1];
    try {
      await this.reactions.add(lastMsg.channel, lastMsg.ts, 'brain');
    } catch {
      // Non-critical
    }

    logger.info(
      { channel: batch.channel, messageCount: batch.messages.length },
      'Processing batch',
    );

    // Call the registered handler
    if (this.batchHandler) {
      try {
        await this.batchHandler(batch);
      } catch (error) {
        logger.error({ error, channel: batch.channel }, 'Batch handler failed');
      }
    }

    // Remove 🧠 when done
    try {
      await this.reactions.remove(lastMsg.channel, lastMsg.ts, 'brain');
    } catch {
      // Non-critical
    }
  }
}
