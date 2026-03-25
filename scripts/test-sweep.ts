#!/usr/bin/env npx tsx
/**
 * Test script — runs sweep collectors locally and shows results.
 * Usage: railway run npx tsx scripts/test-sweep.ts [slack|gmail|drive|fireflies|all]
 */

import { WebClient } from '@slack/web-api';
import { initDb, getDb } from '../src/db/index.js';
import { loadConfig, getConfig } from '../src/config.js';
import { createSlackCollector } from '../src/sweeps/slack-collector.js';
import { createGmailCollector } from '../src/sweeps/gmail-collector.js';
import { createDriveCollector } from '../src/sweeps/drive-collector.js';
import { createFirefliesCollector } from '../src/sweeps/fireflies-collector.js';
import { getGoogleAuth } from '../src/google/auth.js';
import { FirefliesClient } from '../src/fireflies/api.js';
import type { Collector } from '../src/sweeps/types.js';

const source = process.argv[2] ?? 'all';

loadConfig({});
const config = getConfig();
await initDb();
const sql = getDb();

const collectors: Collector[] = [];

// Slack
if ((source === 'all' || source === 'slack') && process.env.SLACK_USER_TOKEN) {
  const userClient = new WebClient(process.env.SLACK_USER_TOKEN);
  const botClient = new WebClient(process.env.SLACK_BOT_TOKEN);
  let botUserId: string | undefined;
  try {
    const auth = await botClient.auth.test();
    botUserId = auth.user_id as string | undefined;
  } catch { /* */ }

  // First, list all channels the user can see
  console.log('\n=== SLACK CHANNELS ===');
  try {
    for (const type of ['public_channel', 'private_channel', 'mpim'] as const) {
      const result = await userClient.conversations.list({ types: type, limit: 200, exclude_archived: true });
      const channels = (result.channels ?? []).filter(c => c.is_member);
      console.log(`  ${type}: ${channels.length} channels`);
      for (const ch of channels) {
        console.log(`    - #${ch.name ?? ch.id} (${ch.id})`);
      }
    }
  } catch (e) {
    console.error('  Failed to list channels:', e instanceof Error ? e.message : e);
  }

  collectors.push(createSlackCollector(userClient, sql, {
    excludeChannels: config.sweeps.slack.excludeChannels,
    maxMessagesPerChannel: config.sweeps.slack.maxMessagesPerChannel,
    botUserId,
  }));
}

// Gmail
if ((source === 'all' || source === 'gmail')) {
  const googleAuth = await getGoogleAuth();
  if (googleAuth) {
    collectors.push(createGmailCollector(googleAuth, sql, {
      maxThreads: config.sweeps.gmail.maxThreads,
    }));
  } else {
    console.log('Gmail: no Google auth available');
  }
}

// Drive
if ((source === 'all' || source === 'drive')) {
  const googleAuth = await getGoogleAuth();
  if (googleAuth) {
    collectors.push(createDriveCollector(googleAuth, sql, {
      maxFiles: config.sweeps.drive.maxFiles,
    }));
  } else {
    console.log('Drive: no Google auth available');
  }
}

// Fireflies
if ((source === 'all' || source === 'fireflies') && process.env.FIREFLIES_API_KEY) {
  collectors.push(createFirefliesCollector(new FirefliesClient(process.env.FIREFLIES_API_KEY), sql, {
    maxMeetings: config.sweeps.fireflies.maxMeetings,
  }));
}

if (collectors.length === 0) {
  console.error('No collectors available. Run with: railway run npx tsx scripts/test-sweep.ts');
  process.exit(1);
}

console.log(`\n=== RUNNING ${collectors.length} COLLECTOR(S) ===\n`);

for (const collector of collectors) {
  console.log(`--- ${collector.name} ---`);
  const startMs = Date.now();
  try {
    const result = await collector.collect();
    const durationMs = Date.now() - startMs;
    console.log(`  Scanned: ${result.itemsScanned}`);
    console.log(`  New: ${result.itemsNew}`);
    console.log(`  Chunks: ${result.contentChunks.length}`);
    console.log(`  Duration: ${durationMs}ms`);

    // Show first 500 chars of each chunk
    for (let i = 0; i < result.contentChunks.length; i++) {
      const chunk = result.contentChunks[i];
      console.log(`\n  Chunk ${i + 1} (${chunk.length} chars):`);
      console.log(`  ${chunk.slice(0, 500).replace(/\n/g, '\n  ')}${chunk.length > 500 ? '...' : ''}`);
    }

    // Test /ingest if there's content
    if (result.contentChunks.length > 0 && result.itemsNew > 0) {
      const pluginUrl = process.env.CLAWVATO_MEMORY_URL ?? 'https://clawvato-memory-production.up.railway.app';
      const authToken = process.env.MCP_AUTH_TOKEN ?? '';

      if (authToken) {
        console.log(`\n  Sending to /ingest...`);
        const text = result.contentChunks.join('\n\n---\n\n');
        const response = await fetch(`${pluginUrl}/ingest`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            text: text.slice(0, 50000), // cap at 50K chars
            source: `sweep:${collector.name}:test`,
            surface_id: 'cloud',
          }),
        });
        const body = await response.json();
        console.log(`  /ingest result:`, JSON.stringify(body));
      }
    }
  } catch (err) {
    console.error(`  FAILED: ${err instanceof Error ? err.message : err}`);
  }
  console.log();
}

console.log('=== DONE ===');
process.exit(0);
