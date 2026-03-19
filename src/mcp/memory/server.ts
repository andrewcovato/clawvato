/**
 * Memory MCP Server — exposes the SQLite memory store to the Claude Code SDK.
 *
 * This is the ONLY MCP server needed for the hybrid architecture.
 * Google uses `gws` CLI, Fireflies uses a thin CLI wrapper, Slack is bot-only.
 *
 * Protocol: JSON-RPC over stdio (MCP standard).
 * Tools: search_memory, store_fact, update_working_context, list_people, list_commitments
 */

import { createInterface } from 'node:readline';
import { getConfig } from '../../config.js';
import type { DatabaseSync } from 'node:sqlite';
import {
  searchMemories,
  findPersonByName,
  getAllPeople,
  insertMemory,
  findMemoriesByType,
  findOrCreateCategory,
  type MemoryType,
} from '../../memory/store.js';
import { retrieveContext } from '../../memory/retriever.js';
import { logger } from '../../logger.js';

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
    name: 'list_people',
    description:
      'List known people from memory, ordered by interaction frequency. ' +
      'Returns names, roles, organizations, and contact info.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
  {
    name: 'list_commitments',
    description:
      'List outstanding commitments and promises from memory. ' +
      'Returns who committed to what, when, and the source.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
      required: [],
    },
  },
];

// ── Tool Handlers ──

function handleSearchMemory(db: DatabaseSync, args: Record<string, unknown>): string {
  const query = (args.query as string | undefined) ?? '';
  const type = args.type as MemoryType | undefined;
  const sourceFilter = args.source_filter as string | undefined;
  const limit = Math.min((args.limit as number) ?? 20, 50);
  const minImportance = args.min_importance as number | undefined;

  const results = searchMemories(db, query, {
    limit,
    type,
    sourcePrefix: sourceFilter,
    minImportance,
  });

  if (results.length === 0) {
    const person = findPersonByName(db, query);
    if (person) {
      const parts = [person.name];
      if (person.role) parts.push(person.role);
      if (person.organization) parts.push(`at ${person.organization}`);
      if (person.email) parts.push(`(${person.email})`);
      if (person.notes) parts.push(`— ${person.notes}`);
      return `Person: ${parts.join(', ')}`;
    }
    return `No memories found for "${query}".`;
  }

  const lines = results.map(m => {
    const conf = m.confidence >= 0.9 ? '' : ` [${Math.round(m.confidence * 100)}%]`;
    const src = m.source.split(':')[0];
    return `- [${m.type}|${src}|imp:${m.importance}] ${m.content}${conf}`;
  });

  return `Found ${results.length} memories:\n${lines.join('\n')}`;
}

async function handleRetrieveContext(db: DatabaseSync, args: Record<string, unknown>): Promise<string> {
  const message = args.message as string;
  // MCP server is used by deep path / interactive sessions — default to deep budget
  const tokenBudget = (args.token_budget as number | undefined) ?? getConfig().context.deepPathLongTermTokenBudget;

  const result = await retrieveContext(db, message, { tokenBudget });

  if (!result.context) {
    return 'No relevant memories found.';
  }

  return `${result.context}\n\n(${result.memoriesRetrieved} memories, ${result.peopleRetrieved} people, ${result.tokensUsed} tokens)`;
}

function handleStoreFact(db: DatabaseSync, args: Record<string, unknown>): string {
  // Normalize category via findOrCreateCategory (handles fuzzy matching)
  const category = findOrCreateCategory(db, args.type as string);

  const id = insertMemory(db, {
    type: category,
    content: args.content as string,
    source: args.source as string,
    importance: args.importance as number | undefined,
    confidence: args.confidence as number | undefined,
    entities: args.entities as string[] | undefined,
  });

  return `Stored memory ${id} (${category}: "${(args.content as string).slice(0, 60)}...")`;
}

function handleUpdateWorkingContext(db: DatabaseSync, args: Record<string, unknown>): string {
  const key = `wctx:${args.key as string}`;

  if (args.clear) {
    db.prepare("DELETE FROM agent_state WHERE key = ?").run(key);
    return `Working context cleared: ${args.key}`;
  }

  const value = args.value as string;
  db.prepare(
    "INSERT OR REPLACE INTO agent_state (key, value, status, updated_at) VALUES (?, ?, 'active', datetime('now'))"
  ).run(key, value);
  return `Working context updated: ${args.key} = ${value}`;
}

function handleListPeople(db: DatabaseSync, args: Record<string, unknown>): string {
  const limit = (args.limit as number) ?? 20;
  const people = getAllPeople(db, { limit });

  if (people.length === 0) return 'No people in memory yet.';

  const lines = people.map(p => {
    const parts = [p.name];
    if (p.role) parts.push(p.role);
    if (p.organization) parts.push(`at ${p.organization}`);
    if (p.email) parts.push(`(${p.email})`);
    if (p.notes) parts.push(`— ${p.notes}`);
    return `- ${parts.join(', ')}`;
  });

  return `${people.length} people:\n${lines.join('\n')}`;
}

function handleListCommitments(db: DatabaseSync, args: Record<string, unknown>): string {
  const limit = (args.limit as number) ?? 20;
  const commitments = findMemoriesByType(db, 'commitment', { validOnly: true, limit });

  if (commitments.length === 0) return 'No outstanding commitments in memory.';

  const lines = commitments.map(m => {
    const src = m.source.split(':')[0];
    const entities = JSON.parse(m.entities || '[]') as string[];
    const who = entities.length > 0 ? ` (${entities.join(', ')})` : '';
    return `- [${src}|imp:${m.importance}]${who} ${m.content}`;
  });

  return `${commitments.length} commitments:\n${lines.join('\n')}`;
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
export function startMemoryMcpServer(db: DatabaseSync): void {
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
      const result = await handleRequest(db, request);
      sendResponse({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      sendResponse({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: msg } });
    }
  });

  logger.info('Memory MCP server started on stdio');
}

async function handleRequest(db: DatabaseSync, request: JsonRpcRequest): Promise<unknown> {
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
          content = handleSearchMemory(db, toolArgs);
          break;
        case 'retrieve_context':
          content = await handleRetrieveContext(db, toolArgs);
          break;
        case 'store_fact':
          content = handleStoreFact(db, toolArgs);
          break;
        case 'update_working_context':
          content = handleUpdateWorkingContext(db, toolArgs);
          break;
        case 'list_people':
          content = handleListPeople(db, toolArgs);
          break;
        case 'list_commitments':
          content = handleListCommitments(db, toolArgs);
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
        args: ['tsx', 'src/mcp/memory/stdio.ts', '--data-dir', dataDir],
        env: {},
      },
    },
  };
}
