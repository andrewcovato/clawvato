/**
 * Slack Event Handler — receives events from Socket Mode and routes them.
 *
 * This module sits between raw Slack events and the agent loop. It:
 * 1. Filters events to owner-only messages (single-principal authority)
 * 2. Routes messages to the EventQueue for accumulation
 * 3. Routes typing events to the EventQueue
 * 4. Routes mid-processing messages to the interrupt classifier
 *
 * Interaction model: The bot listens to all messages in joined channels,
 * like a human would. No reaction emojis for normal flow — only a delayed
 * status indicator (⏳) if processing takes longer than 60 seconds.
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

/**
 * Assistant thread APIs — provided by Bolt's assistant handler.
 * Only available when processing messages from the assistant panel.
 */
export interface AssistantThreadAPI {
  setStatus: (status: string) => Promise<void>;
  setTitle: (title: string) => Promise<void>;
  say: (text: string) => Promise<void>;
}

export type ProcessingState = 'idle' | 'accumulating' | 'processing';

/** How long before showing a delayed status indicator */
const SLOW_TASK_THRESHOLD_MS = 60_000;

/** Message shown when a task exceeds the slow-task threshold */
const SLOW_TASK_MESSAGE = '\u23f3 Still working on this...';

interface ActiveTask {
  description: string;
  channel: string;
  threadTs?: string;
  ackMessageTs?: string; // Delayed ACK message (only created after SLOW_TASK_THRESHOLD_MS)
  startedAt: number;
  slowTimer?: ReturnType<typeof setTimeout>;
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
  /** Assistant thread API — non-null only during assistant panel message processing */
  private currentAssistantAPI: AssistantThreadAPI | null = null;

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
   * Get the reaction API (for debug/status reactions from the orchestrator).
   */
  getReactions(): SlackReactionAPI {
    return this.reactions;
  }

