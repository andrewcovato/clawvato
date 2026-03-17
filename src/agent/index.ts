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
import { getDb } from '../db/index.js';
import { createSlackTools, type SlackTool, type ToolHandlerResult } from '../mcp/slack/server.js';
import { getGoogleAuth } from '../google/auth.js';
import { createGoogleTools } from '../google/tools.js';
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

/** Sentinel value — if Claude responds with this, we stay silent */
const NO_RESPONSE = '[NO_RESPONSE]';

/** Max tool-call turns before forcing a stop */
const MAX_TURNS = 15;

// ── Context limits (centralized for tuning) ──
// See CLAUDE.md "Context Limits" section for documentation

/** Max Slack messages to fetch for short-term conversation context */
const SHORT_TERM_MESSAGE_LIMIT = 50;

/** Max characters per Slack message in conversation context */
const SHORT_TERM_MSG_CHAR_LIMIT = 1000;

/** Max tokens for short-term Slack context (newest messages get priority) */
const SHORT_TERM_TOKEN_BUDGET = 2000;

/** Max tokens for long-term memory retrieval (from DB) */
const LONG_TERM_TOKEN_BUDGET = 1500;

const SYSTEM_PROMPT = `You are Clawvato, a personal AI chief of staff running in Slack. You help your owner manage their work life — Slack messages, meetings, emails, documents, and tasks.

## How you see conversations

Each message you receive includes the recent conversation history from the channel, so you always have context. Your own previous messages are marked with [You]. The owner's messages are marked with [Owner]. Other users are marked with their user ID.

Read the conversation like a human scrolling Slack. Understand what's been discussed, what you already responded to, and what's new.

**IMPORTANT: Always focus on the "New message" section — that is what the owner just said and needs a response to. The conversation history and memory context are background information. Do not respond to old messages or topics unless the new message explicitly references them.**

## When to respond

Respond when:
- The owner is talking to you (directly, by @mention, or contextually)
- You're asked to do something
- A follow-up to a conversation you were part of
- You just came back online and there are outstanding requests

Stay silent when:
- People are talking to each other (not to you)
- General announcements or social chatter
- Everything in the conversation has already been handled
- Your input isn't needed

**If you decide not to respond, output exactly: ${NO_RESPONSE}**

## Personality
- Concise and professional, with occasional dry humor
- You prefer action over asking unnecessary questions
- When uncertain, ask one clear question rather than guessing
- Brief responses — no narration of your process

## Guidelines
- You can search Slack, post messages, and look up user info using the slack tools
- If Google tools are available, you can check calendar, search email, create drafts, and search Drive
- Always confirm before sending messages or creating events on the owner's behalf
- **Search efficiency**: Start with 1-2 targeted searches. If initial results aren't what the owner needs, check in before continuing — let them know what you found so far and that a deeper search is possible but will take longer. Never silently loop through many searches. Summarize from snippets unless asked to read a full message.
- Never share the owner's private information with others
- When you complete a task, report the result briefly
- If a task has multiple steps, report meaningful milestones`;

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
 * Fetches up to SHORT_TERM_MESSAGE_LIMIT messages, then trims to fit
 * within SHORT_TERM_TOKEN_BUDGET. Messages are newest-first from Slack,
 * reversed to chronological order, and oldest messages are dropped first
 * when the budget is exceeded.
 */
