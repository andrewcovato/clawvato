/**
 * Email Scan — implicit email extraction pipeline.
 *
 * When the agent needs email context (outstanding items, status checks, etc.),
 * it calls this to:
 * 1. Search Gmail for threads (fast, thread IDs + snippets)
 * 2. Check which threads are already extracted in memory
 * 3. Read and extract new/changed threads via Haiku
 * 4. Return a structured summary to the agent
 *
 * Incremental: tracks threads by ID + message count. Re-extracts when
 * threads grow (new replies). Costs ~$0.001/thread (Haiku), ~$0 on repeat.
 *
 * Source key format: gmail:{threadId}:{messageCount}
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { DatabaseSync } from 'node:sqlite';
import { google } from 'googleapis';
import { logger } from '../logger.js';
import { extractEmailFacts, storeExtractionResult } from '../memory/extractor.js';
import {
  supersedeMemory,
  deleteEmbedding,
  hasVectorSupport,
  insertEmbedding,
} from '../memory/store.js';
import { embedBatch } from '../memory/embeddings.js';

// ── Noise filter ──

/**
 * Coarse pre-filter to skip obviously automated/notification emails.
 * Not meant to be comprehensive — just catches the obvious noise
 * (noreply senders, calendar invites, unsubscribe footers).
 * Cross-source search uses Haiku relevance scoring for finer filtering.
 */
const AUTOMATED_PATTERNS = [
  /noreply@/i,
  /no-reply@/i,
  /no_reply@/i,
  /notifications?@/i,
  /mailer-daemon@/i,
  /do-not-reply@/i,
  /donotreply@/i,
  /\bunsubscribe\b/i,
  /\bview in browser\b/i,
  /\bemail preferences\b/i,
  /^Google Calendar:/i,
  /^Invitation:/i,
  /^Accepted:/i,
  /^Declined:/i,
  /^Updated invitation:/i,
  /^Canceled event:/i,
];

export function isLikelyAutomated(from: string, subject: string, snippet: string): boolean {
  const combined = `${from}\n${subject}\n${snippet}`;
  return AUTOMATED_PATTERNS.some(p => p.test(combined));
}

// ── Types ──

export interface EmailScanOpts {
  query: string;
  maxThreads?: number;      // Default 100, max 150
  ownerEmail: string;
}

export interface EmailScanResult {
  threadsFound: number;
  threadsSkipped: number;   // Already extracted at current msg count
  threadsExtracted: number;
  factsExtracted: number;
  peopleExtracted: number;
  summary: string;          // Human-readable summary for agent
}

interface ThreadExtractionState {
  messageCount: number;
  memoryIds: string[];
}

// ── Helpers ──

/**
 * Parse the message count from a gmail source key.
 * Format: gmail:{threadId}:{messageCount}
 */
function parseMessageCount(source: string): number {
  const parts = source.split(':');
  return parseInt(parts[parts.length - 1], 10) || 0;
}

/**
 * Check if a thread has been extracted, and at what message count.
 */
export function getThreadExtractionState(
  db: DatabaseSync,
  threadId: string,
): ThreadExtractionState | null {
  const rows = db.prepare(
    `SELECT id, source FROM memories
     WHERE source LIKE ? AND valid_until IS NULL`
  ).all(`gmail:${threadId}:%`) as unknown as Array<{ id: string; source: string }>;

  if (rows.length === 0) return null;

  const messageCount = parseMessageCount(rows[0].source);
  return {
    messageCount,
    memoryIds: rows.map(r => r.id),
  };
}

/**
 * Supersede all memories from a thread (when re-extracting after growth).
 * Marks them as valid_until=now without setting superseded_by
 * (new memories will be inserted separately — FK constraint prevents dangling refs).
 * Returns IDs of superseded memories.
 */
export function supersedeThreadMemories(
  db: DatabaseSync,
  threadId: string,
): string[] {
  const rows = db.prepare(
    `SELECT id FROM memories
     WHERE source LIKE ? AND valid_until IS NULL`
  ).all(`gmail:${threadId}:%`) as unknown as Array<{ id: string }>;

  for (const row of rows) {
    db.prepare(
      `UPDATE memories SET valid_until = datetime('now') WHERE id = ?`
    ).run(row.id);
    deleteEmbedding(db, row.id);
  }

  return rows.map(r => r.id);
}

// ── Extract text from Gmail payload (reuse from tools.ts) ──

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTextFromPayload(payload: any): string {
  if (!payload) return '';

  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    if (payload.mimeType === 'text/plain' || !payload.parts) {
      return decoded;
    }
  }

  if (payload.parts && Array.isArray(payload.parts)) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType?.startsWith('multipart/') || part.parts) {
        const found = extractTextFromPayload(part);
        if (found) return found;
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    for (const part of payload.parts) {
      const found = extractTextFromPayload(part);
      if (found) return found;
    }
  }

  return '';
}

