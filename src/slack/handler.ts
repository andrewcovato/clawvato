/**
 * Slack Event Handler — receives events from Socket Mode and routes them.
 *
 * This module sits between raw Slack events and the agent loop. It:
 * 1. Filters events to owner-only messages (single-principal authority)
 * 2. Routes messages to the EventQueue for accumulation
 * 3. Routes typing events to the EventQueue
 * 4. Routes mid-processing messages to the interrupt classifier
 *
 * Reaction lifecycle (production UX, not debug):
 *   Message arrives              → 👀 (I see it, accumulating)
 *   Accumulation window closes   → remove 👀, add 🧠, post status message
 *   Tool-call boundaries         → update status message with real progress
 *   Every 60s without update     → refresh status with elapsed time
 *   Task complete                → remove 🧠, delete status message, post response
 *   Cancel acknowledged          → remove 🧠, delete status message, ✅ on cancel
 */

import { logger } from '../logger.js';
import { getConfig, type ClawvatoConfig } from '../config.js';
import { EventQueue, type AccumulatedBatch, type QueuedMessage } from './event-queue.js';

export interface SlackReactionAPI {
  add(channel: string, timestamp: string, reaction: string): Promise<void>;
  remove(channel: string, timestamp: string, reaction: string): Promise<void>;
}

export interface SlackMessageAPI {
  post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  update(channel: string, ts: string, text: string): Promise<void>;
  delete(channel: string, ts: string): Promise<void>;
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

// Progress timing loaded from config (slack.progressDelayMs, slack.progressStaleIntervalMs)

interface ActiveTask {
  description: string;
  channel: string;
  threadTs?: string;
  /** The 👀-reacted message timestamps (for cleanup) */
  eyesMessageTs: string[];
  /** Status/progress message posted after getConfig().slack.progressDelayMs */
  progressMessageTs?: string;
  /** Last progress text (to avoid redundant updates) */
  lastProgressText?: string;
  /** Queued progress text from tool calls that arrived before the delay expired */
  pendingProgressText?: string;
  startedAt: number;
  lastUpdatedAt: number;
  /** Timer that posts the progress message after getConfig().slack.progressDelayMs */
  progressDelayTimer?: ReturnType<typeof setTimeout>;
  /** Timer that fires when progress becomes stale (no tool-call update for 60s) */
  staleTimer?: ReturnType<typeof setTimeout>;
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
  /** Serialization chain — prevents concurrent processBatch calls from corrupting shared state */
  private processingChain: Promise<void> = Promise.resolve();

