/**
 * Shared Context Assembly — used by both fast path and heavy path.
 *
 * Builds the context that gets passed to the agent: memory retrieval,
 * working context, conversation history, and system prompt.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { WebClient } from '@slack/web-api';
import { getConfig } from '../config.js';
import { getPrompts } from '../prompts.js';
import { retrieveContext, type RetrievalResult } from '../memory/retriever.js';
import { logger } from '../logger.js';

/** Rough estimate: 1 token ≈ 4 characters */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface AssembledContext {
  /** Full user prompt with all context sections */
  userPrompt: string;
  /** System prompt from config/prompts/system.md */
  systemPrompt: string;
  /** Memory retrieval metadata */
  memoryResult: RetrievalResult;
  /** Channel name (resolved from ID) */
  channelLabel: string;
}

/**
 * Build conversation context from Slack channel history.
 */
export async function buildConversationContext(
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

    const formatted = messages.map(m => {
      const isBotMsg = !!m.bot_id || (botUserId && m.user === botUserId);
      const isOwner = ownerUserId && m.user === ownerUserId;
      const prefix = isBotMsg ? '[TRUSTED - You]' : isOwner ? '[TRUSTED - Owner]' : `[EXTERNAL - ${m.user}]`;
      return `${prefix}: ${(m.text ?? '').slice(0, config.context.shortTermMsgCharLimit)}`;
    });

    // Apply token budget — keep newest messages when trimming
    let startIndex = 0;
    const tokenCosts = formatted.map(line => estimateTokens(line));
    const totalTokens = tokenCosts.reduce((a, b) => a + b, 0);

    if (totalTokens > config.context.shortTermTokenBudget) {
      let remaining = totalTokens;
      for (let i = 0; i < formatted.length; i++) {
        if (remaining <= config.context.shortTermTokenBudget) {
          startIndex = i;
          break;
        }
        remaining -= tokenCosts[i];
      }
    }

    return formatted.slice(startIndex).join('\n');
  } catch (error) {
    logger.debug({ error, channel }, 'Failed to fetch channel history for context');
    return '';
  }
}

/**
 * Load working context from agent_state (token-budgeted).
 */
export function loadWorkingContext(db: DatabaseSync): string {
  const config = getConfig();
  try {
    const rows = db.prepare(
      "SELECT key, value FROM agent_state WHERE key LIKE 'wctx:%' AND status = 'active' ORDER BY updated_at DESC LIMIT 20"
    ).all() as unknown as Array<{ key: string; value: string }>;

    if (rows.length === 0) return '';

    const lines: string[] = [];
    let tokens = 0;
    for (const r of rows) {
      const line = `- ${r.value}`;
      const t = estimateTokens(line);
      if (tokens + t > config.context.workingContextTokenBudget) break;
      lines.push(line);
      tokens += t;
    }

    return lines.length > 0 ? `## Working Context\n${lines.join('\n')}` : '';
  } catch {
    return ''; // agent_state may not exist
  }
}

/**
 * Assemble the full context for an agent interaction.
 */
export async function assembleContext(
  db: DatabaseSync,
  botClient: WebClient,
  message: string,
  channel: string,
  opts?: {
    botUserId?: string;
    ownerUserId?: string;
    threadTs?: string;
  },
): Promise<AssembledContext> {
  const config = getConfig();

  // Retrieve memory context
  const memoryResult = await retrieveContext(db, message, {
    tokenBudget: config.context.longTermTokenBudget,
  });

  // Build conversation history
  const conversationHistory = await buildConversationContext(
    botClient,
    channel,
    opts?.botUserId,
    opts?.ownerUserId,
  );

  // Resolve channel name
  let channelLabel = channel;
  try {
    const channelInfo = await botClient.conversations.info({ channel });
    const ch = channelInfo.channel as Record<string, unknown> | undefined;
    channelLabel = (ch?.name as string) ?? (ch?.id as string) ?? channel;
  } catch { /* use ID as fallback */ }

  // Load working context
  const workingContext = loadWorkingContext(db);

  // Assemble user prompt
  const parts: string[] = [];
  if (workingContext) parts.push(workingContext);
  if (memoryResult.context) parts.push(memoryResult.context);
  if (conversationHistory) {
    parts.push(`## Recent conversation (in #${channelLabel})\n${conversationHistory}`);
  }
  parts.push(`## New message (in #${channelLabel})\n${message}`);

  return {
    userPrompt: parts.join('\n\n---\n\n'),
    systemPrompt: getPrompts().system,
    memoryResult,
    channelLabel,
  };
}
