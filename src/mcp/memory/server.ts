/**
 * Memory MCP Server — exposes the Postgres memory store to the Claude Code SDK.
 *
 * This is the ONLY MCP server needed for the hybrid architecture.
 * Google uses `gws` CLI, Fireflies uses a thin CLI wrapper, Slack is bot-only.
 *
 * Protocol: JSON-RPC over stdio (MCP standard).
 * Tools: search_memory, store_fact, update_working_context
 */

import { createInterface } from 'node:readline';
import { getConfig } from '../../config.js';
import type { Sql } from '../../db/index.js';
import {
  searchMemories,
  insertMemory,
  findOrCreateCategory,
  type MemoryType,
} from '../../memory/store.js';
import { retrieveContext } from '../../memory/retriever.js';
import { logger } from '../../logger.js';
import {
  createTask as createTaskDb,
  listTasks as listTasksDb,
  updateTask as updateTaskDb,
  deleteTask as deleteTaskDb,
  findTaskByTitle,
  getTask,
  type TaskCreatorType,
} from '../../tasks/store.js';

// ── MCP Tool Definitions ──

const TOOLS = [
  {
    name: 'search_memory',
    description:
      'Search and browse stored memories. With a query: keyword search ranked by relevance. ' +
      'Without a query: returns most important/recent memories. ' +
      'Use filters to narrow by category, source, or importance.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search keywords (optional — omit to browse by importance/recency)' },
        type: {
          type: 'string',
          description: 'Filter by category (e.g., "fact", "technical", "research", "decision", "project"). Optional.',
        },
        source_filter: {
          type: 'string',
          description: 'Filter by source prefix (e.g., "gmail", "fireflies", "deep", "cc-session"). Optional.',
        },
        limit: { type: 'number', description: 'Max results (default 20, max 50)' },
        min_importance: { type: 'number', description: 'Minimum importance 1-10 (default 1)' },
      },
      required: [],
    },
  },
  {
    name: 'retrieve_context',
    description:
      'Get token-budgeted memory context for a topic. Returns people, preferences, ' +
      'relevant facts, and recent decisions — formatted and ready to use. ' +
      'Better than raw search when you need a concise summary of everything known about a topic.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'The topic or question to retrieve context for' },
        token_budget: { type: 'number', description: 'Max tokens to retrieve (default 1500)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'store_fact',
    description:
      'Store any knowledge worth remembering: facts, technical discoveries, research findings, ' +
      'decisions, project context, creative ideas, preferences, commitments, and more. ' +
      'Use after learning something valuable that should persist across sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        type: {
          type: 'string',
          description: 'Category (e.g., "fact", "technical", "research", "decision", "project", "learning", "artifact"). Use an existing category or suggest a new one.',
        },
        content: { type: 'string', description: 'What to remember — include context and WHY so this is useful months later' },
        source: { type: 'string', description: 'Where this came from (e.g., "gmail:thread123", "meeting:acme-sync")' },
        importance: { type: 'number', description: 'Importance 1-10 (default 5)' },
        confidence: { type: 'number', description: 'Confidence 0-1 (default 0.8)' },
        entities: {
          type: 'array',
          items: { type: 'string' },
          description: 'People or things this is about (e.g., ["Sarah", "Acme Corp"])',
        },
      },
      required: ['type', 'content', 'source'],
    },
  },
  {
    name: 'update_working_context',
    description:
      'Update the scratch pad with operational details: IDs, task progress, findings. ' +
      'Persists across messages. Set clear=true to remove an entry.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Short label (e.g. "current_task", "draft_email")' },
        value: { type: 'string', description: 'The detail to remember' },
        clear: { type: 'boolean', description: 'Set to true to remove this key' },
      },
      required: ['key'],
    },
  },
  {
    name: 'list_working_contexts',
    description:
      'See what other CC sessions are working on. Shows working context from all active sessions. ' +
      'Useful for coordination and multi-instance awareness.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        session_filter: { type: 'string', description: 'Filter by session ID prefix (optional)' },
      },
      required: [],
    },
  },
  {
    name: 'retire_memory',
    description:
      'Retire a memory that is incorrect or outdated. Sets valid_until = NOW() so it drops out of ' +
      'active search but stays in the DB for audit trail. To correct a fact: store_fact (new version) ' +
      'then retire_memory (old version).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Memory ID to retire' },
        reason: { type: 'string', description: 'Why this memory is being retired (e.g., "incorrect", "outdated", "superseded by ...")' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List scheduled tasks. Shows active and pending tasks by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: { type: 'string', description: 'Filter: active, paused, pending_approval, completed, failed, cancelled, or "all"' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'create_task',
    description:
      'Create a scheduled task. Use created_by_type "owner" when the owner asked for it, "agent" when self-assigning.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short task title' },
        description: { type: 'string', description: 'Detailed instructions' },
        priority: { type: 'number', description: '1-10 (default 5)' },
        cron_expression: { type: 'string', description: '"daily", "daily at 6am", "weekly", "every 3 hours"' },
        delay: { type: 'string', description: '"2 minutes", "3 hours", "1 day"' },
        created_by_type: { type: 'string', enum: ['owner', 'agent'], description: 'Default: owner' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'Update a task by ID or title fragment.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task ID' },
        title_match: { type: 'string', description: 'Fuzzy title match' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'number' },
        cron_expression: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'cancelled'] },
      },
      required: [],
    },
  },
  {
    name: 'delete_task',
    description: 'Cancel a task by ID or title fragment.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Task ID' },
        title_match: { type: 'string', description: 'Fuzzy title match' },
      },
      required: [],
    },
  },
];