async function buildConversationContext(
  botClient: WebClient,
  channel: string,
  botUserId?: string,
  ownerUserId?: string,
): Promise<string> {
  try {
    const history = await botClient.conversations.history({
      channel,
      limit: SHORT_TERM_MESSAGE_LIMIT,
    });

    const messages = (history.messages ?? [])
      .filter(m => !m.subtype)
      .reverse(); // oldest first

    if (messages.length === 0) return '';

    // Format all messages
    const formatted = messages.map(m => {
      const isBotMsg = !!m.bot_id || (botUserId && m.user === botUserId);
      const isOwner = ownerUserId && m.user === ownerUserId;
      const prefix = isBotMsg ? '[You]' : isOwner ? '[Owner]' : `[${m.user}]`;
      return `${prefix}: ${(m.text ?? '').slice(0, SHORT_TERM_MSG_CHAR_LIMIT)}`;
    });

    // Apply token budget — keep newest messages (end of array) when trimming
    let tokensUsed = 0;
    let startIndex = 0;

    // Calculate total tokens
    const totalTokens = formatted.reduce((sum, line) => sum + estimateTokens(line), 0);

    if (totalTokens > SHORT_TERM_TOKEN_BUDGET) {
      // Trim from the oldest (start of array) until we fit
      for (let i = 0; i < formatted.length; i++) {
        const remaining = formatted.slice(i).reduce((sum, line) => sum + estimateTokens(line), 0);
        if (remaining <= SHORT_TERM_TOKEN_BUDGET) {
          startIndex = i;
          break;
        }
      }
      logger.debug(
        { total: formatted.length, kept: formatted.length - startIndex, budget: SHORT_TERM_TOKEN_BUDGET },
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
  const serverName = 'slack';
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

  const result: ToolResult = {
    toolName,
    serverName: 'slack',
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
  } else {
    logger.info('Google Workspace tools not loaded — credentials not configured');
  }

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
        const conversationText = batch
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
      const memoryResult = await retrieveContext(db, message, { tokenBudget: LONG_TERM_TOKEN_BUDGET });

      let userPrompt: string;
      const parts: string[] = [];
      if (memoryResult.context) {
        parts.push(memoryResult.context);
      }
      if (conversationHistory) {
        parts.push(`## Recent conversation\n${conversationHistory}`);
      }
      parts.push(`## New message\n${message}`);
      userPrompt = parts.join('\n\n---\n\n');

      // Debug reaction: 🧠 = thinking about this
      const lastMsg = batch.messages[batch.messages.length - 1];
      const isRealSlackMessage = !lastMsg.ts.startsWith('crawl-');
      if (isRealSlackMessage) {
        try {
          await handler.getReactions().add(lastMsg.channel, lastMsg.ts, 'brain');
        } catch { /* non-critical */ }
      }

      // Set active task for interrupt routing
      handler.setActiveTask(message.slice(0, 100), batch.channel, batch.threadTs);

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
      }, 120_000);

      try {
        // ── Agent loop: messages.create → tool calls → repeat ──
        const messages: Anthropic.MessageParam[] = [
          { role: 'user', content: userPrompt },
        ];

        let finalResponse = '';

        for (let turn = 0; turn < MAX_TURNS; turn++) {
          if (abortController.signal.aborted) break;

          const response = await anthropicClient.messages.create({
            model: config.models.executor,
            max_tokens: 4096,
            system: SYSTEM_PROMPT,
            tools: toolDefs,
            messages,
          });

          // Extract text and tool_use blocks
          const textBlocks = response.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map(b => b.text);
          const toolUseBlocks = response.content
            .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');

          if (textBlocks.length > 0) {
            finalResponse = textBlocks.join('\n');
          }

          // If no tool calls, we're done
          if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
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
        const ackTs = handler.getAckTs();

        if (interruptState.type === 'cancel') {
          logger.info('Task cancelled by owner interrupt');
          if (isAssistantMode) {
            try { await assistantAPI.say('Cancelled.'); } catch { /* */ }
          } else if (ackTs) {
            try { await slackMessages.update(batch.channel, ackTs, 'Cancelled.'); } catch { /* */ }
          }
          return;
        }

        if (interruptState.type === 'redirect' && interruptState.newMessage) {
          logger.info({ newMessage: interruptState.newMessage.slice(0, 80) }, 'Task redirected');
          if (isAssistantMode) {
            try { await assistantAPI.say('Redirecting...'); } catch { /* */ }
          } else if (ackTs) {
            try { await slackMessages.update(batch.channel, ackTs, 'Redirecting...'); } catch { /* */ }
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
              } else if (ackTs) {
                await slackMessages.update(batch.channel, ackTs, cleanResponse);
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
            const slackMessages = handler.getMessages();
            const ackTs = handler.getAckTs();
            if (ackTs) {
              await slackMessages.update(batch.channel, ackTs, errorText);
            } else {
              await slackMessages.post(batch.channel, errorText, batch.threadTs);
            }
          }
        } catch { /* non-critical */ }
      } finally {
        clearTimeout(timeout);
        handler.clearActiveTask();
        if (isRealSlackMessage) {
          try {
            await handler.getReactions().remove(lastMsg.channel, lastMsg.ts, 'brain');
          } catch { /* non-critical */ }
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
