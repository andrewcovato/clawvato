/**
 * Agent Orchestrator — direct Anthropic API, no subprocess.
 *
 * Every agent call gets the full recent channel history, formatted as a
 * conversation. Claude reads it like a human scrolling Slack — understanding
 * what's been said, what it already responded to, and what needs attention.
 *
 * Relevance is handled natively: if Claude decides the conversation doesn't
 * need its input, it responds with [NO_RESPONSE] and we stay silent.
 * No separate classifier, no heuristics — one model, one call.
 *
 * The same code path handles both live messages and startup crawl.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { requireCredential } from '../credentials.js';
import { getPrompts, NO_RESPONSE } from '../prompts.js';
import { getDb } from '../db/index.js';
import { createSlackTools, type SlackTool, type ToolHandlerResult } from '../mcp/slack/server.js';
import { google } from 'googleapis';
import { getGoogleAuth } from '../google/auth.js';
import { createGoogleTools } from '../google/tools.js';
import { syncDrive, deepReadFile, listDocuments, findDocumentByName } from '../google/drive-sync.js';
import { retrieveContext } from '../memory/retriever.js';
import { extractFacts, storeExtractionResult } from '../memory/extractor.js';
import { maybeReflect } from '../memory/reflection.js';
import { searchMemories, findPersonByName } from '../memory/store.js';
import { preToolUse, type ToolUseContext } from '../hooks/pre-tool-use.js';
import { postToolUse, type ToolResult } from '../hooks/post-tool-use.js';
import { evaluatePolicy } from '../training-wheels/policy-engine.js';
import { isGraduated, recordOccurrence } from '../training-wheels/graduation.js';
import { classifyInterrupt, generateClarificationMessage } from '../slack/interrupt-classifier.js';
import type { SlackHandler } from '../slack/handler.js';
import type { AccumulatedBatch } from '../slack/event-queue.js';
import type { WebClient } from '@slack/web-api';

// Agent and context limits are loaded from config (config/default.json or ~/.clawvato/config.json).
// See CLAUDE.md "Context Limits" section for documentation.

// ── Tool progress descriptions ──
// Maps tool names to human-friendly progress descriptions for the Slack status message.

const TOOL_DESCRIPTIONS: Record<string, string> = {
  // Calendar
  google_calendar_list_events: 'Checking your calendar...',
  google_calendar_create_event: 'Creating a calendar event...',
  google_calendar_delete_event: 'Deleting a calendar event...',
  google_calendar_update_event: 'Updating a calendar event...',
  google_calendar_find_free: 'Finding free time slots...',
  google_calendar_rsvp: 'Responding to an invite...',
  google_calendar_freebusy: 'Checking availability...',
  google_calendar_get_event: 'Looking up event details...',
  // Gmail
  google_gmail_search: 'Searching your email...',
  google_gmail_read: 'Reading an email...',
  google_gmail_draft: 'Drafting an email...',
  google_gmail_send_draft: 'Sending an email...',
  google_gmail_reply: 'Replying to an email...',
  google_gmail_label: 'Organizing email...',
  // Drive
  google_drive_search: 'Searching Drive...',
  google_drive_get_file: 'Reading a file...',
  google_drive_sync: 'Syncing Drive files...',
  google_drive_read_content: 'Reading file content...',
  google_drive_list_known: 'Listing known files...',
  // Slack
  slack_search_messages: 'Searching Slack messages...',
  slack_post_message: 'Posting a message...',
  slack_get_thread: 'Reading a thread...',
  slack_get_user_info: 'Looking up a user...',
  slack_get_channel_history: 'Reading channel history...',
  // Memory
  search_memory: 'Searching memory...',
  update_working_context: 'Updating working context...',
};

/**
 * Generate a human-friendly progress description for a tool call.
 * Falls back to the tool name if no specific description exists.
 */
function describeToolCall(toolName: string, input: Record<string, unknown>): string {
  const base = TOOL_DESCRIPTIONS[toolName];
  if (base) return base;

  // Generic fallback — convert tool_name to "Running tool name..."
  const friendly = toolName.replace(/_/g, ' ').replace(/^google |^slack /, '');
  return `Working on ${friendly}...`;
}

// System prompt loaded from config/prompts/system.md at startup
// Edit that file to change bot behavior — no code change needed.

