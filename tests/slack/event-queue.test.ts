import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventQueue, type QueuedMessage, type AccumulatedBatch } from '../../src/slack/event-queue.js';

function makeMsg(overrides: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    text: 'hello',
    channel: 'C123',
    userId: 'U_OWNER',
    ts: '1234567890.123456',
    receivedAt: Date.now(),
    ...overrides,
  };
}

describe('EventQueue', () => {
  let queue: EventQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new EventQueue();
  });

  afterEach(() => {
    queue.clear();
    vi.useRealTimers();
  });

  it('emits a batch after the accumulation window', async () => {
    const batches: AccumulatedBatch[] = [];
    queue.on('batch', (b: AccumulatedBatch) => batches.push(b));

    queue.enqueue(makeMsg({ text: 'first message' }));

    // Before window expires — no batch yet
    vi.advanceTimersByTime(3000);
    expect(batches).toHaveLength(0);

    // After window expires (default patient = 4000ms)
    vi.advanceTimersByTime(2000);
    expect(batches).toHaveLength(1);
    expect(batches[0].combinedText).toBe('first message');
    expect(batches[0].messages).toHaveLength(1);
  });

  it('accumulates multiple messages into one batch', async () => {
    const batches: AccumulatedBatch[] = [];
    queue.on('batch', (b: AccumulatedBatch) => batches.push(b));

    queue.enqueue(makeMsg({ text: 'schedule a meeting' }));
    vi.advanceTimersByTime(1500);
    queue.enqueue(makeMsg({ text: 'include the Q3 deck', ts: '1234567890.123457' }));

    // Timer was reset by second message — wait for the full window
    vi.advanceTimersByTime(5000);
    expect(batches).toHaveLength(1);
    expect(batches[0].messages).toHaveLength(2);
    expect(batches[0].combinedText).toBe('schedule a meeting\ninclude the Q3 deck');
  });

  it('separates messages from different threads', async () => {
    const batches: AccumulatedBatch[] = [];
    queue.on('batch', (b: AccumulatedBatch) => batches.push(b));

    queue.enqueue(makeMsg({ text: 'in thread', threadTs: 'T1' }));
    queue.enqueue(makeMsg({ text: 'top level', channel: 'C999' }));

    vi.advanceTimersByTime(5000);
    expect(batches).toHaveLength(2);
  });

  it('respects the snappy mode (2s window)', async () => {
    const batches: AccumulatedBatch[] = [];
    queue.on('batch', (b: AccumulatedBatch) => batches.push(b));
    queue.setMode('snappy');

    queue.enqueue(makeMsg({ text: 'quick command' }));

    vi.advanceTimersByTime(1500);
    expect(batches).toHaveLength(0);

    vi.advanceTimersByTime(1000);
    expect(batches).toHaveLength(1);
  });

  it('respects the wait_for_me mode (15s window)', async () => {
    const batches: AccumulatedBatch[] = [];
    queue.on('batch', (b: AccumulatedBatch) => batches.push(b));
    queue.setMode('wait_for_me');

    queue.enqueue(makeMsg({ text: 'long thought' }));

    vi.advanceTimersByTime(10_000);
    expect(batches).toHaveLength(0);

    vi.advanceTimersByTime(6000);
    expect(batches).toHaveLength(1);
  });

  it('extends the window when typing events arrive', async () => {
    const batches: AccumulatedBatch[] = [];
    queue.on('batch', (b: AccumulatedBatch) => batches.push(b));

    queue.enqueue(makeMsg({ text: 'first part' }));

    // 3s in, user is typing — resets to 4s typing grace
    vi.advanceTimersByTime(3000);
    queue.handleTyping('C123');

    // 3s after typing — still within typing grace (4s)
    vi.advanceTimersByTime(3000);
    expect(batches).toHaveLength(0);

    // 2s more — typing grace expired
    vi.advanceTimersByTime(2000);
    expect(batches).toHaveLength(1);
  });

  it('enforces hard cap at 30s', async () => {
    const batches: AccumulatedBatch[] = [];
    queue.on('batch', (b: AccumulatedBatch) => batches.push(b));
    queue.setMode('wait_for_me');

    queue.enqueue(makeMsg({ text: 'first' }));

    // Keep sending typing events to prevent normal flush
    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(3000);
      queue.handleTyping('C123');
    }

    // Hard cap at 30s should force flush
    vi.advanceTimersByTime(10_000);
    expect(batches).toHaveLength(1);
  });

  it('hasPending returns correct state', () => {
    expect(queue.hasPending('C123')).toBe(false);
    queue.enqueue(makeMsg());
    expect(queue.hasPending('C123')).toBe(true);
  });

  it('forceFlush immediately emits', () => {
    const batches: AccumulatedBatch[] = [];
    queue.on('batch', (b: AccumulatedBatch) => batches.push(b));

    queue.enqueue(makeMsg({ text: 'urgent' }));
    queue.forceFlush('C123');

    expect(batches).toHaveLength(1);
    expect(batches[0].combinedText).toBe('urgent');
  });

  it('clear removes all state without emitting', () => {
    const batches: AccumulatedBatch[] = [];
    queue.on('batch', (b: AccumulatedBatch) => batches.push(b));

    queue.enqueue(makeMsg());
    queue.clear();

    vi.advanceTimersByTime(10_000);
    expect(batches).toHaveLength(0);
    expect(queue.hasPending('C123')).toBe(false);
  });
});
