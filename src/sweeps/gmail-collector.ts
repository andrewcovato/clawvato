/**
 * Gmail Collector — incremental email thread sweep.
 *
 * Uses the Google OAuth client to search for new email threads
 * since the last sweep. Fetches thread metadata + snippets for synthesis.
 * Full thread bodies are NOT fetched here — that's deep path work.
 *
 * High-water mark: sweep:gmail:last_date (ISO date of newest processed thread)
 */

import { google } from 'googleapis';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getHighWaterMark, setHighWaterMark, type Collector, type CollectorResult } from './types.js';

interface GmailSweepConfig {
  maxThreads: number;
}

/**
 * Create a Gmail collector that sweeps new email threads.
 */
export function createGmailCollector(
  auth: InstanceType<typeof google.auth.OAuth2>,
  sql: Sql,
  config: GmailSweepConfig,
): Collector {
  return {
    name: 'gmail',

    async collect(): Promise<CollectorResult> {
      let itemsScanned = 0;
      let itemsNew = 0;
      const contentChunks: string[] = [];

      const gmail = google.gmail({ version: 'v1', auth });
      const hwmKey = 'gmail:last_date';
      const lastDate = await getHighWaterMark(sql, hwmKey);

      // Build query — only fetch threads newer than HWM
      const dateFilter = lastDate
        ? `after:${formatGmailDate(lastDate)}`
        : 'newer_than:7d'; // First sweep: last 7 days

      try {
        // Fetch thread list (metadata only — fast)
        const threads: Array<{ id: string; snippet: string }> = [];
        let pageToken: string | undefined;

        while (threads.length < config.maxThreads) {
          const result = await gmail.users.threads.list({
            userId: 'me',
            q: dateFilter,
            maxResults: Math.min(config.maxThreads - threads.length, 100),
            ...(pageToken ? { pageToken } : {}),
          });

          const pageThreads = result.data.threads ?? [];
          if (pageThreads.length === 0) break;

          for (const t of pageThreads) {
            if (!t.id) continue;
            threads.push({ id: t.id, snippet: t.snippet ?? '' });
            if (threads.length >= config.maxThreads) break;
          }

          pageToken = result.data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }

        itemsScanned = threads.length;

        if (threads.length === 0) {
          logger.info('Gmail sweep: no new threads');
          return { source: 'gmail', itemsScanned: 0, itemsNew: 0, contentChunks: [] };
        }

        // Fetch thread details in batches for richer context
        const BATCH_SIZE = 10;
        let newestDate = lastDate ?? '';

        for (let i = 0; i < threads.length; i += BATCH_SIZE) {
          const batch = threads.slice(i, i + BATCH_SIZE);
          const details = await Promise.all(
            batch.map(t => fetchThreadSummary(gmail, t.id).catch(() => null)),
          );

          const lines: string[] = [];
          for (const detail of details) {
            if (!detail) continue;
            itemsNew++;
            lines.push(formatThreadLine(detail));

            // Track newest date for HWM
            if (detail.date > newestDate) newestDate = detail.date;
          }

          if (lines.length > 0) {
            contentChunks.push(`## Gmail: Recent threads (batch ${Math.floor(i / BATCH_SIZE) + 1})\n\n${lines.join('\n\n')}`);
          }
        }

        // Update high-water mark
        if (newestDate) {
          await setHighWaterMark(sql, hwmKey, newestDate);
        }

        logger.info({ itemsScanned, itemsNew, chunks: contentChunks.length }, 'Gmail sweep complete');
      } catch (err) {
        logger.warn({ error: err }, 'Gmail sweep failed');
      }

      return { source: 'gmail', itemsScanned, itemsNew, contentChunks };
    },
  };
}

// ── Helpers ──

interface ThreadSummary {
  id: string;
  subject: string;
  from: string;
  to: string;
  date: string; // ISO date
  snippet: string;
  messageCount: number;
}

/**
 * Fetch a thread's first message for subject, from, date context.
 */
async function fetchThreadSummary(
  gmail: ReturnType<typeof google.gmail>,
  threadId: string,
): Promise<ThreadSummary> {
  const result = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['Subject', 'From', 'To', 'Date'],
  });

  const messages = result.data.messages ?? [];
  const firstMsg = messages[0];
  const headers = firstMsg?.payload?.headers ?? [];

  const getHeader = (name: string): string =>
    headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value ?? '';

  return {
    id: threadId,
    subject: getHeader('Subject') || '(no subject)',
    from: getHeader('From'),
    to: getHeader('To'),
    date: parseEmailDate(getHeader('Date')),
    snippet: firstMsg?.snippet ?? '',
    messageCount: messages.length,
  };
}

function formatThreadLine(t: ThreadSummary): string {
  const parts = [
    `**${t.subject}**`,
    `From: ${t.from}`,
    t.to ? `To: ${t.to}` : null,
    `Date: ${t.date}`,
    t.messageCount > 1 ? `(${t.messageCount} messages in thread)` : null,
    t.snippet ? `> ${t.snippet.slice(0, 300)}` : null,
  ].filter(Boolean);
  return parts.join('\n');
}

/**
 * Parse email Date header to ISO date string.
 */
function parseEmailDate(dateStr: string): string {
  try {
    return new Date(dateStr).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

/**
 * Format a date for Gmail's after: query (YYYY/MM/DD).
 */
function formatGmailDate(isoDate: string): string {
  const d = new Date(isoDate);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}