export interface Agent {
  /** Process an accumulated batch of messages from the owner */
  processBatch(batch: AccumulatedBatch, handler: SlackHandler): Promise<void>;
  /** Clean up resources */
  shutdown(): Promise<void>;
}

export interface AgentOptions {
  apiKey?: string;
  botClient: WebClient;
  userClient?: WebClient;
}

/**
 * State shared between the agent loop and interrupt checks.
 */
export interface InterruptState {
  type: 'cancel' | 'redirect' | 'additive' | null;
  newMessage?: string;
  clarificationMessage?: string;
}

/** Rough estimate: 1 token ≈ 4 characters */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Build the conversation context by fetching recent channel history.
 * Returns a formatted string with [Owner], [You], and [UserID] prefixes.
 *
 * Fetches up to config.context.shortTermMessageLimit messages, then trims to fit
 * within config.context.shortTermTokenBudget. Messages are newest-first from Slack,
 * reversed to chronological order, and oldest messages are dropped first
 * when the budget is exceeded.
 */
async function buildConversationContext(
  botClient: WebClient,
  channel: string,
  botUserId?: string,
  ownerUserId?: string,
): Promise<string> {
  const config = getConfig();
  try {
    const history = await botClient.conversations.history({
      channel,
      limit: config.context.shortTermMessageLimit,
    });

    const messages = (history.messages ?? [])
      .filter(m => !m.subtype)
      .reverse(); // oldest first

    if (messages.length === 0) return '';

    // Format all messages
    const formatted = messages.map(m => {
      const isBotMsg = !!m.bot_id || (botUserId && m.user === botUserId);
      const isOwner = ownerUserId && m.user === ownerUserId;
      const prefix = isBotMsg ? '[TRUSTED - You]' : isOwner ? '[TRUSTED - Owner]' : `[EXTERNAL - ${m.user}]`;
      return `${prefix}: ${(m.text ?? '').slice(0, config.context.shortTermMsgCharLimit)}`;
    });

    // Apply token budget — keep newest messages (end of array) when trimming
    let startIndex = 0;

    // Compute per-line token costs once
    const tokenCosts = formatted.map(line => estimateTokens(line));
    const totalTokens = tokenCosts.reduce((a, b) => a + b, 0);

    if (totalTokens > config.context.shortTermTokenBudget) {
      // Single pass: trim from the oldest until we fit
      let remaining = totalTokens;
      for (let i = 0; i < formatted.length; i++) {
        if (remaining <= config.context.shortTermTokenBudget) {
          startIndex = i;
          break;
        }
        remaining -= tokenCosts[i];
      }
      logger.debug(
        { total: formatted.length, kept: formatted.length - startIndex, budget: config.context.shortTermTokenBudget },
        'Short-term context trimmed to fit token budget',
      );
    }

    return formatted.slice(startIndex).join('\n');
  } catch (error) {
    logger.debug({ error, channel }, 'Failed to fetch channel history for context');
    return '';
  }
}

/**
 * Check for interrupts at a tool-call checkpoint.
 * Returns the interrupt state if an interrupt was detected and should stop execution.
 */
async function checkInterrupt(
  handler: SlackHandler,
  interruptState: InterruptState,
  classifierFn: (systemPrompt: string, userMessage: string) => Promise<string>,
): Promise<boolean> {
  const interrupt = handler.drainInterrupt();
  if (!interrupt) return false;

  const activeTask = handler.getActiveTask();
  const taskDescription = activeTask?.description ?? 'current task';

  logger.info({ interrupt: interrupt.text.slice(0, 80) }, 'Interrupt detected at tool checkpoint');

  if (activeTask) {
    await handler.ackInterrupt(activeTask.channel, interrupt.ts);
  }

  try {
    const classification = await classifyInterrupt(taskDescription, interrupt.text, classifierFn);

    if (classification.shouldAsk) {
      interruptState.type = 'cancel';
      interruptState.clarificationMessage = generateClarificationMessage(taskDescription, interrupt.text);
      return true;
    }

    switch (classification.type) {
      case 'cancel':
        interruptState.type = 'cancel';
        return true;
      case 'redirect':
        interruptState.type = 'redirect';
        interruptState.newMessage = interrupt.text;
        return true;
      case 'additive':
        interruptState.type = 'additive';
        interruptState.newMessage = interrupt.text;
        return false; // don't stop — additive enriches context
      case 'unrelated':
        logger.info('Unrelated interrupt — will process after current task');
        return false;
    }
  } catch (error) {
    logger.error({ error }, 'Interrupt classification failed — continuing');
  }

  return false;
}

