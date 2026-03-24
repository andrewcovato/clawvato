/**
 * Fast Path — direct Anthropic API for memory queries and single-source lookups.
 *
 * Simplified agent loop: messages.create with limited tools, 10 turns, 60s timeout.
 * ~1-3s response time, ~$0.01/call.
 *
 * Tools available:
 * - search_memory, update_working_context (memory)
 * - google_calendar_list_events, google_calendar_get_event (single calendar checks)
 * - google_gmail_search (thread listing only — no reading/analysis)
 * - slack_get_channel_history (single channel lookup)
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { WebClient } from '@slack/web-api';
import type { Sql } from '../db/index.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { NO_RESPONSE } from '../prompts.js';
import { searchMemories, supersedeMemory, type MemoryType } from '../memory/store.js';
import { preToolUse, type ToolUseContext } from '../hooks/pre-tool-use.js';
import { postToolUse, type ToolResult } from '../hooks/post-tool-use.js';
import { validatePath } from '../security/path-validator.js';
import type { ToolHandlerResult } from '../mcp/slack/server.js';
import type { SlackHandler } from '../slack/handler.js';

// Fast path limits are read from config.agent.fastPathMaxTurns / fastPathTimeoutMs

// ── Tool progress descriptions ──
const TOOL_DESCRIPTIONS: Record<string, string> = {
  search_memory: 'Searching memory...',
  update_working_context: 'Updating working context...',
  google_calendar_list_events: 'Checking your calendar...',
  google_calendar_get_event: 'Looking up event details...',
  google_calendar_freebusy: 'Checking availability...',
  google_gmail_search: 'Searching email...',
  google_gmail_read: 'Reading email thread...',
  google_drive_search: 'Searching Drive...',
  google_drive_get_file: 'Looking up file details...',
  fireflies_search_meetings: 'Searching meetings...',
  fireflies_get_summary: 'Reading meeting summary...',
  slack_get_channel_history: 'Reading channel history...',
  slack_search_messages: 'Searching Slack...',
  web_search: 'Searching the web...',
  delete_memory: 'Correcting memory...',
  list_tasks: 'Checking task queue...',
  create_task: 'Creating task...',
  update_task: 'Updating task...',
  delete_task: 'Removing task...',
};

export interface FastPathOptions {
  client: Anthropic;
  db: Sql;
  /** Tool definitions + handlers for fast-path tools only */
  tools: Array<{ definition: Anthropic.Tool; handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> }>;
  /** Override the model (default: config.models.executor) */
  model?: string;
}

export interface FastPathResult {
  response: string;
  success: boolean;
  durationMs: number;
}

/**
 * Create the fast-path memory tools (always available).
 */
