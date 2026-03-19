/**
 * Heavy Path — Claude Code SDK integration for complex, multi-source tasks.
 *
 * Uses `claude --print` subprocess with stream-json output for real-time
 * progress updates. Parses tool calls as they happen and posts milestone
 * updates to Slack.
 *
 * Free on Max plan. ~1-5 min per interaction (Opus, multi-source).
 *
 * The SDK gets access to:
 * - Memory via MCP server (the only MCP server needed)
 * - Google via `gws` CLI (already installed, accessed via bash)
 * - Fireflies via `tools/fireflies.ts` CLI wrapper (accessed via bash)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getConfig } from '../config.js';
import { getPrompts } from '../prompts.js';
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
 * Loads the base prompt from config/prompts/heavy-path.md and appends
 * dynamic context (memory, working context).
 */
function buildSdkSystemPrompt(opts: HeavyPathOptions): string {
  const parts: string[] = [];

  // Base prompt from external file — edit config/prompts/heavy-path.md to tune behavior
  parts.push(getPrompts().heavyPath);

  if (opts.memoryContext) {
    parts.push(`\n## Memory Context\n${opts.memoryContext}`);
  }

  if (opts.workingContext) {
    parts.push(`\n${opts.workingContext}`);
  }

  return parts.join('\n');
}

// ── Progress descriptions for tool calls ──

/**
 * Parse a stream-json tool_use event into a human-friendly progress message.
 */
function describeToolUse(toolName: string, input: string): string | null {
  // Bash commands — parse the actual command being run
  if (toolName === 'Bash') {
    if (input.includes('gws gmail')) return 'Searching Gmail...';
    if (input.includes('gws calendar')) return 'Checking calendar...';
    if (input.includes('gws drive')) return 'Searching Drive...';
    if (input.includes('fireflies.ts search')) return 'Searching meeting transcripts...';
    if (input.includes('fireflies.ts summary')) return 'Reading meeting summary...';
    if (input.includes('fireflies.ts transcript')) return 'Reading meeting transcript...';
    if (input.includes('fireflies.ts list')) return 'Listing recent meetings...';
    return null; // don't report generic bash commands
  }

  // MCP memory tools
  if (toolName.includes('search_memory')) return 'Searching memory...';
  if (toolName.includes('store_fact')) return 'Saving to memory...';
  if (toolName.includes('retrieve_context')) return 'Loading memory context...';
  if (toolName.includes('list_people')) return 'Looking up known contacts...';
  if (toolName.includes('list_commitments')) return 'Checking commitments...';

  // File tools
  if (toolName === 'Read') return 'Reading file...';
  if (toolName === 'Grep') return 'Searching files...';

  return null;
}

/**
 * Execute a heavy-path query via the Claude Code SDK.
 *
 * Uses stream-json output to parse events in real-time and post
 * progress updates to Slack as tool calls happen.
 */
export async function executeHeavyPath(
  userPrompt: string,
  opts: HeavyPathOptions,
  handler?: SlackHandler,
  abortSignal?: AbortSignal,
): Promise<HeavyPathResult> {
  const startTime = Date.now();
  const config = getConfig();

  const { configPath, cleanup } = buildMcpConfig(opts.dataDir);

  try {
    const sdkSystemPrompt = buildSdkSystemPrompt(opts);

    const args = [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      '--model', 'claude-opus-4-6',
      '--mcp-config', configPath,
      '--append-system-prompt', sdkSystemPrompt,
      '--max-turns', '200',
      // Pre-approve bash commands the SDK needs
      '--allowedTools',
      'Bash(gws:*)', 'Bash(npx:*)', 'Bash(cat:*)', 'Bash(ls:*)',
      'Read', 'Glob', 'Grep',
      'mcp__memory__search_memory', 'mcp__memory__retrieve_context',
      'mcp__memory__store_fact', 'mcp__memory__update_working_context',
      'mcp__memory__list_people', 'mcp__memory__list_commitments',
    ];

    logger.info({ promptLength: userPrompt.length }, 'Starting heavy path SDK call');

    if (handler) {
      await handler.updateProgress('Starting deep analysis...');
    }

    const result = await spawnClaudeStreaming(args, userPrompt, {
      timeoutMs: config.agent.timeoutMs,
      abortSignal,
      onProgress: handler ? async (text: string) => {
        try { await handler.updateProgress(text); } catch { /* non-critical */ }
      } : undefined,
    });

    const durationMs = Date.now() - startTime;

    if (!result.success) {
      logger.error({ exitCode: result.exitCode, error: result.error?.slice(0, 500) }, 'SDK call failed');
      return {
        response: '',
        success: false,
        error: result.error || `SDK exited with code ${result.exitCode}`,
        durationMs,
      };
    }

    logger.info({ durationMs, responseLength: result.response.length, toolCalls: result.toolCallCount }, 'Heavy path complete');

    return {
      response: result.response,
      success: true,
      durationMs,
    };
  } finally {
    cleanup();
  }
}

