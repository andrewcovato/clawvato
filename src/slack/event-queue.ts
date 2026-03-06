/**
 * Slack Event Queue — the heart of the fluid interaction model.
 *
 * Instead of processing each Slack message immediately, messages are buffered
 * with a debounce timer. This handles natural conversation patterns:
 *
 *   "schedule a meeting with sarah"   → buffer
 *   (1.5s later) "include the Q3 deck" → buffer, timer resets
 *   (4s quiet)                         → process both together
 *
 * The accumulation window respects `user_typing` events from Slack's Socket Mode.
 * While the owner is typing, the timer stays reset. Processing only begins when
 * both the timer expires AND no typing events have arrived recently.
 *
 * Three user-tunable modes:
 *   Snappy (2s)  — for quick commands
 *   Patient (4s) — default
 *   Wait for me (15s) — user is multitasking
 *
 * Hard cap at 30s to prevent indefinite waiting.
 */

import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';

export type AccumulationMode = 'snappy' | 'patient' | 'wait_for_me';

const WINDOW_MS: Record<AccumulationMode, number> = {
  snappy: 2000,
  patient: 4000,
  wait_for_me: 15000,
};

const HARD_CAP_MS = 30_000;

// Typing events fire every ~3s; we wait slightly longer to detect the gap.
const TYPING_GRACE_MS = 4000;

export interface QueuedMessage {
  text: string;
  channel: string;
  threadTs?: string;
  userId: string;
  ts: string; // Slack message timestamp
  receivedAt: number; // Date.now()
}

export interface AccumulatedBatch {
  messages: QueuedMessage[];
  channel: string;
  threadTs?: string;
  userId: string;
  /** The combined text of all messages in the batch */
  combinedText: string;
}

/**
 * Conversation key — groups messages by (channel, threadTs) pair.
 * Thread replies accumulate separately from top-level channel messages.
 */
function conversationKey(channel: string, threadTs?: string): string {
  return threadTs ? `${channel}:${threadTs}` : channel;
}

/**
 * EventQueue manages the accumulation window for incoming Slack messages.
 *
 * Events emitted:
 *   'batch' — an AccumulatedBatch is ready for processing
 */
export class EventQueue extends EventEmitter {
  private buffers = new Map<string, QueuedMessage[]>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private hardCapTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private lastTypingAt = new Map<string, number>();
  private mode: AccumulationMode = 'patient';

  get windowMs(): number {
    return WINDOW_MS[this.mode];
  }

  setMode(mode: AccumulationMode): void {
    this.mode = mode;
    logger.info({ mode, windowMs: WINDOW_MS[mode] }, 'Accumulation mode changed');
  }

  getMode(): AccumulationMode {
    return this.mode;
  }

  /**
   * Enqueue a message from Slack. Starts or resets the accumulation timer
   * for this conversation.
   */
  enqueue(msg: QueuedMessage): void {
    const key = conversationKey(msg.channel, msg.threadTs);

    // Initialize buffer if needed
    if (!this.buffers.has(key)) {
      this.buffers.set(key, []);
    }
    this.buffers.get(key)!.push(msg);

    logger.debug(
      { key, queueSize: this.buffers.get(key)!.length, mode: this.mode },
      'Message enqueued',
    );

    // Start hard cap timer on first message in this conversation
    if (!this.hardCapTimers.has(key)) {
      this.hardCapTimers.set(key, setTimeout(() => {
        logger.debug({ key }, 'Hard cap reached — flushing');
        this.flush(key);
      }, HARD_CAP_MS));
    }

    // Reset the debounce timer
    this.resetTimer(key);
  }

  /**
   * Handle a `user_typing` event from Slack Socket Mode.
   * Resets the accumulation timer while the owner is actively typing.
   */
  handleTyping(channel: string, threadTs?: string): void {
    const key = conversationKey(channel, threadTs);
    this.lastTypingAt.set(key, Date.now());

    // Only reset timer if we have messages buffered for this conversation
    if (this.buffers.has(key) && this.buffers.get(key)!.length > 0) {
      this.resetTimer(key, TYPING_GRACE_MS);
    }
  }

  /**
   * Check if a conversation has pending messages being accumulated.
   */
  hasPending(channel: string, threadTs?: string): boolean {
    const key = conversationKey(channel, threadTs);
    const buffer = this.buffers.get(key);
    return !!buffer && buffer.length > 0;
  }

  /**
   * Force-flush a conversation immediately (e.g., for testing or shutdown).
   */
  forceFlush(channel: string, threadTs?: string): void {
    const key = conversationKey(channel, threadTs);
    this.flush(key);
  }

  /**
   * Flush all pending conversations.
   */
  flushAll(): void {
    for (const key of this.buffers.keys()) {
      this.flush(key);
    }
  }

  /**
   * Clear all buffers and timers without emitting (for shutdown).
   */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.hardCapTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.hardCapTimers.clear();
    this.buffers.clear();
    this.lastTypingAt.clear();
  }

  private resetTimer(key: string, overrideMs?: number): void {
    // Clear existing debounce timer
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    const windowMs = overrideMs ?? this.windowMs;

    this.timers.set(key, setTimeout(() => {
      // Before flushing, check if typing recently happened
      const lastTyping = this.lastTypingAt.get(key) ?? 0;
      const sinceTying = Date.now() - lastTyping;

      if (sinceTying < TYPING_GRACE_MS) {
        // Still typing — reset again with the remaining grace period
        logger.debug({ key, sinceTypingMs: sinceTying }, 'Still typing — extending window');
        this.resetTimer(key, TYPING_GRACE_MS - sinceTying);
        return;
      }

      this.flush(key);
    }, windowMs));
  }

  private flush(key: string): void {
    // Clear all timers for this conversation
    const debounce = this.timers.get(key);
    if (debounce) clearTimeout(debounce);
    this.timers.delete(key);

    const hardCap = this.hardCapTimers.get(key);
    if (hardCap) clearTimeout(hardCap);
    this.hardCapTimers.delete(key);

    this.lastTypingAt.delete(key);

    // Get and clear the buffer
    const messages = this.buffers.get(key);
    this.buffers.delete(key);

    if (!messages || messages.length === 0) return;

    const batch: AccumulatedBatch = {
      messages,
      channel: messages[0].channel,
      threadTs: messages[0].threadTs,
      userId: messages[0].userId,
      combinedText: messages.map(m => m.text).join('\n'),
    };

    logger.info(
      { key, messageCount: messages.length, combinedLength: batch.combinedText.length },
      'Batch ready',
    );

    this.emit('batch', batch);
  }
}