// ── Tool Handlers ──

async function handleSearchMemory(sql: Sql, args: Record<string, unknown>): Promise<string> {
  const query = (args.query as string | undefined) ?? '';
  const type = args.type as MemoryType | undefined;
  const sourceFilter = args.source_filter as string | undefined;
  const limit = Math.min((args.limit as number) ?? 20, 50);
  const minImportance = args.min_importance as number | undefined;

  const results = await searchMemories(sql, query, {
    limit,
    type,
    sourcePrefix: sourceFilter,
    minImportance,
  });

  if (results.length === 0) {
    return `No memories found for "${query}".`;
  }

  const lines = results.map(m => {
    const conf = m.confidence >= 0.9 ? '' : ` [${Math.round(m.confidence * 100)}%]`;
    const src = m.source.split(':')[0];
    return `- [${m.type}|${src}|imp:${m.importance}] ${m.content}${conf}`;
  });

  return `Found ${results.length} memories:\n${lines.join('\n')}`;
}

async function handleRetrieveContext(sql: Sql, args: Record<string, unknown>): Promise<string> {
  const message = args.message as string;
  // MCP server is used by deep path / interactive sessions — default to deep budget
  const tokenBudget = (args.token_budget as number | undefined) ?? getConfig().context.deepPathLongTermTokenBudget;

  const result = await retrieveContext(sql, message, { tokenBudget });

  if (!result.context) {
    return 'No relevant memories found.';
  }

  return `${result.context}\n\n(${result.memoriesRetrieved} memories, ${result.tokensUsed} tokens)`;
}

async function handleStoreFact(sql: Sql, args: Record<string, unknown>): Promise<string> {
  // Normalize category via findOrCreateCategory (handles fuzzy matching)
  const category = await findOrCreateCategory(sql, args.type as string);

  const id = await insertMemory(sql, {
    type: category,
    content: args.content as string,
    source: args.source as string,
    importance: args.importance as number | undefined,
    confidence: args.confidence as number | undefined,
    entities: args.entities as string[] | undefined,
  });

  return `Stored memory ${id} (${category}: "${(args.content as string).slice(0, 60)}...")`;
}

async function handleUpdateWorkingContext(sql: Sql, args: Record<string, unknown>): Promise<string> {
  const key = `wctx:${args.key as string}`;

  if (args.clear) {
    await sql`DELETE FROM agent_state WHERE key = ${key}`;
    return `Working context cleared: ${args.key}`;
  }

  const value = args.value as string;
  await sql`
    INSERT INTO agent_state (key, value, status, updated_at)
    VALUES (${key}, ${value}, 'active', NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, status = 'active', updated_at = NOW()
  `;
  return `Working context updated: ${args.key} = ${value}`;
}