export function createFastPathMemoryTools(db: Sql): Array<{ definition: Anthropic.Tool; handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> }> {
  return [
    {
      definition: {
        name: 'search_memory',
        description:
          'Search and browse stored memories. With a query: keyword search. Without a query: browse by importance/recency. ' +
          'Supports filtering by type and source.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search keywords (optional — omit to browse)' },
            type: {
              type: 'string',
              description: 'Filter by memory category (e.g. "fact", "research", "technical", "decision", "commitment", "strategy", "project", "artifact", "relationship", "reflection")',
            },
            source_filter: {
              type: 'string',
              description: 'Filter by source prefix (e.g., "gmail", "fireflies", "deep"). Optional.',
            },
            limit: { type: 'number', description: 'Max results (default 20, max 50)' },
            min_importance: { type: 'number', description: 'Min importance 1-10 (default 1)' },
          },
          required: [],
        },
      },
      handler: async (args) => {
        const query = (args.query as string | undefined) ?? '';
        const type = args.type as MemoryType | undefined;
        const sourceFilter = args.source_filter as string | undefined;
        const limit = Math.min((args.limit as number) ?? 20, 50);
        const minImportance = args.min_importance as number | undefined;

        const results = await searchMemories(db, query, { limit, type, sourcePrefix: sourceFilter, minImportance });

        if (results.length === 0) {
          return { content: query ? `No memories found for "${query}".` : 'No memories stored yet.' };
        }

        const lines = results.map(m => {
          const conf = m.confidence >= 0.9 ? '' : ` [${Math.round(m.confidence * 100)}%]`;
          const src = m.source.split(':')[0];
          return `- [${m.type}|${src}|imp:${m.importance}|id:${m.id.slice(0, 8)}] ${m.content}${conf}`;
        });

        return { content: `Found ${results.length} memories:\n${lines.join('\n')}` };
      },
    },
    {
      definition: {
        name: 'update_working_context',
        description:
          'Update scratch pad with operational details. Persists across messages. Set clear=true to remove.',
        input_schema: {
          type: 'object' as const,
          properties: {
            key: { type: 'string', description: 'Short label' },
            value: { type: 'string', description: 'The detail to remember' },
            clear: { type: 'boolean', description: 'Set to true to remove this key' },
          },
          required: ['key'],
        },
      },
      handler: async (args) => {
        const key = `wctx:${args.key as string}`;
        if (args.clear) {
          await db`DELETE FROM agent_state WHERE key = ${key}`;
          return { content: `Working context cleared: ${args.key}` };
        }
        const value = args.value as string;
        await db`
          INSERT INTO agent_state (key, value, status, updated_at)
          VALUES (${key}, ${value}, 'active', NOW())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, status = 'active', updated_at = NOW()
        `;
        return { content: `Working context updated: ${args.key} = ${value}` };
      },
    },
    {
      definition: {
        name: 'delete_memory',
        description:
          'Invalidate a memory by ID. Use this to correct wrong information — search first to find the ID, then delete the bad entry. ' +
          'The memory is soft-deleted (kept for audit) but excluded from future retrieval.',
        input_schema: {
          type: 'object' as const,
          properties: {
            id: { type: 'string', description: 'Memory ID (first 8 chars is enough)' },
            reason: { type: 'string', description: 'Why this memory is being invalidated' },
          },
          required: ['id'],
        },
      },
      handler: async (args) => {
        let memoryId = args.id as string;

        // Short ID expansion
        if (memoryId.length < 36) {
          const [match] = await db`
            SELECT id FROM memories WHERE id LIKE ${memoryId + '%'} AND valid_until IS NULL LIMIT 1
          `;
          if (!match) return { content: `No active memory found matching ID "${memoryId}".` };
          memoryId = match.id as string;
        }

        // Soft-delete by setting valid_until
        await db`UPDATE memories SET valid_until = NOW() WHERE id = ${memoryId}`;

        const reason = (args.reason as string) ?? 'manually invalidated';
        logger.info({ memoryId, reason }, 'Memory invalidated by agent');

        return { content: `Memory ${memoryId.slice(0, 8)} invalidated (${reason}).` };
      },
    },
    {
      definition: {
        name: 'read_file',
        description:
          'Read a file from the server filesystem. Returns the file content (or a portion of it). ' +
          'Use for reading debug workspaces, config files, logs, or any server-side file.',
        input_schema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Absolute file path' },
            offset: { type: 'number', description: 'Start reading from this line (0-indexed, default 0)' },
            limit: { type: 'number', description: 'Max lines to return (default 200)' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        try {
          const filePath = args.path as string;
          const offset = (args.offset as number) ?? 0;
          const limit = (args.limit as number) ?? 200;

          // Defense-in-depth: validate path even if pre-tool hook missed it
          const config = getConfig();
          const pathCheck = validatePath(filePath, config.sandboxRoots);
          if (!pathCheck.allowed) {
            logger.warn({ tool: 'read_file', path: filePath, reason: pathCheck.reason }, 'read_file: path validation failed');
            return { content: `Path blocked: ${pathCheck.reason}`, isError: true };
          }

          const content = readFileSync(filePath, 'utf-8');
          const lines = content.split('\n');
          const slice = lines.slice(offset, offset + limit);
          const totalLines = lines.length;

          const header = `File: ${filePath} (${totalLines} lines, ${content.length} bytes)`;
          const range = `Showing lines ${offset + 1}-${Math.min(offset + limit, totalLines)} of ${totalLines}`;

          return { content: `${header}\n${range}\n\n${slice.join('\n')}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Failed to read file: ${msg}`, isError: true };
        }
      },
    },
    {
      definition: {
        name: 'list_files',
        description:
          'List files and directories at a given path. Use to explore debug workspaces, data directories, etc.',
        input_schema: {
          type: 'object' as const,
          properties: {
            path: { type: 'string', description: 'Directory path to list' },
          },
          required: ['path'],
        },
      },
      handler: async (args) => {
        try {
          const dirPath = args.path as string;

          // Defense-in-depth: validate path even if pre-tool hook missed it
          const config = getConfig();
          const pathCheck = validatePath(dirPath, config.sandboxRoots);
          if (!pathCheck.allowed) {
            logger.warn({ tool: 'list_files', path: dirPath, reason: pathCheck.reason }, 'list_files: path validation failed');
            return { content: `Path blocked: ${pathCheck.reason}`, isError: true };
          }

          const entries = readdirSync(dirPath);
          const details = entries.map(name => {
            try {
              const stat = statSync(join(dirPath, name));
              const type = stat.isDirectory() ? 'dir' : 'file';
              const size = stat.isFile() ? ` (${stat.size} bytes)` : '';
              return `${type}: ${name}${size}`;
            } catch {
              return `???: ${name}`;
            }
          });
          return { content: `${dirPath} (${entries.length} entries):\n${details.join('\n')}` };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { content: `Failed to list directory: ${msg}`, isError: true };
        }
      },
    },
  ];
}

