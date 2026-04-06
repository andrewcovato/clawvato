// Clawvato v4 — Master Crawl Launcher
// Spawns an ephemeral Opus agent that reads all sources, writes structured output to the brain.
// Called by the sidecar on a cron schedule (2x daily).

import { spawn } from 'child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { resolve, join } from 'path';
import { tmpdir } from 'os';

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
  promptOverride?: string;
}): Promise<{ success: boolean; durationMs: number; error?: string }> {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();

  log(`Starting master crawl — lookback: ${opts.lookbackDays}d, canvas: ${opts.canvasId}`);
  await postToSlack(MONITORING_CHANNEL, `🔄 Master crawl starting — ${timestamp}`);

  // Load and template the prompt, write to temp file
  const promptFile = opts.promptOverride || 'config/prompts/master-crawl.md';
  const promptPath = resolve(process.cwd(), promptFile);
  const tmpPromptPath = join(tmpdir(), `master-crawl-${Date.now()}.md`);
  try {
    const raw = readFileSync(promptPath, 'utf-8');
    const templated = raw
      .replace(/\{\{LOOKBACK_DAYS\}\}/g, String(opts.lookbackDays))
      .replace(/\{\{CANVAS_ID\}\}/g, opts.canvasId)
      .replace(/\{\{MONITORING_CHANNEL_ID\}\}/g, MONITORING_CHANNEL)
      .replace(/\{\{TIMESTAMP\}\}/g, timestamp);
    writeFileSync(tmpPromptPath, templated);
    log(`Prompt written to ${tmpPromptPath} (${templated.length} chars)`);
  } catch (e) {
    const durationMs = Date.now() - startTime;
    const err = `Failed to load/write prompt: ${e}`;
    log(err);
    await postToSlack(MONITORING_CHANNEL, `❌ Master crawl failed — ${err}`);
    return { success: false, durationMs, error: err };
  }

  const mcpConfig = process.env.MCP_CONFIG ?? '/tmp/cc-native-mcp.json';
  const timeoutMs = opts.timeoutMs ?? 900_000;

  try {
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }>((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let timedOut = false;

      const proc = spawn('claude', [
        '--print',
        '--model', 'opus',
        '--output-format', 'json',
        '--mcp-config', mcpConfig,
        '--allowedTools', 'Bash,mcp__brain-platform__*',
        '--dangerously-skip-permissions',
        '--max-turns', String(opts.maxTurns ?? 100),
        '-p', `Read and follow the instructions in ${tmpPromptPath}. Execute all phases in order.`,
      ], {
        env: { ...process.env, ANTHROPIC_API_KEY: '' },
      });

      proc.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));

      // Stream stderr in real-time for visibility
      proc.stderr.on('data', (chunk: Buffer) => {
        stderrChunks.push(chunk);
        const line = chunk.toString().trim();
        if (line) log(`[stderr] ${line.slice(0, 500)}`);
      });

      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
      }, timeoutMs);

      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString(),
          stderr: Buffer.concat(stderrChunks).toString(),
          code,
          timedOut,
        });
      });
    });

    const durationMs = Date.now() - startTime;
    const durationMin = (durationMs / 60_000).toFixed(1);

    if (result.timedOut) {
      const err = `Timed out after ${durationMin}min`;
      const stderrTail = result.stderr.slice(-500);
      log(`Crawl failed: ${err}\nLast stderr: ${stderrTail}`);
      await postToSlack(MONITORING_CHANNEL, `❌ Master crawl failed — ${err}\nLast stderr: ${stderrTail.slice(0, 300)}`);
      return { success: false, durationMs, error: err };
    }

    if (result.code !== 0) {
      const err = `Exited with code ${result.code}`;
      const stderrTail = result.stderr.slice(-500);
      log(`Crawl failed: ${err}\nstderr: ${stderrTail}`);
      await postToSlack(MONITORING_CHANNEL, `❌ Master crawl failed — ${err}\nstderr: ${stderrTail.slice(0, 300)}`);
      return { success: false, durationMs, error: `${err}: ${stderrTail}` };
    }

    // Parse JSON envelope for usage stats
    try {
      const envelope = JSON.parse(result.stdout);
      const resultText = envelope.result ?? '';
      log(`Crawl result (first 2000 chars):\n${String(resultText).slice(0, 2000)}`);
      const cost = envelope.total_cost_usd ?? 0;
      const newInput = envelope.usage?.input_tokens ?? 0;
      const cacheCreate = envelope.usage?.cache_creation_input_tokens ?? 0;
      const cacheRead = envelope.usage?.cache_read_input_tokens ?? 0;
      const output = envelope.usage?.output_tokens ?? 0;
      const turns = envelope.num_turns ?? 0;
      const totalInput = newInput + cacheCreate + cacheRead;

      log(`Crawl complete in ${durationMin}min | $${cost.toFixed(4)} | ${totalInput} total in (${newInput} new + ${cacheCreate} cache-create + ${cacheRead} cache-read) / ${output} out | ${turns} turns`);
      await postToSlack(MONITORING_CHANNEL,
        `✅ Master crawl complete — ${durationMin}min | $${cost.toFixed(4)} | ${turns} turns\n` +
        `📊 Tokens: ${totalInput.toLocaleString()} in (${newInput.toLocaleString()} new + ${cacheCreate.toLocaleString()} cache-write + ${cacheRead.toLocaleString()} cache-read) | ${output.toLocaleString()} out`
      );
    } catch {
      log(`Crawl complete in ${durationMin}min (couldn't parse usage envelope)`);
      await postToSlack(MONITORING_CHANNEL, `✅ Master crawl complete — ${durationMin}min`);
    }

    return { success: true, durationMs };
  } finally {
    try { unlinkSync(tmpPromptPath); } catch { /* cleanup best-effort */ }
  }
}