/**
 * Run pre-tool security checks. Returns true if the tool call is allowed.
 */
function runPreToolChecks(toolName: string, toolInput: Record<string, unknown>, senderSlackId?: string): boolean {
  const serverName = toolName.startsWith('google_') ? 'google' : toolName.startsWith('slack_') ? 'slack' : 'agent';
  const db = getDb();
  const config = getConfig();

  const securityCtx: ToolUseContext = { toolName, serverName, input: toolInput, senderSlackId };
  const securityResult = preToolUse(securityCtx);
  if (!securityResult.allowed) {
    logger.warn({ toolName, reason: securityResult.reason }, 'Tool blocked by security check');
    return false;
  }

  const graduated = isGraduated(db, toolName);
  const policy = evaluatePolicy(toolName, graduated, config.trustLevel);
  if (!policy.autoApproved) {
    logger.info({ toolName, reason: policy.reason }, 'Training wheels: tool requires confirmation (allowing for MVP)');
  }

  return true;
}

/**
 * Run post-tool audit and sanitization. Returns the (possibly sanitized) output.
 */
function runPostToolChecks(toolName: string, toolInput: Record<string, unknown>, output: string, isError: boolean) {
  const db = getDb();
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
  } catch (error) {
    logger.debug({ error }, 'Failed to record graduation occurrence — non-critical');
  }

  return String(sanitizedOutput);
}

/**
 * Create the agent orchestrator.
 */