// ── List Working Contexts ──

async function handleListWorkingContexts(sql: Sql, args: Record<string, unknown>): Promise<string> {
  const filter = args.session_filter as string | undefined;

  const rows = await sql`
    SELECT key, value, updated_at FROM agent_state
    WHERE key LIKE 'wctx:%' AND status = 'active'
    ${filter ? sql`AND key LIKE ${'wctx:' + filter + '%'}` : sql``}
    ORDER BY updated_at DESC
    LIMIT 50
  ` as unknown as Array<{ key: string; value: string; updated_at: Date }>;

  if (rows.length === 0) return 'No active working contexts.';

  // Group by session (handles both wctx:label and wctx:SESSION_ID:label formats)
  const sessions = new Map<string, Array<{ label: string; value: string }>>();
  for (const r of rows) {
    const parts = r.key.split(':');
    // wctx:SESSION_ID:label or wctx:label
    const sessionId = parts.length >= 3 ? parts[1] : 'default';
    const label = parts.length >= 3 ? parts.slice(2).join(':') : parts[1] || 'unknown';
    const group = sessions.get(sessionId) ?? [];
    group.push({ label, value: r.value });
    sessions.set(sessionId, group);
  }

  const lines: string[] = [];
  for (const [sid, entries] of sessions) {
    lines.push(`\n### Session: ${sid}`);
    for (const e of entries) {
      lines.push(`- **${e.label}**: ${e.value}`);
    }
  }

  return `Active working contexts across ${sessions.size} session(s):${lines.join('\n')}`;
}

// ── Retire Memory (soft-delete) ──

async function handleRetireMemory(sql: Sql, args: Record<string, unknown>): Promise<string> {
  const id = args.id as string;
  const reason = (args.reason as string) ?? 'retired via MCP';

  const result = await sql`
    UPDATE memories SET valid_until = NOW()
    WHERE id = ${id} AND valid_until IS NULL
  `;
  if (Number(result.count ?? 0) === 0) return `Memory ${id} not found (or already retired).`;

  logger.info({ memoryId: id, reason }, 'Memory retired via MCP');
  return `Memory ${id} retired (${reason}). Preserved in DB for audit — will no longer appear in searches.`;
}

// ── Task Handlers ──

async function handleListTasks(sql: Sql, args: Record<string, unknown>): Promise<string> {
  const status = args.status as string | undefined;
  const limit = (args.limit as number) ?? 20;
  const opts = status === 'all' ? { limit } : status ? { status, limit } : { limit };
  const tasks = await listTasksDb(sql, opts);
  if (tasks.length === 0) return 'No active tasks.';
  const lines = tasks.map((t, i) => `${i + 1}. [${t.status}] ${t.title} (${t.cron_expression ?? 'one-shot'})`);
  return `${tasks.length} task(s):\n${lines.join('\n')}`;
}

async function handleCreateTask(sql: Sql, args: Record<string, unknown>): Promise<string> {
  let nextRunAt: string | undefined;
  if (args.delay) {
    const match = (args.delay as string).trim().match(/^(\d+(?:\.\d+)?)\s*(second|minute|min|hour|day|week|month)s?$/i);
    if (match) {
      const n = parseFloat(match[1]);
      const unit = match[2].toLowerCase();
      const ms: Record<string, number> = { second: 1000, minute: 60000, min: 60000, hour: 3600000, day: 86400000, week: 604800000, month: 2592000000 };
      if (ms[unit]) nextRunAt = new Date(Date.now() + n * ms[unit]).toISOString();
    }
  }
  const id = await createTaskDb(sql, {
    title: args.title as string,
    description: args.description as string | undefined,
    priority: args.priority as number | undefined,
    cron_expression: args.cron_expression as string | undefined,
    next_run_at: nextRunAt,
    created_by_type: (args.created_by_type as TaskCreatorType) ?? 'owner',
  });
  return `Task created: "${args.title}" (ID: ${id.slice(0, 8)})`;
}

