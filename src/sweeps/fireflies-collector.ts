/**
 * Fireflies Collector — incremental meeting transcript sweep.
 *
 * Uses the existing FirefliesClient to fetch new meeting summaries
 * since the last sweep. Gets tier 2 data (summary + action items)
 * which is rich enough for synthesis without the full transcript.
 *
 * High-water mark: sweep:fireflies:last_date (ISO date of newest processed meeting)
 */

import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { FirefliesClient, formatMeetingDate } from '../fireflies/api.js';
import { getHighWaterMark, setHighWaterMark, type Collector, type CollectorResult } from './types.js';

interface FirefliesSweepConfig {
  maxMeetings: number;
}

/**
 * Create a Fireflies collector that sweeps new meeting transcripts.
 */
export function createFirefliesCollector(
  client: FirefliesClient,
  sql: Sql,
  config: FirefliesSweepConfig,
): Collector {
  return {
    name: 'fireflies',

    async collect(): Promise<CollectorResult> {
      let itemsScanned = 0;
      let itemsNew = 0;
      const contentChunks: string[] = [];

      const hwmKey = 'fireflies:last_date';
      const lastDate = await getHighWaterMark(sql, hwmKey);

      try {
        // Fetch meetings since HWM (or last 7 days for first sweep)
        const fromDate = lastDate ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
        const transcripts = await client.listTranscripts({
          fromDate,
          limit: config.maxMeetings,
        });

        itemsScanned = transcripts.length;

        if (transcripts.length === 0) {
          logger.info('Fireflies sweep: no new meetings');
          return { source: 'fireflies', itemsScanned: 0, itemsNew: 0, contentChunks: [] };
        }

        // Filter out meetings we've already processed (at or before HWM)
        const hwmMs = lastDate ? new Date(lastDate).getTime() : 0;
        const newTranscripts = transcripts.filter(t => t.date > hwmMs);

        if (newTranscripts.length === 0) {
          logger.info('Fireflies sweep: all meetings already processed');
          return { source: 'fireflies', itemsScanned, itemsNew: 0, contentChunks: [] };
        }

        // Fetch summaries for new meetings (tier 2)
        let newestDate = lastDate ?? '';
        const lines: string[] = [];

        for (const meta of newTranscripts) {
          try {
            const summary = await client.getTranscriptSummary(meta.id);
            itemsNew++;

            const meetingDate = formatMeetingDate(meta.date);
            const duration = Math.round(meta.duration / 60);
            const speakers = meta.speakers?.map(s => s.name).join(', ') || 'unknown';

            const parts = [
              `### ${meta.title}`,
              `Date: ${meetingDate} | Duration: ${duration}min | Speakers: ${speakers}`,
            ];

            if (summary.summary?.overview) {
              parts.push(`\n**Overview:** ${summary.summary.overview}`);
            }
            if (summary.summary?.action_items) {
              parts.push(`\n**Action Items:** ${summary.summary.action_items}`);
            }
            if (summary.summary?.shorthand_bullet) {
              parts.push(`\n**Key Points:** ${summary.summary.shorthand_bullet}`);
            }

            lines.push(parts.join('\n'));

            // Track newest date for HWM
            const meetingIso = new Date(meta.date).toISOString();
            if (meetingIso > newestDate) newestDate = meetingIso;
          } catch (err) {
            logger.debug({ error: err, meetingId: meta.id }, 'Fireflies sweep: failed to get summary — skipping');
          }
        }

        if (lines.length > 0) {
          contentChunks.push(`## Fireflies: Recent meetings\n\n${lines.join('\n\n---\n\n')}`);
        }

        // Update high-water mark
        if (newestDate) {
          await setHighWaterMark(sql, hwmKey, newestDate);
        }

        logger.info({ itemsScanned, itemsNew, chunks: contentChunks.length }, 'Fireflies sweep complete');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
        logger.warn({ error: errMsg }, 'Fireflies sweep failed');
      }

      return { source: 'fireflies', itemsScanned, itemsNew, contentChunks };
    },
  };
}