  /**
   * Handle an incoming message event from Socket Mode.
   * Processes all messages from the owner in any channel the bot is in.
   */
  async handleMessage(event: {
    text: string;
    channel: string;
    thread_ts?: string;
    user: string;
    ts: string;
    channelType?: string;
  }): Promise<void> {
    const config = getConfig();

    // Single-principal authority: block if not configured or non-owner
    if (!config.ownerSlackUserId || event.user !== config.ownerSlackUserId) {
      logger.debug(
        { user: event.user, channel: event.channel },
        'Ignoring message from non-owner',
      );
      return;
    }

    // Debug reaction: 👀 = message received
    try {
      await this.reactions.add(event.channel, event.ts, 'eyes');
    } catch { /* non-critical */ }

    const msg: QueuedMessage = {
      text: event.text,
      channel: event.channel,
      threadTs: event.thread_ts,
      userId: event.user,
      ts: event.ts,
      receivedAt: Date.now(),
      channelType: event.channelType,
    };

    logger.debug(
      { channel: event.channel, channelType: event.channelType, activeTask: !!this.activeTask },
      'handleMessage: owner message received',
    );

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
        return;
      }
    }

    // Enqueue for accumulation
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
   * Get the assistant thread API (non-null only during assistant panel processing).
   * Used by the agent orchestrator to detect assistant mode and send responses.
   */
  getAssistantAPI(): AssistantThreadAPI | null {
    return this.currentAssistantAPI;
  }

  /**
   * Handle a message from the Slack assistant panel.
   *
   * Unlike handleMessage(), this bypasses the EventQueue accumulation window
   * because the assistant panel is a dedicated 1:1 conversation — each message
   * is processed immediately.
   *
   * The assistant-specific APIs (setStatus, setTitle, say) are stored so the
   * agent orchestrator can use them for status updates and responses.
   */
  async handleAssistantMessage(event: {
    text: string;
    channel: string;
    thread_ts?: string;
    user: string;
    ts: string;
    setStatus: (status: string) => Promise<void>;
    setTitle: (title: string) => Promise<void>;
    say: (text: string) => Promise<void>;
  }): Promise<void> {
    const config = getConfig();

    // Single-principal authority: block if not configured or non-owner
    if (!config.ownerSlackUserId || event.user !== config.ownerSlackUserId) {
      logger.debug(
        { user: event.user, channel: event.channel },
        'Ignoring assistant message from non-owner',
      );
      await event.say("I can only assist my owner. Please ask them to help you.");
      return;
    }

    // Set status indicator (assistant panel has its own UI for this)
    try {
      await event.setStatus('Thinking...');
    } catch {
      // Non-critical
    }

    // Build a batch directly — no accumulation window needed for assistant panel
    const batch: AccumulatedBatch = {
      channel: event.channel,
      threadTs: event.thread_ts,
      userId: event.user,
      combinedText: event.text,
      messages: [{
        text: event.text,
        channel: event.channel,
        threadTs: event.thread_ts,
        userId: event.user,
        ts: event.ts,
        receivedAt: Date.now(),
      }],
    };

    // Store assistant API so the agent orchestrator can use it
    this.currentAssistantAPI = {
      setStatus: event.setStatus,
      setTitle: event.setTitle,
      say: event.say,
    };

    if (this.batchHandler) {
      try {
        await this.batchHandler(batch);
      } catch (error) {
        logger.error({ error, channel: event.channel }, 'Assistant batch handler failed');
        try {
          await event.say('Sorry, I hit an error processing your request.');
        } catch {
          // Non-critical
        }
      }
    }

    this.currentAssistantAPI = null;
  }

  /**
   * Check if there's an active task and return it.
   */
  getActiveTask(): ActiveTask | null {
    return this.activeTask;
  }

  /**
   * Set the active task description (called by the agent loop when starting work).
   * Starts a delayed timer — if the task takes longer than SLOW_TASK_THRESHOLD_MS,
   * a status indicator is shown.
   */
  setActiveTask(description: string, channel: string, threadTs?: string): void {
    const slowTimer = setTimeout(() => {
      void this.showSlowTaskIndicator();
    }, SLOW_TASK_THRESHOLD_MS);

    this.activeTask = {
      description,
      channel,
      threadTs,
      startedAt: Date.now(),
      slowTimer,
    };
  }

  /**
   * Clear the active task (called when the agent finishes or cancels work).
   */
  clearActiveTask(): void {
    logger.info(
      { hadTask: !!this.activeTask, droppedInterrupts: this.interruptBuffer.length },
      'Clearing active task',
    );
    if (this.activeTask?.slowTimer) {
      clearTimeout(this.activeTask.slowTimer);
    }
    this.activeTask = null;
    this.interruptBuffer = [];
  }

  /**
   * Get the ACK message timestamp (for updating with final response).
   * Only set if the task took long enough to trigger the slow indicator.
   */
  getAckTs(): string | undefined {
    return this.activeTask?.ackMessageTs;
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
   * Acknowledge an interrupt message with 👍.
   */
  async ackInterrupt(channel: string, messageTs: string): Promise<void> {
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
    if (this.activeTask?.slowTimer) {
      clearTimeout(this.activeTask.slowTimer);
    }
    this.activeTask = null;
    this.interruptBuffer = [];
    this.queue.removeAllListeners();
  }

  /**
   * Show a delayed status indicator for slow tasks.
   * Only fires if the task is still running after SLOW_TASK_THRESHOLD_MS.
   */
  private async showSlowTaskIndicator(): Promise<void> {
    if (!this.activeTask) return;

    logger.info(
      { channel: this.activeTask.channel, elapsed: Date.now() - this.activeTask.startedAt },
      'Task taking long — showing status indicator',
    );

    // Post a status message and store the ts for milestone updates
    try {
      const lastMsg = this.activeTask;
      const ackResult = await this.messages.post(
        lastMsg.channel,
        SLOW_TASK_MESSAGE,
        lastMsg.threadTs,
      );
      if (this.activeTask) {
        this.activeTask.ackMessageTs = ackResult.ts;
      }
    } catch {
      // Non-critical
    }
  }

  private async processBatch(batch: AccumulatedBatch): Promise<void> {
    logger.info(
      { channel: batch.channel, messageCount: batch.messages.length },
      'Processing batch',
    );

    // Call the registered handler — no reaction ceremony
    if (this.batchHandler) {
      try {
        await this.batchHandler(batch);
      } catch (error) {
        logger.error({ error, channel: batch.channel }, 'Batch handler failed');
      }
    }
  }
}