interface StreamResult {
  response: string;
  success: boolean;
  error?: string;
  exitCode: number;
  toolCallCount: number;
}

/**
 * Spawn Claude CLI with stream-json output and parse events in real-time.
 *
 * stream-json emits one JSON object per line:
 *   {"type":"assistant","message":{"role":"assistant","content":[...]}}
 *   {"type":"result","result":"...","duration_ms":123}
 */
function spawnClaudeStreaming(
  args: string[],
  stdinInput: string,
  opts: {
    timeoutMs: number;
    abortSignal?: AbortSignal;
    onProgress?: (text: string) => Promise<void>;
  },
): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    // Strip ANTHROPIC_API_KEY so Claude CLI uses Max plan OAuth
    const { ANTHROPIC_API_KEY: _, ...cleanEnv } = process.env;

    const hasOAuth = !!cleanEnv.CLAUDE_CODE_OAUTH_TOKEN;
    logger.info({ hasOAuth, HOME: cleanEnv.HOME ?? '(unset)' }, 'Spawning claude CLI (stream-json)');

    const proc: ChildProcess = spawn('claude', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
      cwd: process.cwd(),
    });

    proc.on('spawn', () => {
      logger.info({ pid: proc.pid }, 'Claude CLI process spawned');
    });

    // Allow external abort (e.g., owner sends "cancel" in Slack)
    if (opts.abortSignal) {
      const onAbort = () => {
        logger.info({ pid: proc.pid }, 'Heavy path aborted by signal');
        proc.kill('SIGTERM');
      };
      opts.abortSignal.addEventListener('abort', onAbort, { once: true });
      proc.on('close', () => opts.abortSignal!.removeEventListener('abort', onAbort));
    }

    let stderr = '';
    let finalResponse = '';
    let toolCallCount = 0;
    let lastProgressUpdate = '';

    // Parse stdout line by line as stream-json events
    const rl = createInterface({ input: proc.stdout!, terminal: false });

    rl.on('line', (line: string) => {
      if (!line.trim()) return;

      try {
        const event = JSON.parse(line);
        handleStreamEvent(event);
      } catch {
        // Not JSON — might be raw text output, accumulate it
        finalResponse += line + '\n';
      }
    });

    function handleStreamEvent(event: Record<string, unknown>): void {
      const type = event.type as string;

      if (type === 'assistant') {
        // Assistant message with content blocks
        const message = event.message as Record<string, unknown> | undefined;
        const content = message?.content as Array<Record<string, unknown>> | undefined;
        if (!content) return;

        for (const block of content) {
          if (block.type === 'text') {
            // Accumulate text for final response
            finalResponse += (block.text as string) ?? '';
          } else if (block.type === 'tool_use') {
            // Tool call — generate progress update
            toolCallCount++;
            const toolName = (block.name as string) ?? '';
            const toolInput = typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input ?? '');

            const desc = describeToolUse(toolName, toolInput);
            if (desc && desc !== lastProgressUpdate && opts.onProgress) {
              lastProgressUpdate = desc;
              void opts.onProgress(desc);
            }

            logger.debug({ tool: toolName, turn: toolCallCount }, 'SDK tool call');
          }
        }
      } else if (type === 'result') {
        // Final result — use this as the response if available
        const resultText = event.result as string | undefined;
        if (resultText) {
          finalResponse = resultText;
        }
      }
    }

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      logger.warn({ stderrChunk: text.slice(0, 500) }, 'SDK stderr');
    });

    proc.on('exit', (code, signal) => {
      logger.info({ pid: proc.pid, code, signal, toolCalls: toolCallCount, responseLen: finalResponse.length }, 'Claude CLI process exited');
    });

    // Write prompt to stdin
    proc.stdin?.write(stdinInput);
    proc.stdin?.end();

    // Timeout
    const timeout = setTimeout(() => {
      logger.error({ pid: proc.pid, toolCalls: toolCallCount, responseLen: finalResponse.length }, 'SDK call timed out');
      proc.kill('SIGTERM');
      resolve({
        response: finalResponse || '',
        success: finalResponse.length > 0,
        error: finalResponse.length > 0 ? undefined : 'Timed out with no output',
        exitCode: 124,
        toolCallCount,
      });
    }, opts.timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timeout);

      const success = (code === 0 || code === null) && finalResponse.length > 0;
      resolve({
        response: finalResponse,
        success,
        error: success ? undefined : (stderr || `Exited with code ${code}`),
        exitCode: code ?? 1,
        toolCallCount,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}
