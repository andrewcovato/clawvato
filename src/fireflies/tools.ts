/**
 * Fireflies Tools — meeting transcript search, summary, deep read, and sync.
 *
 * Same pattern as Google tools: Anthropic tool definitions + handler functions.
 * Called directly in the agent loop, no MCP overhead.
 *
 * Tools:
 *   fireflies_search_meetings  — search meeting transcripts
 *   fireflies_get_summary      — get meeting overview + action items (Tier 2)
 *   fireflies_read_transcript  — deep read full transcript (Tier 3)
 *   fireflies_sync_meetings    — crawl recent meetings into memory
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { ToolHandlerResult } from '../mcp/slack/server.js';
import { FirefliesClient, formatMeetingDate, formatDuration } from './api.js';
import { scanForSecrets } from '../security/output-sanitizer.js';
import { logger } from '../logger.js';

function sanitizeErrorMessage(msg: string): string {
  const scan = scanForSecrets(msg);
  return scan.hasSecrets ? scan.redacted : msg;
}

export interface FirefliesToolDef {
  definition: Anthropic.Tool;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
}

/**
 * Create Fireflies tools backed by an authenticated API client.
 */
export function createFirefliesTools(client: FirefliesClient): FirefliesToolDef[] {
  return [
    // ── Search Meetings ──
    {
      definition: {
        name: 'fireflies_search_meetings',
        description:
          'Search meeting transcripts by keyword, participant name, or date range. ' +
          'Returns title, date, duration, participants, and transcript ID for each match. ' +
          'For comprehensive sweeps, set max_results high and days_back to cover the full range.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search keyword (meeting title or participant name). Use broad terms for comprehensive sweeps.' },
            days_back: { type: 'number', description: 'Search meetings from the last N days (default 60)' },
            max_results: { type: 'number', description: 'Max results to return (default 20, max 50)' },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = args.query as string;
        const daysBack = (args.days_back as number) ?? 60;
        const maxResults = Math.min((args.max_results as number) ?? 20, 50);

        try {
          const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
          const results = await client.searchTranscripts(query, {
            limit: maxResults,
            fromDate,
          });

          if (results.length === 0) {
            return { content: `No meetings found matching "${query}" in the last ${daysBack} days.` };
          }

          const lines = results.map(t => {
            const date = formatMeetingDate(t.date);
            const dur = formatDuration(t.duration);
            const speakers = t.speakers.map(s => s.name).join(', ');
            const participants = t.participants.length > 0
              ? ` | Participants: ${t.participants.slice(0, 5).join(', ')}`
              : '';
            return `- ${t.title} | ${date} | ${dur} | Speakers: ${speakers}${participants} | ID: ${t.id}`;
          });

          return { content: `Found ${results.length} meetings:\n${lines.join('\n')}` };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Fireflies search error: ${msg}`, isError: true };
        }
      },
    },

    // ── Get Summary (Tier 2) ──
    {
      definition: {
        name: 'fireflies_get_summary',
        description:
          'Get the AI-generated summary of a meeting — overview, action items, key topics, ' +
          'and participant list. Use for quick understanding of what was discussed.',
        input_schema: {
          type: 'object' as const,
          properties: {
            transcript_id: { type: 'string', description: 'Fireflies transcript ID' },
          },
          required: ['transcript_id'],
        },
      },
      handler: async (args) => {
        const id = args.transcript_id as string;

        try {
          const t = await client.getTranscriptSummary(id);
          const date = formatMeetingDate(t.date);
          const dur = formatDuration(t.duration);
          const speakers = t.speakers.map(s => s.name).join(', ');
          const participants = t.participants.length > 0
            ? `\nParticipants: ${t.participants.join(', ')}`
            : '';

          const summary = t.summary;
          const parts = [
            `Meeting: "${t.title}"`,
            `Date: ${date} | Duration: ${dur}`,
            `Speakers: ${speakers}${participants}`,
            '',
          ];

          if (summary.overview) {
            parts.push(`Overview:\n${summary.overview}`);
          }
          if (summary.action_items) {
            parts.push(`\nAction Items:\n${summary.action_items}`);
          }
          if (summary.outline) {
            parts.push(`\nOutline:\n${summary.outline}`);
          }

          return { content: parts.join('\n') };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to get meeting summary: ${msg}`, isError: true };
        }
      },
    },

    // ── Read Transcript (Tier 3 — Deep Read) ──
    {
      definition: {
        name: 'fireflies_read_transcript',
        description:
          'Deep read — get the full meeting transcript with speaker labels and timestamps. ' +
          'Returns the actual transcript text so you can answer detailed questions about the meeting. ' +
          'Also extracts facts and commitments into long-term memory in the background.',
        input_schema: {
          type: 'object' as const,
          properties: {
            transcript_id: { type: 'string', description: 'Fireflies transcript ID' },
            max_sentences: { type: 'number', description: 'Max sentences to return (default 1000, max 2000)' },
          },
          required: ['transcript_id'],
        },
      },
      handler: async (args) => {
        const id = args.transcript_id as string;
        const maxSentences = Math.min((args.max_sentences as number) ?? 500, 1000);

        try {
          const t = await client.getTranscriptFull(id);
          const date = formatMeetingDate(t.date);
          const dur = formatDuration(t.duration);
          const speakers = t.speakers.map(s => s.name).join(', ');

          const header = [
            `Meeting: "${t.title}"`,
            `Date: ${date} | Duration: ${dur}`,
            `Speakers: ${speakers}`,
          ].join('\n');

          // Format sentences with speaker labels and timestamps
          const sentences = t.sentences.slice(0, maxSentences);
          const formatted = sentences.map(s => {
            const mins = Math.floor(s.start_time / 60);
            const secs = Math.floor(s.start_time % 60);
            const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
            return `[${s.speaker_name}, ${ts}]: ${s.text}`;
          }).join('\n');

          const truncated = sentences.length < t.sentences.length
            ? `\n\n[Transcript truncated — showing ${sentences.length} of ${t.sentences.length} sentences]`
            : '';

          // Note: background fact extraction is triggered by the agent loop handler
          // (see fireflies_sync_meetings handler in agent/index.ts)

          return {
            content: `${header}\n\n--- Transcript ---\n\n${formatted}${truncated}`,
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to read transcript: ${msg}`, isError: true };
        }
      },
    },

    // ── Sync Meetings ──
    {
      definition: {
        name: 'fireflies_sync_meetings',
        description:
          'Sync recent meetings from Fireflies into long-term memory. ' +
          'Fetches meeting summaries and action items, storing them as memories for future retrieval. ' +
          'Use when asked to "sync meetings", "catch up on meetings", or "what meetings did I have". ' +
          'For comprehensive historical sweeps, increase days_back and max_transcripts.',
        input_schema: {
          type: 'object' as const,
          properties: {
            days_back: { type: 'number', description: 'Sync meetings from the last N days (default from config). Use higher values for comprehensive sweeps.' },
            max_transcripts: { type: 'number', description: 'Max meetings to sync (default 20, max 100)' },
          },
          required: [],
        },
      },
      // Handler is overridden in agent/index.ts to inject DB and Anthropic client
      handler: async () => {
        return { content: 'Fireflies sync handler not configured.', isError: true };
      },
    },
  ];
}
