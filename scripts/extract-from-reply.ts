#!/usr/bin/env npx tsx
/**
 * PostToolUse hook script — extracts facts from CC's Slack replies.
 *
 * Called asynchronously by Claude Code after every slack_reply tool call.
 * Reads hook input from stdin (JSON with tool_input containing the message).
 * Extracts facts using Sonnet and stores them to Postgres via the existing pipeline.
 *
 * This runs in the background — doesn't block CC's next response.
 */

process.env.LOG_DESTINATION = 'stderr';

import Anthropic from '@anthropic-ai/sdk';
import { initDb, getDb } from '../src/db/index.js';
import { loadConfig, getConfig } from '../src/config.js';
import { extractFacts, storeExtractionResult } from '../src/memory/extractor.js';
import { loadPrompts } from '../src/prompts.js';

// Read hook input from stdin
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(chunk as Buffer);
}

let hookInput: {
  tool_name: string;
  tool_input: { text?: string; channel_id?: string; thread_ts?: string };
  tool_response: unknown;
  session_id: string;
};

try {
  hookInput = JSON.parse(Buffer.concat(chunks).toString());
} catch {
  process.exit(0); // Can't parse input — exit silently
}

const messageText = hookInput.tool_input?.text ?? '';

// Skip short messages — acknowledgments, reactions, not worth extracting
if (messageText.length < 100) {
  process.exit(0);
}

// Initialize
loadConfig({});
loadPrompts();
const config = getConfig();
await initDb();
const sql = getDb();

// CC runs without ANTHROPIC_API_KEY (Max plan OAuth). The entrypoint saves
// the key to a file for extraction hooks to use.
import { readFileSync } from 'node:fs';
let apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  try {
    apiKey = readFileSync('/tmp/.extraction-api-key', 'utf8').trim();
  } catch {
    console.error('[extract-hook] No API key available — skipping extraction');
    process.exit(0);
  }
}

const client = new Anthropic({ apiKey });

try {
  // Build a conversation-like format for the extractor
  const conversation = `[Clawvato responding in Slack channel ${hookInput.tool_input?.channel_id ?? 'unknown'}]:\n\n${messageText}`;
  const source = `cc-native:slack-reply:${hookInput.session_id ?? 'unknown'}`;

  const result = await extractFacts(
    client,
    config.models.extractor, // Sonnet
    conversation,
    source,
    sql,
  );

  if (result.facts.length > 0) {
    const stored = await storeExtractionResult(sql, result, source);
    console.error(`[extract-hook] Extracted ${result.facts.length} facts, stored ${stored.memoriesStored}, skipped ${stored.duplicatesSkipped} duplicates`);
  }
} catch (err) {
  console.error(`[extract-hook] Extraction failed: ${err instanceof Error ? err.message : err}`);
}

process.exit(0);
