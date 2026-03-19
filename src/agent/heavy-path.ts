/**
 * Heavy Path — Claude Code SDK integration for complex, multi-source tasks.
 *
 * Uses `claude --print` subprocess for reasoning-heavy work:
 * - Cross-source queries (email + meetings + drive + memory)
 * - Multi-step analysis and synthesis
 * - Document deep reads and complex reasoning
 *
 * Free on Max plan. ~10-60s per interaction.
 *
 * The SDK gets access to:
 * - Memory via MCP server (the only MCP server needed)
 * - Google via `gws` CLI (already installed, accessed via bash)
 * - Fireflies via `tools/fireflies.ts` CLI wrapper (accessed via bash)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import type { SlackHandler } from '../slack/handler.js';

export interface HeavyPathOptions {
  /** Data directory for the memory MCP server */
  dataDir: string;
  /** System prompt to append to SDK context */
  systemPrompt: string;
  /** Memory context string (pre-assembled) */
  memoryContext: string;
  /** Working context string */
  workingContext: string;
}

export interface HeavyPathResult {
  /** The SDK's final text response */
  response: string;
  /** Whether the invocation succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Build the MCP config file for the SDK subprocess.
 * Returns path to a temp file containing the config JSON.
 */
function buildMcpConfig(dataDir: string): { configPath: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'clawvato-mcp-'));
  const configPath = join(tmpDir, 'mcp-config.json');

  const config = {
    mcpServers: {
      memory: {
        command: 'npx',
        args: ['tsx', 'src/mcp/memory/stdio.ts', '--data-dir', dataDir],
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2));

  return {
    configPath,
    cleanup: () => {
      try { rmSync(tmpDir, { recursive: true }); } catch { /* best effort */ }
    },
  };
}

/**
 * Build the system prompt addendum for the SDK.
 * Gives the SDK context about available tools and the owner's preferences.
 */
function buildSdkSystemPrompt(opts: HeavyPathOptions): string {
  const parts: string[] = [];

  parts.push(`You are Clawvato, a personal AI chief of staff. You're handling a complex request that requires multi-source reasoning.`);

  parts.push(`\n## Available Data Sources\n`);
  parts.push(`- **Memory**: Use the memory MCP tools (search_memory, retrieve_context, store_fact, etc.) for cross-session knowledge.`);
  parts.push(`- **Google (Gmail, Calendar, Drive)**: Use bash to run \`gws\` CLI commands. Examples:`);
  parts.push(`  - \`gws gmail users threads list --params '{"userId":"me","q":"after:2026/02/15 from:sarah"}'\``);
  parts.push(`  - \`gws gmail users threads get --params '{"userId":"me","id":"THREAD_ID"}'\``);
  parts.push(`  - \`gws calendar events list --params '{"calendarId":"primary","timeMin":"2026-03-18T00:00:00Z","timeMax":"2026-03-19T23:59:59Z"}'\``);
  parts.push(`  - \`gws drive files list --params '{"q":"name contains \\'budget\\' and trashed = false","pageSize":20}'\``);
  parts.push(`- **Fireflies (meeting transcripts)**: Use bash to run the Fireflies CLI. Examples:`);
  parts.push(`  - \`npx tsx tools/fireflies.ts search --query "budget" --days-back 60\``);
  parts.push(`  - \`npx tsx tools/fireflies.ts summary --id "TRANSCRIPT_ID"\``);
  parts.push(`  - \`npx tsx tools/fireflies.ts transcript --id "TRANSCRIPT_ID"\``);

  parts.push(`\n## Guidelines\n`);
  parts.push(`- Be concise. The response will be posted to Slack.`);
  parts.push(`- Do NOT use Markdown tables — Slack doesn't render them. Use bulleted lists with bold labels.`);
  parts.push(`- Cite sources: "From email:", "From meeting:", "From memory:"`);
  parts.push(`- Store important discoveries in memory (store_fact) so they persist across sessions.`);
  parts.push(`- If you read emails or meeting transcripts, the extraction pipeline will pick up facts automatically.`);

  if (opts.memoryContext) {
    parts.push(`\n## Memory Context\n${opts.memoryContext}`);
  }

  if (opts.workingContext) {
    parts.push(`\n${opts.workingContext}`);
  }

  return parts.join('\n');
}

/**
 * Execute a heavy-path query via the Claude Code SDK.
 *
 * Spawns `claude --print` as a subprocess with MCP config and system prompt.
 * Streams output and provides progress updates to Slack.
 */
export async function executeHeavyPath(
  userPrompt: string,
  opts: HeavyPathOptions,
  handler?: SlackHandler,
): Promise<HeavyPathResult> {
  const startTime = Date.now();
  const config = getConfig();

  const { configPath, cleanup } = buildMcpConfig(opts.dataDir);

  try {
    const sdkSystemPrompt = buildSdkSystemPrompt(opts);

    const args = [
      '--print',
      '--output-format', 'text',
      '--model', 'claude-opus-4-6',
      '--mcp-config', configPath,
      '--append-system-prompt', sdkSystemPrompt,
      '--max-turns', '25',
      // Pre-approve bash commands the SDK needs — gws (Google), fireflies CLI, and general read tools
      '--allowedTools',
      'Bash(gws:*)', 'Bash(npx:*)', 'Bash(cat:*)', 'Bash(ls:*)',
      'Read', 'Glob', 'Grep',
      'mcp__memory__search_memory', 'mcp__memory__retrieve_context',
      'mcp__memory__store_fact', 'mcp__memory__update_working_context',
      'mcp__memory__list_people', 'mcp__memory__list_commitments',
    ];

    logger.info({ promptLength: userPrompt.length }, 'Starting heavy path SDK call');

    if (handler) {
      await handler.updateProgress('Thinking deeply about this...');
    }

    const result = await spawnClaude(args, userPrompt, {
      timeoutMs: config.agent.timeoutMs,
      onProgress: handler ? async (text: string) => {
        try { await handler.updateProgress(text); } catch { /* non-critical */ }
      } : undefined,
    });

    const durationMs = Date.now() - startTime;

    if (result.exitCode !== 0) {
      logger.error({ exitCode: result.exitCode, stderr: result.stderr.slice(0, 500) }, 'SDK call failed');
      return {
        response: '',
        success: false,
        error: result.stderr || `SDK exited with code ${result.exitCode}`,
        durationMs,
      };
    }

    logger.info({ durationMs, responseLength: result.stdout.length }, 'Heavy path complete');

    return {
      response: result.stdout.trim(),
      success: true,
      durationMs,
    };
  } finally {
    cleanup();
  }
}

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn the Claude CLI and capture output.
 */
function spawnClaude(
  args: string[],
  stdinInput: string,
  opts: {
    timeoutMs: number;
    onProgress?: (text: string) => Promise<void>;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    // Strip ANTHROPIC_API_KEY so Claude CLI uses Max plan OAuth instead of API billing
    const { ANTHROPIC_API_KEY: _, ...cleanEnv } = process.env;
    const proc: ChildProcess = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
      cwd: process.cwd(),
    });

    let stdout = '';
    let stderr = '';
    let progressUpdateSent = false;

    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;

      // Send progress update after first substantial output
      if (!progressUpdateSent && stdout.length > 100 && opts.onProgress) {
        progressUpdateSent = true;
        void opts.onProgress('Analyzing and synthesizing...');
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Write the user prompt to stdin
    proc.stdin?.write(stdinInput);
    proc.stdin?.end();

    const timeout = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`SDK call timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