/**
 * Format a thread's messages for extraction.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatThreadForExtraction(messages: any[], ownerEmail: string): string {
  const parts: string[] = [`[Owner's email: ${ownerEmail}]`, ''];

  for (const message of messages) {
    const headers = message.payload?.headers ?? [];
    const from = headers.find((h: any) => h.name === 'From')?.value ?? 'unknown';
    const to = headers.find((h: any) => h.name === 'To')?.value ?? '';
    const subject = headers.find((h: any) => h.name === 'Subject')?.value ?? '';
    const date = headers.find((h: any) => h.name === 'Date')?.value ?? '';

    const body = extractTextFromPayload(message.payload);

    parts.push(
      `--- Message (${date}) ---`,
      `From: ${from}`,
      `To: ${to}`,
      subject ? `Subject: ${subject}` : '',
      '',
      body.slice(0, 4000),
      '',
    );
  }

  return parts.join('\n');
}

// ── Main scan function ──

const SCAN_BATCH_SIZE = 10;

/**
 * Scan Gmail threads, extract new/changed ones into memory, return summary.
 */
export async function scanEmail(
  gmail: ReturnType<typeof google.gmail>,
  db: DatabaseSync,
  anthropicClient: Anthropic,
  classifierModel: string,
  opts: EmailScanOpts,
): Promise<EmailScanResult> {
  const maxThreads = Math.min(opts.maxThreads ?? 100, 150);

  // ── Step 1: Search for threads (fast) ──
  const allThreadIds: string[] = [];
  let pageToken: string | undefined;

  while (allThreadIds.length < maxThreads) {
    const result = await gmail.users.threads.list({
      userId: 'me',
      q: opts.query,
      maxResults: Math.min(maxThreads - allThreadIds.length, 100),
      ...(pageToken ? { pageToken } : {}),
    });

    const threads = result.data.threads ?? [];
    if (threads.length === 0) break;

    for (const t of threads) {
      if (allThreadIds.length >= maxThreads) break;
      allThreadIds.push(t.id!);
    }

    pageToken = result.data.nextPageToken ?? undefined;
    if (!pageToken) break;
  }

  if (allThreadIds.length === 0) {
    return {
      threadsFound: 0, threadsSkipped: 0, threadsExtracted: 0,
      factsExtracted: 0, peopleExtracted: 0,
      summary: `No email threads found for "${opts.query}".`,
    };
  }

  logger.info({ threadsFound: allThreadIds.length, query: opts.query }, 'Email scan: threads found');

  // ── Step 2: Get message counts (lightweight metadata fetch) ──
  const threadMeta = await Promise.all(allThreadIds.map(async (threadId) => {
    try {
      const thread = await gmail.users.threads.get({
        userId: 'me',
        id: threadId,
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'Date'],
      });
      const messages = thread.data.messages ?? [];
      const firstHeaders = messages[0]?.payload?.headers ?? [];
      const lastHeaders = messages[messages.length - 1]?.payload?.headers ?? [];
      const firstFrom = firstHeaders.find((h: any) => h.name === 'From')?.value ?? '';
      const subject = firstHeaders.find((h: any) => h.name === 'Subject')?.value ?? 'no subject';
      const snippet = messages[0]?.snippet ?? '';

      return {
        threadId,
        messageCount: messages.length,
        subject,
        firstFrom,
        snippet,
        lastFrom: lastHeaders.find((h: any) => h.name === 'From')?.value ?? '',
        lastDate: lastHeaders.find((h: any) => h.name === 'Date')?.value ?? '',
      };
    } catch {
      return null;
    }
  }));

  const validThreads = threadMeta.filter((t): t is NonNullable<typeof t> => t !== null);

  // ── Step 2b: Coarse noise filter — skip obviously automated threads ──
  let automatedSkipped = 0;
  const humanThreads = validThreads.filter(t => {
    if (isLikelyAutomated(t.firstFrom, t.subject, t.snippet)) {
      automatedSkipped++;
      return false;
    }
    return true;
  });

  if (automatedSkipped > 0) {
    logger.info({ automatedSkipped, remaining: humanThreads.length }, 'Email scan: automated threads filtered');
  }

  // ── Step 3: Delta check — which threads need extraction? ──
  const threadsToExtract: typeof humanThreads = [];
  let threadsSkipped = 0;

  for (const thread of humanThreads) {
    const state = getThreadExtractionState(db, thread.threadId);
    if (state && state.messageCount >= thread.messageCount) {
      threadsSkipped++;
    } else {
      threadsToExtract.push(thread);
    }
  }

  logger.info(
    { total: validThreads.length, toExtract: threadsToExtract.length, skipped: threadsSkipped },
    'Email scan: delta check complete',
  );

  // ── Step 4+5: Batch read + extract changed threads ──
  let totalFacts = 0;
  let totalPeople = 0;

  for (let i = 0; i < threadsToExtract.length; i += SCAN_BATCH_SIZE) {
    const batch = threadsToExtract.slice(i, i + SCAN_BATCH_SIZE);

    // Read full thread content in parallel
    const threadContents = await Promise.all(batch.map(async (thread) => {
      try {
        const fullThread = await gmail.users.threads.get({
          userId: 'me',
          id: thread.threadId,
          format: 'full',
        });
        return { thread, messages: fullThread.data.messages ?? [] };
      } catch {
        return null;
      }
    }));

    // Extract facts in parallel via Haiku, then store sequentially
    const extractions = await Promise.all(
      threadContents
        .filter((tc): tc is NonNullable<typeof tc> => tc !== null && tc.messages.length > 0)
        .map(async ({ thread, messages }) => {
          const content = formatThreadForExtraction(messages, opts.ownerEmail);
          const sourceKey = `gmail:${thread.threadId}:${messages.length}`;

          try {
            const result = await extractEmailFacts(
              anthropicClient,
              classifierModel,
              content,
              sourceKey,
            );
            return { thread, result, sourceKey, messageCount: messages.length };
          } catch (error) {
            logger.debug(
              { error: error instanceof Error ? error.message : String(error), threadId: thread.threadId },
              'Email scan: extraction failed for thread',
            );
            return null;
          }
        })
    );

    // Store results sequentially (safe for node:sqlite)
    for (const extraction of extractions) {
      if (!extraction) continue;
      const { thread, result, sourceKey } = extraction;

      // Supersede old memories for this thread (if re-extracting after growth)
      supersedeThreadMemories(db, thread.threadId);

      // Store new extractions
      if (result.facts.length > 0 || result.people.length > 0) {
        const stored = await storeExtractionResult(db, result, sourceKey);
        totalFacts += stored.memoriesStored;
        totalPeople += stored.peopleStored;
      } else {
        // No facts extracted — store a marker so we skip on future scans
        // (automated email, spam, etc.)
        db.prepare(`
          INSERT INTO memories (id, type, content, source, importance, confidence, entities)
          VALUES (?, 'observation', ?, ?, 1, 0.3, '[]')
        `).run(
          `scan-${thread.threadId}`,
          `Email thread "${thread.subject}" — no actionable content`,
          sourceKey,
        );
      }
    }
  }

  // ── Step 6: Build structured summary ──
  const summary = buildScanSummary(db, humanThreads, threadsToExtract.length, threadsSkipped, automatedSkipped, opts.ownerEmail);

  logger.info(
    { threadsFound: allThreadIds.length, skipped: threadsSkipped, extracted: threadsToExtract.length, facts: totalFacts, people: totalPeople },
    'Email scan complete',
  );

  return {
    threadsFound: allThreadIds.length,
    threadsSkipped,
    threadsExtracted: threadsToExtract.length,
    factsExtracted: totalFacts,
    peopleExtracted: totalPeople,
    summary,
  };
}