  constructor(reactions: SlackReactionAPI, messages: SlackMessageAPI) {
    this.reactions = reactions;
    this.messages = messages;
    this.queue = new EventQueue();

    // When the queue emits a batch, serialize processing to avoid shared state corruption
    // (activeTask, interruptBuffer, and currentAssistantAPI are single-slot shared state)
    this.queue.on('batch', (batch: AccumulatedBatch) => {
      this.processingChain = this.processingChain
        .then(() => this.processBatch(batch))
        .catch(err => logger.error({ err }, 'Serialized processBatch failed'));
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
   * Get the reaction API (for status reactions from the orchestrator).
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

    // 👀 = I see your message (will be removed when processing starts)
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
   * Start processing a batch — transitions from accumulating to processing.
   *
   * Handles the full reaction lifecycle transition:
   *   - Removes 👀 from all accumulated messages
   *   - Adds 🧠 to the last message
   *   - Posts a progress status message
   *   - Starts the stale-progress timer
   */
  async startProcessing(
    description: string,
    channel: string,
    messageTimestamps: string[],
    threadTs?: string,
  ): Promise<void> {
    // Remove 👀 from all accumulated messages
    for (const ts of messageTimestamps) {
      try {
        await this.reactions.remove(channel, ts, 'eyes');
      } catch { /* may not exist */ }
    }

    // Add 🧠 to the last message
    const lastTs = messageTimestamps[messageTimestamps.length - 1];
    if (lastTs) {
      try {
        await this.reactions.add(channel, lastTs, 'brain');
      } catch { /* non-critical */ }
    }

    // Delay the progress message — quick responses (< 20s) never show it.
    // The 🧠 reaction is immediate feedback; the message only appears for longer tasks.
    const now = Date.now();
    const progressDelayTimer = setTimeout(() => {
      void this.postProgressMessage();
    }, getConfig().slack.progressDelayMs);

    this.activeTask = {
      description,
      channel,
      threadTs,
      eyesMessageTs: messageTimestamps,
      startedAt: now,
      lastUpdatedAt: now,
      progressDelayTimer,
    };
  }

  /**
   * Post the progress message after the delay expires.
   * Uses any pending progress text from tool calls, or falls back to generic.
   */
  private async postProgressMessage(): Promise<void> {
    if (!this.activeTask) return;

    const text = this.activeTask.pendingProgressText
      ?? `\u{1f9e0} Working on it...`;

    try {
      const result = await this.messages.post(
        this.activeTask.channel,
        text,
        this.activeTask.threadTs,
      );
      this.activeTask.progressMessageTs = result.ts;
      this.activeTask.lastProgressText = text;
      this.activeTask.pendingProgressText = undefined;
    } catch {
      // Non-critical
    }

    // Start the stale-progress refresh timer
    this.activeTask.staleTimer = setTimeout(() => {
      void this.refreshStaleProgress();
    }, getConfig().slack.progressStaleIntervalMs);
  }

  /**
   * Update the progress message with what the agent is actually doing.
   * Called at tool-call boundaries by the agent loop.
   *
   * If the progress message hasn't been posted yet (delay hasn't fired),
   * queues the text so it appears when the message is eventually posted.
   */
  async updateProgress(text: string): Promise<void> {
    if (!this.activeTask) return;

    const progressText = `\u{1f9e0} ${text}`;

    // If progress message hasn't been posted yet, queue the text
    if (!this.activeTask.progressMessageTs) {
      this.activeTask.pendingProgressText = progressText;
      return;
    }

    // Skip redundant updates
    if (progressText === this.activeTask.lastProgressText) return;

    try {
      await this.messages.update(
        this.activeTask.channel,
        this.activeTask.progressMessageTs,
        progressText,
      );
      this.activeTask.lastProgressText = progressText;
      this.activeTask.lastUpdatedAt = Date.now();

      // Reset the stale timer
      if (this.activeTask.staleTimer) {
        clearTimeout(this.activeTask.staleTimer);
      }
      this.activeTask.staleTimer = setTimeout(() => {
        void this.refreshStaleProgress();
      }, getConfig().slack.progressStaleIntervalMs);
    } catch (error) {
      logger.debug({ error }, 'Failed to update progress — non-critical');
    }
  }

  /**
   * Complete processing — clean up reactions and progress message.
   * Returns the progress message ts so the agent can decide whether to
   * update it with the final response or delete it and post fresh.
   */
  async completeProcessing(): Promise<void> {
    if (!this.activeTask) return;

    const { channel, progressMessageTs, eyesMessageTs } = this.activeTask;

    // Remove 🧠 from the last message
    const lastTs = eyesMessageTs[eyesMessageTs.length - 1];
    if (lastTs) {
      try {
        await this.reactions.remove(channel, lastTs, 'brain');
      } catch { /* may not exist */ }
    }

    // Delete the progress message (the real response will be posted separately)
    if (progressMessageTs) {
      try {
        await this.messages.delete(channel, progressMessageTs);
      } catch { /* non-critical */ }
    }

    // Clear timers and state
    if (this.activeTask.progressDelayTimer) {
      clearTimeout(this.activeTask.progressDelayTimer);
    }
    if (this.activeTask.staleTimer) {
      clearTimeout(this.activeTask.staleTimer);
    }

    logger.info(
      { hadTask: true, droppedInterrupts: this.interruptBuffer.length },
      'Processing complete',
    );

    this.activeTask = null;
    this.interruptBuffer = [];
  }

  /**
   * Get the progress message ts (for updating with final response on cancel/redirect).
   */
  getProgressMessageTs(): string | undefined {
    return this.activeTask?.progressMessageTs;
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
   * Shutdown — clear all queues and timers.
   */
  shutdown(): void {
    this.queue.clear();
    if (this.activeTask?.progressDelayTimer) {
      clearTimeout(this.activeTask.progressDelayTimer);
    }
    if (this.activeTask?.staleTimer) {
      clearTimeout(this.activeTask.staleTimer);
    }
    this.activeTask = null;
    this.interruptBuffer = [];
    this.queue.removeAllListeners();
  }

  /**
   * Refresh progress message when no tool-call update has happened for 60s.
   * Shows elapsed time so the user knows the bot is still alive.
   */
  private async refreshStaleProgress(): Promise<void> {
    if (!this.activeTask?.progressMessageTs) return;

    const elapsed = Math.round((Date.now() - this.activeTask.startedAt) / 1000);
    const elapsedStr = elapsed >= 120
      ? `${Math.round(elapsed / 60)}m`
      : `${elapsed}s`;

    const description = this.activeTask.description.slice(0, 80);
    const text = `\u{1f9e0} Still working — ${description} (${elapsedStr})`;

    try {
      await this.messages.update(
        this.activeTask.channel,
        this.activeTask.progressMessageTs,
        text,
      );
      this.activeTask.lastProgressText = text;
    } catch { /* non-critical */ }

    // Schedule next refresh
    this.activeTask.staleTimer = setTimeout(() => {
      void this.refreshStaleProgress();
    }, getConfig().slack.progressStaleIntervalMs);
  }

  private async processBatch(batch: AccumulatedBatch): Promise<void> {
    logger.info(
      { channel: batch.channel, messageCount: batch.messages.length },
      'Processing batch',
    );

    if (this.batchHandler) {
      try {
        await this.batchHandler(batch);
      } catch (error) {
        logger.error({ error, channel: batch.channel }, 'Batch handler failed');
      }
    }
  }
}
