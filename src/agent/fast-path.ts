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

import Anthropic from '@anthropic-ai/sdk';
import type { WebClient } from '@slack/web-api';
import type { DatabaseSync } from 'node:sqlite';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { NO_RESPONSE } from '../prompts.js';
import { searchMemories, findPersonByName, type MemoryType } from '../memory/store.js';
import { preToolUse, type ToolUseContext } from '../hooks/pre-tool-use.js';
import { postToolUse, type ToolResult } from '../hooks/post-tool-use.js';
import { evaluatePolicy } from '../training-wheels/policy-engine.js';
import { isGraduated, recordOccurrence } from '../training-wheels/graduation.js';
import type { ToolHandlerResult } from '../mcp/slack/server.js';
import type { SlackHandler } from '../slack/handler.js';

const FAST_PATH_MAX_TURNS = 10;
const FAST_PATH_TIMEOUT_MS = 60_000;

// ── Tool progress descriptions ──
const TOOL_DESCRIPTIONS: Record<string, string> = {
  search_memory: 'Searching memory...',
  update_working_context: 'Updating working context...',
  google_calendar_list_events: 'Checking your calendar...',
  google_calendar_get_event: 'Looking up event details...',
  google_gmail_search: 'Searching email...',
  slack_get_channel_history: 'Reading channel history...',
};

export interface FastPathOptions {
  client: Anthropic;
  db: DatabaseSync;
  /** Tool definitions + handlers for fast-path tools only */
  tools: Array<{ definition: Anthropic.Tool; handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> }>;
}

export interface FastPathResult {
  response: string;
  success: boolean;
  durationMs: number;
}

/**
 * Create the fast-path memory tools (always available).
 */
export function createFastPathMemoryTools(db: DatabaseSync): Array<{ definition: Anthropic.Tool; handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> }> {
  return [
    {
      definition: {
        name: 'search_memory',
        description:
          'Search memory for facts, decisions, preferences, commitments, or people. ' +
          'Supports filtering by type, source, and importance.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'What to search for' },
            type: {
              type: 'string',
              enum: ['fact', 'preference', 'decision', 'observation', 'reflection', 'strategy', 'conclusion', 'commitment'],
              description: 'Filter by memory type (optional)',
            },
            source_filter: {
              type: 'string',
              enum: ['gmail', 'fireflies', 'drive', 'slack', 'scan'],
              description: 'Filter by source (optional)',
            },
            limit: { type: 'number', description: 'Max results (default 10, max 50)' },
            min_importance: { type: 'number', description: 'Min importance 1-10 (default 1)' },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = args.query as string;
        const type = args.type as MemoryType | undefined;
        const sourceFilter = args.source_filter as string | undefined;
        const limit = Math.min((args.limit as number) ?? 10, 50);
        const minImportance = args.min_importance as number | undefined;

        const results = searchMemories(db, query, { limit, type, sourcePrefix: sourceFilter, minImportance });

        if (results.length === 0) {
          const person = findPersonByName(db, query);
          if (person) {
            const parts = [person.name];
            if (person.role) parts.push(person.role);
            if (person.organization) parts.push(`at ${person.organization}`);
            if (person.email) parts.push(`(${person.email})`);
            if (person.notes) parts.push(`— ${person.notes}`);
            return { content: `Person: ${parts.join(', ')}` };
          }
          return { content: `No memories found for "${query}".` };
        }

        const lines = results.map(m => {
          const conf = m.confidence >= 0.9 ? '' : ` [${Math.round(m.confidence * 100)}%]`;
          const src = m.source.split(':')[0];
          return `- [${m.type}|${src}|imp:${m.importance}] ${m.content}${conf}`;
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
          db.prepare("DELETE FROM agent_state WHERE key = ?").run(key);
          return { content: `Working context cleared: ${args.key}` };
        }
        const value = args.value as string;
        db.prepare(
          "INSERT OR REPLACE INTO agent_state (key, value, status, updated_at) VALUES (?, ?, 'active', datetime('now'))"
        ).run(key, value);
        return { content: `Working context updated: ${args.key} = ${value}` };
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
  }, FAST_PATH_TIMEOUT_MS);

  try {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userPrompt },
    ];

    let finalResponse = '';

    for (let turn = 0; turn < FAST_PATH_MAX_TURNS; turn++) {
      if (abortController.signal.aborted) break;

      const response = await opts.client.messages.create({
        model: config.models.executor,
        max_tokens: 4096,
        system: systemPrompt,
        tools: toolDefs,
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
        if (!runFastPathPreToolChecks(opts.db, toolUse.name, toolInput, config.ownerSlackUserId)) {
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

        // Post-tool audit
        const sanitized = runFastPathPostToolChecks(opts.db, toolUse.name, toolInput, result.content, !!result.isError);

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: sanitized,
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

function runFastPathPreToolChecks(
  db: DatabaseSync,
  toolName: string,
  toolInput: Record<string, unknown>,
  senderSlackId?: string,
): boolean {
  const serverName = toolName.startsWith('google_') ? 'google' : toolName.startsWith('slack_') ? 'slack' : 'agent';
  const config = getConfig();

  const ctx: ToolUseContext = { toolName, serverName, input: toolInput, senderSlackId };
  const secResult = preToolUse(ctx);
  if (!secResult.allowed) {
    logger.warn({ toolName, reason: secResult.reason }, 'Fast path: tool blocked by security');
    return false;
  }

  const graduated = isGraduated(db, toolName);
  const policy = evaluatePolicy(toolName, graduated, config.trustLevel);
  if (!policy.autoApproved) {
    logger.info({ toolName, reason: policy.reason }, 'Fast path: tool blocked by training wheels');
    return false;
  }

  return true;
}

function runFastPathPostToolChecks(
  db: DatabaseSync,
  toolName: string,
  toolInput: Record<string, unknown>,
  output: string,
  isError: boolean,
): string {
  const serverName = toolName.startsWith('google_') ? 'google' : toolName.startsWith('slack_') ? 'slack' : 'agent';

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

  try {
    recordOccurrence(db, toolName, `Tool call: ${toolName}`, {}, 'approved');
  } catch { /* non-critical */ }

  return String(sanitizedOutput);
}