async function handleUpdateTask(sql: Sql, args: Record<string, unknown>): Promise<string> {
  let taskId = args.id as string | undefined;
  if (!taskId && args.title_match) {
    const found = await findTaskByTitle(sql, args.title_match as string);
    if (!found) return `No task found matching "${args.title_match}".`;
    taskId = found.id;
  }
  if (!taskId) return 'Provide id or title_match.';
  const updates: Record<string, unknown> = {};
  for (const k of ['title', 'description', 'priority', 'cron_expression', 'status']) {
    if (args[k] !== undefined) updates[k] = args[k];
  }
  if (Object.keys(updates).length === 0) return 'No updates provided.';
  const result = await updateTaskDb(sql, taskId, updates as Parameters<typeof updateTaskDb>[2]);
  return result ? `Task updated: ${Object.keys(updates).join(', ')}` : 'Task not found.';
}

async function handleDeleteTask(sql: Sql, args: Record<string, unknown>): Promise<string> {
  let taskId = args.id as string | undefined;
  if (!taskId && args.title_match) {
    const found = await findTaskByTitle(sql, args.title_match as string);
    if (!found) return `No task found matching "${args.title_match}".`;
    taskId = found.id;
  }
  if (!taskId) return 'Provide id or title_match.';
  const success = await deleteTaskDb(sql, taskId);
  return success ? 'Task cancelled.' : 'Task not found.';
}

// ── MCP Protocol ──

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

function sendResponse(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  process.stdout.write(json + '\n');
}

/**
 * Start the Memory MCP server over stdio.
 * Reads JSON-RPC requests from stdin, writes responses to stdout.
 */
export function startMemoryMcpServer(sql: Sql): void {
  const rl = createInterface({ input: process.stdin, terminal: false });

  rl.on('line', async (line: string) => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      sendResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    try {
      const result = await handleRequest(sql, request);
      sendResponse({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sendResponse({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: msg } });
    }
  });

  logger.info('Memory MCP server started on stdio');
}

async function handleRequest(sql: Sql, request: JsonRpcRequest): Promise<unknown> {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'clawvato-memory', version: '1.0.0' },
      };

    case 'notifications/initialized':
      return undefined;

    case 'tools/list':
      return { tools: TOOLS };

    case 'tools/call': {
      const params = request.params ?? {};
      const toolName = params.name as string;
      const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;

      let content: string;
      switch (toolName) {
        case 'search_memory':
          content = await handleSearchMemory(sql, toolArgs);
          break;
        case 'retrieve_context':
          content = await handleRetrieveContext(sql, toolArgs);
          break;
        case 'store_fact':
          content = await handleStoreFact(sql, toolArgs);
          break;
        case 'update_working_context':
          content = await handleUpdateWorkingContext(sql, toolArgs);
          break;
        case 'list_working_contexts':
          content = await handleListWorkingContexts(sql, toolArgs);
          break;
        case 'retire_memory':
          content = await handleRetireMemory(sql, toolArgs);
          break;
        case 'list_tasks':
          content = await handleListTasks(sql, toolArgs);
          break;
        case 'create_task':
          content = await handleCreateTask(sql, toolArgs);
          break;
        case 'update_task':
          content = await handleUpdateTask(sql, toolArgs);
          break;
        case 'delete_task':
          content = await handleDeleteTask(sql, toolArgs);
          break;
        default:
          throw new Error(`Unknown tool: ${toolName}`);
      }

      return { content: [{ type: 'text', text: content }] };
    }

    default:
      throw new Error(`Unknown method: ${request.method}`);
  }
}

/**
 * Generate MCP config JSON for the Claude Code SDK.
 * Points to this server running as a subprocess.
 */
export function getMemoryMcpConfig(dataDir: string): Record<string, unknown> {
  return {
    mcpServers: {
      memory: {
        command: 'npx',
        args: ['tsx', 'src/mcp/memory/stdio.ts'],
        env: {
          DATABASE_URL: process.env.DATABASE_URL ?? '',
        },
      },
    },
  };
}
