/**
 * Context Planner — Opus-powered pre-deep-path step that replaces preflight.
 *
 * When the router says DEEP, the context planner runs first:
 * 1. Searches memory for relevant facts (targeted queries)
 * 2. Fills gaps with live tool calls (Gmail, Slack, etc.) if needed
 * 3. Converses with the user for clarification (same UX as old preflight)
 * 4. Assesses whether gathered context is sufficient for pure analysis
 * 5. Returns curated context for the deep path workspace
 *
 * Replaces the old Sonnet preflight with a smarter Opus step that
 * simultaneously gathers context and refines the request.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { getPrompts } from '../prompts.js';
import { executeFastPath, type FastPathResult } from './fast-path.js';
import type { ToolHandlerResult } from '../mcp/slack/server.js';
import type { SlackHandler } from '../slack/handler.js';

export interface ContextPlan {
  /** Curated context gathered from memory + tool calls */
  gatheredContext: string;
  /** Whether context is sufficient for pure analysis (no research tools needed) */
  sufficientForAnalysis: boolean;
  /** Additional context from user conversation (clarifications) */
  userClarifications: string;
  /** Planning duration in ms */
  planningDurationMs: number;
  /** Whether the user cancelled */
  cancelled: boolean;
}

export interface ContextPlannerDeps {
  anthropicClient: Anthropic;
  sql: Sql;
  tools: Array<{ definition: Anthropic.Tool; handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> }>;
}

/**
 * Run the context planner: gather context + converse with user.
 *
 * This function handles the full pre-deep-path interaction:
 * - Posts initial assessment to Slack
 * - Polls for user responses (same pattern as old preflight)
 * - Uses Opus with tools to search memory and fill gaps
 * - Returns when user confirms [PROCEED] or [CANCEL]
 */
export async function planContext(
  message: string,
  assembledContext: string,
  handler: SlackHandler,
  channel: string,
  threadTs: string | undefined,
  deps: ContextPlannerDeps,
): Promise<ContextPlan> {
  const startTime = Date.now();
  const config = getConfig();

  // Run the planning phase: Opus with tools, gathering context
  const planningPrompt = `The owner's request:\n${message}\n\nAssembled context:\n${assembledContext}\n\n` +
    `Search memory and available tools to gather relevant context for this request. ` +
    `If you need to ask the user a question, include it in your response. ` +
    `When you have enough context, include [CONTEXT_READY] with your assessment.`;

  const planResult = await executeFastPath(
    planningPrompt,
    getPrompts().contextPlanner,
    {
      client: deps.anthropicClient,
      db: deps.sql,
      tools: deps.tools,
      model: config.models.reasoner, // Opus
    },
  );

  const planningDurationMs = Date.now() - startTime;
  const planResponse = planResult.response;

  // Parse the planner's output
  const sufficientForAnalysis = planResponse.includes('[CONTEXT_READY]') &&
    (planResponse.toLowerCase().includes('sufficient') || !planResponse.toLowerCase().includes('gaps remain'));

  // Post the planner's initial message to Slack (strip sentinels)
  const cleanResponse = planResponse
    .replace(/\[CONTEXT_READY\][\s\S]*$/m, '') // Remove context assessment block
    .replace(/\[PROCEED\]|\[CANCEL\]|\[CLARIFY\]/g, '')
    .trim();

  if (cleanResponse) {
    try {
      await handler.getMessages().post(channel, cleanResponse, threadTs);
    } catch { /* */ }
  }

  // Clear reactions from initial thinking
  await handler.clearReactionsOnly();

  // ── Conversation loop: wait for user to confirm or clarify ──
  const POLL_MS = 1000;
  const REMINDER_MS = config.agent.preflightReminderMs;
  let lastActivityAt = Date.now();
  let userClarifications = '';
  let cancelled = false;
  let proceed = false;

  // If the planner already wants to proceed (no clarification needed), auto-send the assessment
  // But still wait for user confirmation
  const conversationMessages: Anthropic.MessageParam[] = [
    { role: 'user', content: planningPrompt },
    { role: 'assistant', content: planResponse },
  ];

  while (!proceed && !cancelled) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const interrupt = handler.drainInterrupt();

    if (!interrupt) {
      // Periodic reminder
      if (Date.now() - lastActivityAt > REMINDER_MS) {
        try {
          await handler.getMessages().post(
            channel,
            'Still here — let me know when you\'re ready to start, or if you have more to add.',
            threadTs,
          );
        } catch { /* */ }
        lastActivityAt = Date.now();
      }
      continue;
    }

    lastActivityAt = Date.now();

    // Reaction lifecycle
    await handler.startThinking(channel, interrupt.ts);

    // Check for simple proceed/cancel signals before LLM call
    const text = interrupt.text.toLowerCase().trim();
    if (/^(go|proceed|yes|do it|start|run it|let's go|yep|👍)$/i.test(text)) {
      await handler.stopThinking(channel, interrupt.ts);
      proceed = true;
      break;
    }
    if (/^(stop|cancel|nevermind|never mind|nvm|scratch that|abort)$/i.test(text)) {
      await handler.stopThinking(channel, interrupt.ts);
      cancelled = true;
      break;
    }

    // User provided additional context — send to LLM for follow-up
    userClarifications += (userClarifications ? '\n' : '') + interrupt.text;
    conversationMessages.push({ role: 'user', content: interrupt.text });

    const followUp = await deps.anthropicClient.messages.create({
      model: config.models.reasoner,
      max_tokens: 500,
      system: getPrompts().contextPlanner,
      messages: conversationMessages,
    });
    const followUpText = followUp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text).join('');

    conversationMessages.push({ role: 'assistant', content: followUpText });

    await handler.stopThinking(channel, interrupt.ts);

    if (followUpText.includes('[PROCEED]')) {
      proceed = true;
      const cleanFollowUp = followUpText.replace(/\[PROCEED\]/g, '').trim();
      if (cleanFollowUp) {
        try { await handler.getMessages().post(channel, cleanFollowUp, threadTs); } catch { /* */ }
      }
    } else if (followUpText.includes('[CANCEL]')) {
      cancelled = true;
      const cleanFollowUp = followUpText.replace(/\[CANCEL\]/g, '').trim();
      if (cleanFollowUp) {
        try { await handler.getMessages().post(channel, cleanFollowUp, threadTs); } catch { /* */ }
      }
    } else {
      const cleanFollowUp = followUpText.replace(/\[PROCEED\]|\[CANCEL\]|\[CLARIFY\]/g, '').trim();
      if (cleanFollowUp) {
        try { await handler.getMessages().post(channel, cleanFollowUp, threadTs); } catch { /* */ }
      }
    }
  }

  logger.info({
    planningDurationMs,
    sufficientForAnalysis,
    cancelled,
    hasClarifications: !!userClarifications,
  }, 'Context planner complete');

  return {
    gatheredContext: planResponse,
    sufficientForAnalysis,
    userClarifications,
    planningDurationMs,
    cancelled,
  };
}