/**
 * Build a structured summary of email state from recently-extracted memories.
 */
function buildScanSummary(
  db: DatabaseSync,
  threads: Array<{ threadId: string; subject: string; lastFrom: string; lastDate: string; messageCount: number }>,
  extracted: number,
  skipped: number,
  automatedSkipped: number,
  ownerEmail: string,
): string {
  const ownerLower = ownerEmail.toLowerCase();

  // Categorize threads by resolution status
  const awaitingReply: string[] = [];
  const ownerNeedsToReply: string[] = [];
  const resolved: string[] = [];
  const informational: string[] = [];

  for (const thread of threads) {
    const lastFromLower = thread.lastFrom.toLowerCase();
    const ownerSentLast = lastFromLower.includes(ownerLower);

    if (ownerSentLast) {
      awaitingReply.push(`• "${thread.subject}" (${thread.lastDate}, ${thread.messageCount} msg)`);
    } else {
      // Check if owner participated
      // We can't tell from metadata alone if the thread needs a reply,
      // so we rely on the extracted memories for that. Just categorize by last sender.
      ownerNeedsToReply.push(`• "${thread.subject}" — last from: ${thread.lastFrom.split('<')[0].trim()} (${thread.lastDate})`);
    }
  }

  // Also pull recent commitments and outstanding items from memory
  const recentCommitments = db.prepare(
    `SELECT content, source FROM memories
     WHERE type = 'commitment' AND source LIKE 'gmail:%' AND valid_until IS NULL
     ORDER BY importance DESC, created_at DESC LIMIT 20`
  ).all() as unknown as Array<{ content: string; source: string }>;

  const parts: string[] = [
    `Email scan complete: ${threads.length} threads (${skipped} cached, ${extracted} newly extracted${automatedSkipped > 0 ? `, ${automatedSkipped} automated/noise skipped` : ''}).`,
    '',
  ];

  if (awaitingReply.length > 0) {
    parts.push(`**Sent by owner — awaiting reply (${awaitingReply.length}):**`);
    parts.push(...awaitingReply.slice(0, 30));
    parts.push('');
  }

  if (ownerNeedsToReply.length > 0) {
    parts.push(`**Received — may need owner's attention (${ownerNeedsToReply.length}):**`);
    parts.push(...ownerNeedsToReply.slice(0, 30));
    parts.push('');
  }

  if (recentCommitments.length > 0) {
    parts.push(`**Outstanding commitments from email (${recentCommitments.length}):**`);
    for (const c of recentCommitments) {
      parts.push(`• ${c.content}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}