/**
 * Execute a fast-path query via direct Anthropic API.
 */
export async function executeFastPath(
  userPrompt: string,
  systemPrompt: string,
  opts: FastPathOptions,
  handler?: SlackHandler,
): Promise<FastPathResult> {
  const config = getConfig();
  const startTime = Date.now();

  const toolDefs = opts.tools.map(t => t.definition);
  const toolHandlers = new Map(opts.tools.map(t => [t.definition.name, t.handler]));

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, config.agent.fastPathTimeoutMs);

  try {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userPrompt },
    ];

    let finalResponse = '';

    for (let turn = 0; turn < config.agent.fastPathMaxTurns; turn++) {
      if (abortController.signal.aborted) break;

      const response = await opts.client.messages.create({
        model: opts.model ?? config.models.executor,
        max_tokens: config.agent.fastPathMaxTokens,
        system: systemPrompt,
        tools: [
          ...toolDefs,
          // Server-side web search — Anthropic handles execution, no handler needed
          { type: 'web_search_20250305' as const, name: 'web_search', max_uses: 3 },
        ],
        messages,
      });

      const textBlocks = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map(b => b.text);
      const toolUseBlocks = response.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

      const hasToolCalls = toolUseBlocks.length > 0;
      const isLastTurn = !hasToolCalls || response.stop_reason === 'end_turn';

      if (textBlocks.length > 0 && isLastTurn) {
        finalResponse = textBlocks.join('\n');
      }

      // If response only has server-side tool blocks (web_search) and text, it's done
      if (isLastTurn) break;

      // Process tool calls
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        const toolHandler = toolHandlers.get(toolUse.name);
        if (!toolHandler) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Unknown tool: ${toolUse.name}`,
            is_error: true,
          });
          continue;
        }

        const toolInput = (toolUse.input ?? {}) as Record<string, unknown>;

        // Security checks
        if (!runFastPathPreToolChecks(toolUse.name, toolInput, config.ownerSlackUserId)) {
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Tool call blocked by security policy.',
            is_error: true,
          });
          continue;
        }

        // Progress update
        if (handler) {
          const desc = TOOL_DESCRIPTIONS[toolUse.name] ?? `Working on ${toolUse.name}...`;
          await handler.updateProgress(desc);
        }

        // Execute
        logger.info({ tool: toolUse.name }, 'Fast path: executing tool');
        const result = await toolHandler(toolInput);

        // Post-tool audit (on text content)
        const sanitized = runFastPathPostToolChecks(toolUse.name, toolInput, result.content, !!result.isError);

        // Use rich content blocks for multimodal results (PDFs, images), else text
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          // contentBlocks may include document blocks (PDFs) which the API accepts
          // but the SDK types don't fully cover — cast to satisfy TypeScript
          content: (result.contentBlocks ?? sanitized) as Anthropic.ToolResultBlockParam['content'],
          is_error: result.isError,
        });
      }

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    return {
      response: finalResponse,
      success: true,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error({ error: msg }, 'Fast path failed');
    return {
      response: '',
      success: false,
      durationMs: Date.now() - startTime,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// Tools that perform filesystem operations and must go through path validation
const FILESYSTEM_TOOLS = new Set(['read_file', 'list_files']);

function runFastPathPreToolChecks(
  toolName: string,
  toolInput: Record<string, unknown>,
  senderSlackId?: string,
): boolean {
  const serverName = toolName.startsWith('google_') ? 'google'
    : toolName.startsWith('slack_') ? 'slack'
    : (FILESYSTEM_TOOLS.has(toolName) && typeof toolInput.path === 'string') ? 'filesystem'
    : 'agent';

  const ctx: ToolUseContext = { toolName, serverName, input: toolInput, senderSlackId };
  const secResult = preToolUse(ctx);
  if (!secResult.allowed) {
    logger.warn({ toolName, reason: secResult.reason }, 'Fast path: tool blocked by security');
    return false;
  }

  return true;
}

function runFastPathPostToolChecks(
  toolName: string,
  toolInput: Record<string, unknown>,
  output: string,
  isError: boolean,
): string {
  const serverName = toolName.startsWith('google_') ? 'google'
    : toolName.startsWith('slack_') ? 'slack'
    : (FILESYSTEM_TOOLS.has(toolName) && typeof toolInput.path === 'string') ? 'filesystem'
    : 'agent';

  const result: ToolResult = {
    toolName,
    serverName,
    input: toolInput,
    output,
    success: !isError,
    error: isError ? output : undefined,
    durationMs: 0,
  };

  const { sanitizedOutput } = postToolUse(result);

  return String(sanitizedOutput);
}
