#!/usr/bin/env npx tsx
/**
 * Fireflies CLI — thin wrapper for Claude Code SDK access.
 *
 * The SDK calls this via bash:
 *   npx tsx tools/fireflies.ts search --query "budget" --days-back 60
 *   npx tsx tools/fireflies.ts summary --id "abc123"
 *   npx tsx tools/fireflies.ts transcript --id "abc123"
 *
 * Returns JSON for easy parsing by the SDK.
 */

import { FirefliesClient, formatMeetingDate, formatDuration } from '../src/fireflies/api.js';

const apiKey = process.env.FIREFLIES_API_KEY;
if (!apiKey) {
  console.error('FIREFLIES_API_KEY environment variable is required');
  process.exit(1);
}

const client = new FirefliesClient(apiKey);
const [command, ...rest] = process.argv.slice(2);

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--') && i + 1 < args.length) {
      flags[args[i].slice(2)] = args[i + 1];
      i++;
    }
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseFlags(rest);

  switch (command) {
    case 'search': {
      const query = flags.query ?? '';
      const daysBack = parseInt(flags['days-back'] ?? '60', 10);
      const maxResults = Math.min(parseInt(flags['max-results'] ?? '20', 10), 50);
      const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

      const results = await client.searchTranscripts(query, { limit: maxResults, fromDate });

      if (results.length === 0) {
        console.log(`No meetings found matching "${query}" in the last ${daysBack} days.`);
        return;
      }

      const lines = results.map(t => {
        const date = formatMeetingDate(t.date);
        const dur = formatDuration(t.duration);
        const speakers = t.speakers.map(s => s.name).join(', ');
        return `- ${t.title} | ${date} | ${dur} | Speakers: ${speakers} | ID: ${t.id}`;
      });

      console.log(`Found ${results.length} meetings:\n${lines.join('\n')}`);
      break;
    }

    case 'summary': {
      const id = flags.id;
      if (!id) { console.error('--id required'); process.exit(1); }

      const t = await client.getTranscriptSummary(id);
      const date = formatMeetingDate(t.date);
      const dur = formatDuration(t.duration);
      const speakers = t.speakers.map(s => s.name).join(', ');

      const parts = [
        `Meeting: "${t.title}"`,
        `Date: ${date} | Duration: ${dur}`,
        `Speakers: ${speakers}`,
        `Participants: ${t.participants.join(', ')}`,
        '',
      ];

      if (t.summary.overview) parts.push(`Overview:\n${t.summary.overview}`);
      if (t.summary.action_items) parts.push(`\nAction Items:\n${t.summary.action_items}`);
      if (t.summary.outline) parts.push(`\nOutline:\n${t.summary.outline}`);

      console.log(parts.join('\n'));
      break;
    }

    case 'transcript': {
      const id = flags.id;
      if (!id) { console.error('--id required'); process.exit(1); }
      const maxSentences = Math.min(parseInt(flags['max-sentences'] ?? '1000', 10), 2000);

      const t = await client.getTranscriptFull(id);
      const date = formatMeetingDate(t.date);
      const dur = formatDuration(t.duration);
      const speakers = t.speakers.map(s => s.name).join(', ');

      const header = `Meeting: "${t.title}"\nDate: ${date} | Duration: ${dur}\nSpeakers: ${speakers}`;

      const sentences = t.sentences.slice(0, maxSentences);
      const formatted = sentences.map(s => {
        const mins = Math.floor(s.start_time / 60);
        const secs = Math.floor(s.start_time % 60);
        const ts = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
        return `[${s.speaker_name}, ${ts}]: ${s.text}`;
      }).join('\n');

      const truncated = sentences.length < t.sentences.length
        ? `\n\n[Showing ${sentences.length} of ${t.sentences.length} sentences]`
        : '';

      console.log(`${header}\n\n--- Transcript ---\n\n${formatted}${truncated}`);
      break;
    }

    case 'list': {
      const daysBack = parseInt(flags['days-back'] ?? '30', 10);
      const limit = Math.min(parseInt(flags.limit ?? '20', 10), 100);
      const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

      const results = await client.listTranscripts({ limit, fromDate });

      if (results.length === 0) {
        console.log(`No meetings in the last ${daysBack} days.`);
        return;
      }

      const lines = results.map(t => {
        const date = formatMeetingDate(t.date);
        const dur = formatDuration(t.duration);
        const speakers = t.speakers.map(s => s.name).join(', ');
        return `- ${t.title} | ${date} | ${dur} | Speakers: ${speakers} | ID: ${t.id}`;
      });

      console.log(`${results.length} meetings:\n${lines.join('\n')}`);
      break;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Usage: fireflies.ts <search|summary|transcript|list> [--flags]');
      process.exit(1);
  }
}

main().catch(err => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