export async function createAgent(options: AgentOptions): Promise<Agent> {
  const config = getConfig();
  const apiKey = options.apiKey ?? await requireCredential('anthropic-api-key');

  const anthropicClient = new Anthropic({ apiKey });

  // Build tool registry
  const slackTools = createSlackTools(options.botClient, options.userClient);
  const toolDefs: Anthropic.Tool[] = slackTools.map(t => t.definition);
  const toolHandlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolHandlerResult>>();
  for (const tool of slackTools) {
    toolHandlers.set(tool.definition.name, tool.handler);
  }

  // Google Workspace tools (conditional — only if credentials configured)
  const googleAuth = await getGoogleAuth();
  if (googleAuth) {
    const googleTools = createGoogleTools(googleAuth);
    for (const tool of googleTools) {
      toolDefs.push(tool.definition);
      toolHandlers.set(tool.definition.name, tool.handler);
    }
    logger.info({ toolCount: googleTools.length }, 'Google Workspace tools loaded');

    // Drive knowledge sync tools
    toolDefs.push({
      name: 'google_drive_sync',
      description:
        'Scan Google Drive and update knowledge of what files exist. Detects new, modified, and removed files. ' +
        'Generates summaries for new/changed files. Use when asked to "sync Drive", "scan my files", or "what files do I have".',
      input_schema: {
        type: 'object' as const,
        properties: {
          folder_id: { type: 'string', description: 'Optional: specific folder ID to scan' },
          folder_name: { type: 'string', description: 'Optional: folder name to search for and scan (resolved to ID automatically)' },
          max_files: { type: 'number', description: 'Max files to scan (default 200, max 500)' },
        },
        required: [],
      },
    });
    toolHandlers.set('google_drive_sync', async (args) => {
      const db = getDb();
      try {
        let folderId = args.folder_id as string | undefined;

        // Resolve folder name to ID if provided
        if (!folderId && args.folder_name) {
          const driveApi = google.drive({ version: 'v3', auth: googleAuth });
          const folderName = String(args.folder_name).replace(/[^a-zA-Z0-9\s.\-_]/g, '');
          const folderResult = await driveApi.files.list({
            q: `name contains '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
            pageSize: 1,
            fields: 'files(id, name)',
          });
          const folder = folderResult.data.files?.[0];
          if (!folder) {
            return { content: `No folder found matching "${args.folder_name}". Try a different name or provide a folder ID.` };
          }
          folderId = folder.id!;
          logger.info({ folderName: folder.name, folderId }, 'Resolved folder name to ID');
        }

        const result = await syncDrive(googleAuth, db, anthropicClient, config.models.classifier, {
          folderId,
          maxFiles: Math.min((args.max_files as number) ?? 200, 500),
        });
        return {
          content: `Drive sync complete: ${result.filesScanned} files scanned. ` +
            `${result.newFiles} new, ${result.updatedFiles} updated, ${result.removedFiles} removed. ` +
            `${result.summariesGenerated} summaries generated, ${result.summariesGenerated + result.memoriesBackfilled} memories created/updated.`,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: `Drive sync failed: ${msg}`, isError: true };
      }
    });

    toolDefs.push({
      name: 'google_drive_read_content',
      description:
        'Read a file from Drive — returns the actual file content so you can answer questions about it. ' +
        'Also extracts facts into long-term memory in the background. ' +
        'Use when asked about a specific document, SOW, proposal, deck, etc.',
      input_schema: {
        type: 'object' as const,
        properties: {
          file_id: { type: 'string', description: 'Google Drive file ID' },
        },
        required: ['file_id'],
      },
    });
    toolHandlers.set('google_drive_read_content', async (args) => {
      const fileId = args.file_id as string;
      const db = getDb();
      const driveApi = google.drive({ version: 'v3', auth: googleAuth });

      try {
        // Get file metadata
        const fileMeta = await driveApi.files.get({
          fileId,
          fields: 'id, name, mimeType, modifiedTime',
        });
        const name = fileMeta.data.name ?? 'Unknown';
        const mimeType = fileMeta.data.mimeType ?? '';

        // Get file content using the unified extraction pipeline
        const { getFileContent } = await import('../google/drive-sync.js');
        const extracted = await getFileContent(driveApi, fileId, mimeType);

        if (!extracted) {
          return { content: `Could not read "${name}" — unsupported file type (${mimeType}).` };
        }

        // For text content, return it directly so the agent can use it
        let contentForAgent = '';
        if (extracted.kind === 'text') {
          contentForAgent = extracted.text;
        } else if (extracted.kind === 'document' || extracted.kind === 'image') {
          // PDF/image — can't return raw bytes as tool content,
          // fall back to deep read extraction
          contentForAgent = '[Binary file — facts extracted below]';
        }

        // Run fact extraction in background (fire-and-forget)
        deepReadFile(googleAuth, db, anthropicClient, config.models.classifier, fileId, config.models.executor)
          .then(result => {
            logger.info({ fileId, name, factsExtracted: result.factsExtracted }, 'Background deep read complete');
          })
          .catch(error => {
            logger.warn({ error: error instanceof Error ? error.message : String(error), fileId }, 'Background deep read failed');
          });

        return {
          content: `File: "${name}" (${mimeType})\n\n${contentForAgent}`,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: `Failed to read file: ${msg}`, isError: true };
      }
    });

    toolDefs.push({
      name: 'google_drive_list_known',
      description:
        'List files the bot already knows about from previous syncs. Returns names, folder paths, summaries, and last sync times. ' +
        'Supports filtering by folder path (e.g., "/Clients/Coles") or file name. ' +
        'Use to browse a specific folder or find a specific file before deep-reading.',
      input_schema: {
        type: 'object' as const,
        properties: {
          search: { type: 'string', description: 'Optional: filter by file name' },
          folder_path: { type: 'string', description: 'Optional: filter by folder path (e.g., "/Clients/Coles"). Shows all files under this path, including subfolders.' },
          limit: { type: 'number', description: 'Max results (default 20)' },
        },
        required: [],
      },
    });
    toolHandlers.set('google_drive_list_known', async (args) => {
      const db = getDb();
      const search = args.search as string | undefined;
      const folderPath = args.folder_path as string | undefined;
      const limit = Math.min((args.limit as number) ?? 20, 50);

      // Folder path filter — list everything under a specific path
      if (folderPath) {
        const normalizedPath = folderPath.replace(/\/+$/, ''); // strip trailing slash
        const docs = db.prepare(`
          SELECT * FROM documents
          WHERE status = 'active' AND folder_path LIKE ?
          ORDER BY folder_path, name
          LIMIT ?
        `).all(`%${normalizedPath}%`, limit) as unknown as import('../google/drive-sync.js').Document[];

        if (docs.length === 0) {
          return { content: `No files found under "${folderPath}". Try google_drive_sync with this folder first.` };
        }

        const lines = docs.map(d => {
          const path = d.folder_path && d.folder_path !== '/' ? ` | ${d.folder_path}` : '';
          const summary = d.summary ? ` — ${d.summary.slice(0, 100)}` : '';
          const deepRead = d.deep_read_at ? ' [deep read]' : '';
          return `- ${d.name}${path} | ${d.modified_time} | ID: ${d.source_id}${deepRead}${summary}`;
        });

        return { content: `${docs.length} files under "${folderPath}":\n${lines.join('\n')}` };
      }

      // Name search
      if (search) {
        const doc = findDocumentByName(db, search);
        if (!doc) return { content: `No known files matching "${search}". Try google_drive_sync first.` };
        const path = doc.folder_path && doc.folder_path !== '/' ? ` | Path: ${doc.folder_path}` : '';
        const summary = doc.summary ? `\n  Summary: ${doc.summary}` : '';
        return {
          content: `Found: ${doc.name} (${doc.mime_type})${path} | Modified: ${doc.modified_time} | ID: ${doc.source_id}${summary}`,
        };
      }

      // No filter — list all
      const docs = listDocuments(db, { limit });
      if (docs.length === 0) {
        return { content: 'No files indexed yet. Use google_drive_sync to scan Drive.' };
      }

      const lines = docs.map(d => {
        const path = d.folder_path && d.folder_path !== '/' ? ` | ${d.folder_path}` : '';
        const summary = d.summary ? ` — ${d.summary.slice(0, 100)}` : '';
        const deepRead = d.deep_read_at ? ' [deep read]' : '';
        return `- ${d.name}${path} | ${d.modified_time} | ID: ${d.source_id}${deepRead}${summary}`;
      });

      return { content: `${docs.length} known files:\n${lines.join('\n')}` };
    });
  } else {
    logger.info('Google Workspace tools not loaded — credentials not configured');
  }

  // Working context tool — scratch pad for operational details
  toolDefs.push({
    name: 'update_working_context',
    description:
      'Update your working scratch pad with important operational details: folder IDs, file IDs, ' +
      'draft IDs, task progress, or anything you need to remember across messages. ' +
      'Use this whenever you perform an action that produces an ID or reference you might need later. ' +
      'Also use it to note what you\'re actively working on.',
    input_schema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string', description: 'Short label (e.g. "sync_folder", "draft_email", "current_task")' },
        value: { type: 'string', description: 'The detail to remember (e.g. "Clients folder ID: 1Jk-abc123")' },
        clear: { type: 'boolean', description: 'Set to true to remove this key (task complete)' },
      },
      required: ['key'],
    },
  });
  toolHandlers.set('update_working_context', async (args) => {
    const key = `wctx:${args.key as string}`;
    const db = getDb();
    try {
      if (args.clear) {
        db.prepare("DELETE FROM agent_state WHERE key = ?").run(key);
        return { content: `Working context cleared: ${args.key}` };
      }
      const value = args.value as string;
      db.prepare(
        "INSERT OR REPLACE INTO agent_state (key, value, status, updated_at) VALUES (?, ?, 'active', datetime('now'))"
      ).run(key, value);
      return { content: `Working context updated: ${args.key} = ${value}` };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Failed to update working context: ${msg}`, isError: true };
    }
  });

  // Memory search tool — Tier 3 deep search, agent calls explicitly
  toolDefs.push({
    name: 'search_memory',
    description:
      'Search your memory for past facts, decisions, preferences, or people. ' +
      'Use when the current context doesn\'t have enough information.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'What to search for' },
        type: { type: 'string', enum: ['fact', 'preference', 'decision', 'observation', 'reflection'], description: 'Filter by memory type (optional)' },
      },
      required: ['query'],
    },
  });
  toolHandlers.set('search_memory', async (args) => {
    const query = args.query as string;
    const type = args.type as string | undefined;
    const db = getDb();

    const results = searchMemories(db, query, {
      limit: 10,
      type: type as 'fact' | 'preference' | 'decision' | 'observation' | 'reflection' | undefined,
    });

    if (results.length === 0) {
      // Also try person lookup
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
      return `- [${m.type}] ${m.content}${conf}`;
    });

    return { content: `Found ${results.length} memories:\n${lines.join('\n')}` };
  });

  // Backfill scan tool — scan channel history and extract memories
  toolDefs.push({
    name: 'scan_channel_history',
    description:
      'Scan a Slack channel\'s recent history and extract facts into long-term memory. ' +
      'Use when asked to "catch up", "scan messages", or "remember what happened". ' +
      'Processes messages in batches and extracts facts, people, strategies, etc.',
    input_schema: {
      type: 'object' as const,
      properties: {
        channel: { type: 'string', description: 'Channel ID to scan' },
        message_count: { type: 'number', description: 'Number of messages to scan (default 100, max 500)' },
      },
      required: ['channel'],
    },
  });
  toolHandlers.set('scan_channel_history', async (args) => {
    const channel = args.channel as string;
    const messageCount = Math.min((args.message_count as number) ?? 100, 500);
    const db = getDb();

    try {
      // Fetch messages in pages of 100
      let allMessages: Array<{ text: string; user: string; ts: string }> = [];
      let cursor: string | undefined;

      while (allMessages.length < messageCount) {
        const limit = Math.min(100, messageCount - allMessages.length);
        const result = await options.botClient.conversations.history({
          channel,
          limit,
          cursor,
        });

        const msgs = (result.messages ?? [])
          .filter(m => !m.subtype && m.text)
          .map(m => ({ text: m.text ?? '', user: m.user ?? 'unknown', ts: m.ts ?? '' }));

        allMessages = allMessages.concat(msgs);

        if (!result.has_more || !result.response_metadata?.next_cursor) break;
        cursor = result.response_metadata.next_cursor;
      }

      if (allMessages.length === 0) {
        return { content: 'No messages found in channel.' };
      }

      // Process in batches of 20 messages
      let totalFacts = 0;
      let totalPeople = 0;
      const batchSize = 20;

      for (let i = 0; i < allMessages.length; i += batchSize) {
        const batch = allMessages.slice(i, i + batchSize);
        const conversationText = [...batch]
          .reverse()
          .map(m => `[${m.user}]: ${m.text.slice(0, 500)}`)
          .join('\n');

        const source = `scan:${channel}:${batch[0]?.ts ?? 'unknown'}`;
        const result = await extractFacts(anthropicClient, config.models.classifier, conversationText, source);

        if (result.facts.length > 0 || result.people.length > 0) {
          const stored = await storeExtractionResult(db, result, source);
          totalFacts += stored.memoriesStored;
          totalPeople += stored.peopleStored;
        }
      }

      return {
        content: `Scanned ${allMessages.length} messages. Extracted ${totalFacts} facts and ${totalPeople} people into long-term memory.`,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { content: `Scan failed: ${msg}`, isError: true };
    }
  });

  // Resolve bot's own user ID for context formatting
  let botUserId: string | undefined;
  try {
    const auth = await options.botClient.auth.test();
    botUserId = auth.user_id as string | undefined;
  } catch { /* non-critical */ }

  /** Haiku classifier — used for interrupt classification */
  async function classifierCall(systemPrompt: string, userMessage: string): Promise<string> {
    const response = await anthropicClient.messages.create({
      model: config.models.classifier,
      max_tokens: 100,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    const textBlock = response.content.find(b => b.type === 'text');
    return textBlock && 'text' in textBlock ? textBlock.text : '';
  }

  logger.info({
    model: config.models.executor,
    trustLevel: config.trustLevel,
  }, 'Agent initialized');

  return {
    async processBatch(batch: AccumulatedBatch, handler: SlackHandler): Promise<void> {
      const message = batch.combinedText;
      const assistantAPI = handler.getAssistantAPI();
      const isAssistantMode = !!assistantAPI;

      logger.info(
        { channel: batch.channel, messageLength: message.length, assistantMode: isAssistantMode },
        'Agent processing batch',
      );

      // ── Build prompt with full conversation context ──
      const conversationHistory = await buildConversationContext(
        options.botClient,
        batch.channel,
        botUserId,
        config.ownerSlackUserId,
      );

      // ── Retrieve relevant memories (Tier 2) ──
      const db = getDb();
      const memoryResult = await retrieveContext(db, message, { tokenBudget: config.context.longTermTokenBudget });

      let userPrompt: string;
      const parts: string[] = [];
      // Resolve channel name for context
      let channelLabel = batch.channel;
      try {
        const channelInfo = await options.botClient.conversations.info({ channel: batch.channel });
        const ch = channelInfo.channel as Record<string, unknown> | undefined;
        channelLabel = (ch?.name as string) ?? (ch?.id as string) ?? batch.channel;
      } catch { /* non-critical — use ID as fallback */ }

      // Load working context from agent_state (token-budgeted)
      let workingContext = '';
      try {
        const rows = db.prepare(
          "SELECT key, value FROM agent_state WHERE key LIKE 'wctx:%' AND status = 'active' ORDER BY updated_at DESC LIMIT 20"
        ).all() as unknown as Array<{ key: string; value: string }>;
        if (rows.length > 0) {
          const lines: string[] = [];
          let wctxTokens = 0;
          for (const r of rows) {
            const line = `- ${r.value}`;
            const tokens = estimateTokens(line);
            if (wctxTokens + tokens > config.context.workingContextTokenBudget) break;
            lines.push(line);
            wctxTokens += tokens;
          }
          if (lines.length > 0) {
            workingContext = `## Working Context\n${lines.join('\n')}`;
          }
        }
      } catch { /* agent_state may not exist */ }

      if (workingContext) {
        parts.push(workingContext);
      }
      if (memoryResult.context) {
        parts.push(memoryResult.context);
      }
      if (conversationHistory) {
        parts.push(`## Recent conversation (in #${channelLabel})\n${conversationHistory}`);
      }
      parts.push(`## New message (in #${channelLabel})\n${message}`);
      userPrompt = parts.join('\n\n---\n\n');

      // Transition from accumulating → processing
      // Handler owns the full reaction lifecycle: removes 👀, adds 🧠, posts progress message
      const lastMsg = batch.messages[batch.messages.length - 1];
      const isRealSlackMessage = !lastMsg.ts.startsWith('crawl-');
      if (isRealSlackMessage) {
        const messageTimestamps = batch.messages.map(m => m.ts);
        await handler.startProcessing(
          message.slice(0, 100),
          batch.channel,
          messageTimestamps,
          batch.threadTs,
        );
      }

      if (isAssistantMode) {
        try {
          const title = message.slice(0, 60) + (message.length > 60 ? '...' : '');
          await assistantAPI.setTitle(title);
        } catch { /* non-critical */ }
        try {
          await assistantAPI.setStatus('Working on it...');
        } catch { /* non-critical */ }
      }

      const interruptState: InterruptState = { type: null };

      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        logger.warn('Agent query timed out after 120s — aborting');
        abortController.abort();
      }, config.agent.timeoutMs);

      try {
        // ── Agent loop: messages.create → tool calls → repeat ──
        const messages: Anthropic.MessageParam[] = [
          { role: 'user', content: userPrompt },
        ];

        let finalResponse = '';

        for (let turn = 0; turn < config.agent.maxTurns; turn++) {
          if (abortController.signal.aborted) break;

          const response = await anthropicClient.messages.create({
            model: config.models.executor,
            max_tokens: 4096,
            system: getPrompts().system,
            tools: toolDefs,
            messages,
          });

          // Extract text and tool_use blocks
          const textBlocks = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text);
          const toolUseBlocks = response.content
            .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

          const hasToolCalls = toolUseBlocks.length > 0;
          const isLastTurn = !hasToolCalls || response.stop_reason === 'end_turn';

          if (textBlocks.length > 0 && isLastTurn) {
            // Final turn — this is the actual response to the user.
            // Mid-loop text (alongside tool calls) is planning/status — we skip it.
            finalResponse = textBlocks.join('\n');
          }

          if (isLastTurn) {
            break;
          }

          // ── Process tool calls ──
          const toolResults: Anthropic.ToolResultBlockParam[] = [];

          for (const toolUse of toolUseBlocks) {
            // Check for interrupts at this checkpoint
            const shouldStop = await checkInterrupt(handler, interruptState, classifierCall);
            if (shouldStop) break;

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

            // Pre-tool security checks
            if (!runPreToolChecks(toolUse.name, toolInput, config.ownerSlackUserId)) {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: 'Tool call blocked by security policy.',
                is_error: true,
              });
              continue;
            }

            // Update progress with what we're about to do
            if (isRealSlackMessage) {
              const progressDesc = describeToolCall(toolUse.name, toolInput);
              await handler.updateProgress(progressDesc);
            }

            // Execute the tool
            logger.info({ tool: toolUse.name }, 'Executing tool');
            const startTime = Date.now();
            const result = await toolHandler(toolInput);
            const elapsed = Date.now() - startTime;
            logger.info({ tool: toolUse.name, elapsed, isError: result.isError }, 'Tool execution complete');

            // Post-tool audit
            const sanitizedContent = runPostToolChecks(
              toolUse.name, toolInput, result.content, !!result.isError,
            );

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: sanitizedContent,
              is_error: result.isError,
            });
          }

          // If interrupted, stop the loop
          if (interruptState.type === 'cancel' || interruptState.type === 'redirect') {
            break;
          }

          // Add assistant message + tool results to conversation
          messages.push({ role: 'assistant', content: response.content });
          messages.push({ role: 'user', content: toolResults });
        }

        // ── Handle interrupts ──
        const slackMessages = handler.getMessages();

        if (interruptState.type === 'cancel') {
          logger.info('Task cancelled by owner interrupt');
          if (isAssistantMode) {
            try { await assistantAPI.say('Cancelled.'); } catch { /* */ }
          }
          // completeProcessing handles cleanup (remove 🧠, delete progress msg)
          return;
        }

        if (interruptState.type === 'redirect' && interruptState.newMessage) {
          logger.info({ newMessage: interruptState.newMessage.slice(0, 80) }, 'Task redirected');
          if (isAssistantMode) {
            try { await assistantAPI.say('Redirecting...'); } catch { /* */ }
          }
          handler.getQueue().enqueue({
            text: interruptState.newMessage,
            channel: batch.channel,
            threadTs: batch.threadTs,
            userId: batch.userId,
            ts: `redirect-${Date.now()}`,
            receivedAt: Date.now(),
          });
          return;
        }

        if (interruptState.clarificationMessage) {
          try {
            if (isAssistantMode) {
              await assistantAPI.say(interruptState.clarificationMessage);
            } else {
              await slackMessages.post(batch.channel, interruptState.clarificationMessage, batch.threadTs);
            }
          } catch (error) {
            logger.error({ error }, 'Failed to post clarification message');
          }
          return;
        }

        // ── Post response (or stay silent) ──
        if (finalResponse && !finalResponse.trim().includes(NO_RESPONSE)) {
          const cleanResponse = finalResponse.replace(/\[NO_RESPONSE\]/g, '').trim();
          if (cleanResponse) {
            logger.info({ responseLength: cleanResponse.length }, 'Posting agent response');
            try {
              if (isAssistantMode) {
                await assistantAPI.say(cleanResponse);
              } else {
                await slackMessages.post(batch.channel, cleanResponse, batch.threadTs);
              }
            } catch (error) {
              logger.error({ error }, 'Failed to post response to Slack');
            }
          }
        } else {
          logger.info({ channel: batch.channel }, 'Agent decided not to respond — staying silent');
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMsg }, 'Agent query failed');
        try {
          const errorText = `Sorry, I hit an error: ${errorMsg}`;
          if (isAssistantMode) {
            await assistantAPI.say(errorText);
          } else {
            await handler.getMessages().post(batch.channel, errorText, batch.threadTs);
          }
        } catch { /* non-critical */ }
      } finally {
        clearTimeout(timeout);
        // Handler cleans up: removes 🧠, deletes progress message, clears interrupt buffer
        if (isRealSlackMessage) {
          await handler.completeProcessing();
        }

        // ── Post-interaction memory extraction (fire-and-forget) ──
        if (isRealSlackMessage && message.length > 10) {
          const conversationForExtraction = conversationHistory
            ? `${conversationHistory}\n\nNew message: ${message}`
            : message;
          const extractionSource = `slack:${batch.channel}:${lastMsg.ts}`;

          extractFacts(anthropicClient, config.models.classifier, conversationForExtraction, extractionSource)
            .then(async result => {
              if (result.facts.length > 0 || result.people.length > 0) {
                await storeExtractionResult(db, result, extractionSource);
                // Check if reflection should be triggered
                await maybeReflect(db, anthropicClient, config.models.classifier);
              }
            })
            .catch(err => {
              logger.debug({ error: err }, 'Background extraction failed — non-critical');
            });
        }

        logger.info({ channel: batch.channel }, 'processBatch complete');
      }
    },

    async shutdown() {
      logger.info('Agent shutting down');
    },
  };
}
