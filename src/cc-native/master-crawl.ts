// Clawvato v4 — Master Crawl Launcher
// Spawns an ephemeral Opus agent that reads all sources, writes structured output to the brain.
// Called by the sidecar on a cron schedule (2x daily).

import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const execFileAsync = promisify(execFile);

const log = (msg: string) => process.stderr.write(`[master-crawl] ${msg}\n`);

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const MONITORING_CHANNEL = process.env.MONITORING_CHANNEL_ID ?? '';

async function postToSlack(channel: string, text: string): Promise<void> {
  if (!SLACK_BOT_TOKEN || !channel) return;
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text }),
    });
  } catch (e) {
    log(`Failed to post to Slack: ${e}`);
  }
}

export async function runMasterCrawl(opts: {
  lookbackDays: number;
  canvasId: string;
  timeoutMs?: number;
  maxTurns?: number;
}): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  log(`Starting master crawl — lookback: ${opts.lookbackDays}d, canvas: ${opts.canvasId}`);
  await postToSlack(MONITORING_CHANNEL, `🔄 Master crawl starting — ${timestamp}`);

  // Load and template the prompt
  const promptPath = resolve(process.cwd(), 'config/prompts/master-crawl.md');
  let prompt: string;
  try {
    prompt = readFileSync(promptPath, 'utf-8')
      .replace(/\{\{LOOKBACK_DAYS\}\}/g, String(opts.lookbackDays))
      .replace(/\{\{CANVAS_ID\}\}/g, opts.canvasId)
      .replace(/\{\{TIMESTAMP\}\}/g, timestamp);
  } catch (e) {
    const err = `Failed to load prompt: ${e}`;
    log(err);
    return { success: false, durationMs: Date.now() - startTime, error: err };
  }

  try {
    const mcpConfig = process.env.MCP_CONFIG ?? '/tmp/cc-native-mcp.json';

    const { stdout } = await execFileAsync('claude', [
      '--print',
      '--model', 'opus',
      '--output-format', 'json',
      '--mcp-config', mcpConfig,
      '--allowedTools', 'Bash,mcp__brain-platform__*,mcp__claude_ai_Slack__*,mcp__claude_ai_Fireflies__*',
      '--dangerously-skip-permissions',
      '--max-turns', String(opts.maxTurns ?? 100),
      '-p', prompt,
    ], {
      timeout: opts.timeoutMs ?? 900_000, // 15 min default
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        // Force Max plan OAuth ($0) — strip API key
        ANTHROPIC_API_KEY: '',
      },
    });

    const durationMs = Date.now() - startTime;
    const durationMin = (durationMs / 60_000).toFixed(1);

    // Parse JSON envelope for usage stats
    try {
      const envelope = JSON.parse(stdout);
      const cost = envelope.total_cost_usd ?? 0;
      const input = (envelope.usage?.input_tokens ?? 0) +
                    (envelope.usage?.cache_creation_input_tokens ?? 0) +
                    (envelope.usage?.cache_read_input_tokens ?? 0);
      const output = envelope.usage?.output_tokens ?? 0;
      const turns = envelope.num_turns ?? 0;

      log(`Crawl complete in ${durationMin}min | $${cost.toFixed(4)} | ${input} in / ${output} out | ${turns} turns`);
      await postToSlack(MONITORING_CHANNEL,
        `✅ Master crawl complete — ${durationMin}min | $${cost.toFixed(4)} | ${input} in / ${output} out | ${turns} turns`
      );
    } catch {
      log(`Crawl complete in ${durationMin}min (couldn't parse usage envelope)`);
      await postToSlack(MONITORING_CHANNEL, `✅ Master crawl complete — ${durationMin}min`);
    }

    return { success: true, durationMs };
  } catch (e: any) {
    const durationMs = Date.now() - startTime;
    const err = e.killed ? `Timed out after ${(durationMs / 60_000).toFixed(1)}min` : String(e.message ?? e);
    log(`Crawl failed: ${err}`);
    await postToSlack(MONITORING_CHANNEL, `❌ Master crawl failed — ${err}`);
    return { success: false, durationMs, error: err };
  }
}
