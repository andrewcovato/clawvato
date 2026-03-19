/**
 * Hybrid Agent — orchestrates fast path (API) and heavy path (SDK).
 *
 * Replaces the old monolithic createAgent() with a two-path architecture:
 * - Haiku router classifies each message as fast or heavy
 * - Fast path: direct API, limited tools, 10 turns, 60s timeout
 * - Heavy path: Claude Code SDK subprocess, MCP memory, gws CLI, Fireflies CLI
 *
 * Both paths share:
 * - Memory retrieval + working context (via context.ts)
 * - Security checks + training wheels
 * - Background extraction (post-interaction)
 * - Slack reaction lifecycle
 */

import Anthropic from '@anthropic-ai/sdk';
import type { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { requireCredential, getCredential } from '../credentials.js';
import { getPrompts, NO_RESPONSE } from '../prompts.js';
import { getDb } from '../db/index.js';
import { google } from 'googleapis';
import { getGoogleAuth } from '../google/auth.js';
import { createGoogleTools } from '../google/tools.js';
import { createSlackTools, type SlackTool, type ToolHandlerResult } from '../mcp/slack/server.js';
import { assembleContext, loadWorkingContext } from './context.js';
import { routeMessage } from './router.js';
import { executeFastPath, createFastPathMemoryTools } from './fast-path.js';
import { executeHeavyPath } from './heavy-path.js';
import { extractFacts, storeExtractionResult } from '../memory/extractor.js';
import { maybeReflect } from '../memory/reflection.js';
import { classifyInterrupt, generateClarificationMessage } from '../slack/interrupt-classifier.js';
import type { SlackHandler } from '../slack/handler.js';
import type { AccumulatedBatch } from '../slack/event-queue.js';

export interface HybridAgent {
  processBatch(batch: AccumulatedBatch, handler: SlackHandler): Promise<void>;
  shutdown(): Promise<void>;
}

export interface HybridAgentOptions {
  apiKey?: string;
  botClient: WebClient;
  userClient?: WebClient;
}

/**
 * Create the hybrid agent with both fast and heavy paths.
 */
export async function createHybridAgent(options: HybridAgentOptions): Promise<HybridAgent> {
  const config = getConfig();
  const apiKey = options.apiKey ?? await requireCredential('anthropic-api-key');
  const anthropicClient = new Anthropic({ apiKey });

  // ── Build fast-path tool registry ──
  // Only memory + single-source lookup tools
  const db = getDb();
  const fastPathTools = createFastPathMemoryTools(db);

  // Add Slack channel history (single-source lookup)
  const slackTools = createSlackTools(options.botClient, options.userClient);
  const channelHistoryTool = slackTools.find(t => t.definition.name === 'slack_get_channel_history');
  if (channelHistoryTool) {
    fastPathTools.push(channelHistoryTool);
  }

  // Add Google Calendar tools if available (single-source lookups)
  const googleAuth = await getGoogleAuth();
  if (googleAuth) {
    const googleTools = createGoogleTools(googleAuth, config.google?.agentEmail);
    const calendarTools = googleTools.filter(t =>
      t.definition.name === 'google_calendar_list_events' ||
      t.definition.name === 'google_calendar_get_event'
    );
    fastPathTools.push(...calendarTools);

    // Add gmail_search (thread listing only — not reading)
    const gmailSearch = googleTools.find(t => t.definition.name === 'google_gmail_search');
    if (gmailSearch) fastPathTools.push(gmailSearch);

    logger.info({ fastPathGoogleTools: calendarTools.length + (gmailSearch ? 1 : 0) }, 'Google tools loaded for fast path');
  }

  // Add Slack search for fast path
  const slackSearch = slackTools.find(t => t.definition.name === 'slack_search_messages');
  if (slackSearch) fastPathTools.push(slackSearch);

  // Resolve bot user ID
  let botUserId: string | undefined;
  try {
    const auth = await options.botClient.auth.test();
    botUserId = auth.user_id as string | undefined;
  } catch { /* non-critical */ }

  /** Haiku classifier for interrupt classification */
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
    fastPathTools: fastPathTools.map(t => t.definition.name),
    trustLevel: config.trustLevel,
  }, 'Hybrid agent initialized');

  return {
    async processBatch(batch: AccumulatedBatch, handler: SlackHandler): Promise<void> {
      const message = batch.combinedText;
      const assistantAPI = handler.getAssistantAPI();
      const isAssistantMode = !!assistantAPI;

      logger.info(
        { channel: batch.channel, messageLength: message.length, assistantMode: isAssistantMode },
        'Hybrid agent processing batch',
      );

      // ── Assemble shared context ──
      const context = await assembleContext(
        db,
        options.botClient,
        message,
        batch.channel,
        { botUserId, ownerUserId: config.ownerSlackUserId },
      );

      // ── Transition to processing state ──
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
        try { await assistantAPI.setTitle(message.slice(0, 60) + (message.length > 60 ? '...' : '')); } catch { /* */ }
        try { await assistantAPI.setStatus('Thinking...'); } catch { /* */ }
      }

      try {
        // ── Route: fast or heavy? Router sees full context (same as both paths) ──
        const routing = await routeMessage(anthropicClient, context.userPrompt);
        logger.info({ decision: routing.decision, confidence: routing.confidence }, 'Routing decision');

        let finalResponse = '';

        if (routing.decision === 'heavy') {
          // ── Heavy Path: Claude Code SDK ──
          if (isRealSlackMessage) {
            await handler.updateProgress('Deep analysis in progress...');
          }

          const workingContext = loadWorkingContext(db);
          const result = await executeHeavyPath(
            context.userPrompt,
            {
              dataDir: config.dataDir,
              systemPrompt: context.systemPrompt,
              memoryContext: context.memoryResult.context,
              workingContext,
            },
            handler,
          );

          if (result.success && result.response) {
            finalResponse = result.response;
          } else {
            // Heavy path failed — notify user and try fast path
            const errorDetail = result.error?.slice(0, 200) ?? 'unknown error';
            logger.warn({ error: errorDetail, durationMs: result.durationMs }, 'Heavy path failed');

            if (isRealSlackMessage) {
              await handler.updateProgress(`Deep analysis failed — trying simpler approach...`);
            }

            const fastResult = await executeFastPath(
              context.userPrompt,
              context.systemPrompt,
              { client: anthropicClient, db, tools: fastPathTools },
              handler,
            );

            if (fastResult.response) {
              finalResponse = fastResult.response;
            } else {
              // Both paths failed — tell the user
              finalResponse = `Sorry, I hit an error on the deep analysis path and couldn't recover.\n\n*Error:* ${errorDetail}\n\nThis usually means the Claude CLI subprocess failed. Check the logs for details.`;
            }
          }
        } else {
          // ── Fast Path: direct API ──
          const fastResult = await executeFastPath(
            context.userPrompt,
            context.systemPrompt,
            { client: anthropicClient, db, tools: fastPathTools },
            handler,
          );
          finalResponse = fastResult.response;
        }

        // ── Post response ──
        if (finalResponse && !finalResponse.trim().includes(NO_RESPONSE)) {
          const cleanResponse = finalResponse.replace(/\[NO_RESPONSE\]/g, '').trim();
          if (cleanResponse) {
            logger.info({ responseLength: cleanResponse.length, path: routing.decision }, 'Posting response');
            try {
              if (isAssistantMode) {
                await assistantAPI.say(cleanResponse);
              } else {
                await handler.getMessages().post(batch.channel, cleanResponse, batch.threadTs);
              }
            } catch (error) {
              logger.error({ error }, 'Failed to post response to Slack');
            }
          }
        } else {
          logger.info({ channel: batch.channel }, 'Agent decided not to respond');
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMsg }, 'Hybrid agent query failed');
        try {
          const errorText = `Sorry, I hit an error: ${errorMsg}`;
          if (isAssistantMode) {
            await assistantAPI.say(errorText);
          } else {
            await handler.getMessages().post(batch.channel, errorText, batch.threadTs);
          }
        } catch { /* non-critical */ }
      } finally {
        if (isRealSlackMessage) {
          await handler.completeProcessing();
        }

        // ── Post-interaction memory extraction (fire-and-forget) ──
        if (isRealSlackMessage && message.length > 10) {
          const extractionSource = `slack:${batch.channel}:${lastMsg.ts}`;
          extractFacts(anthropicClient, config.models.classifier, message, extractionSource)
            .then(async result => {
              if (result.facts.length > 0 || result.people.length > 0) {
                await storeExtractionResult(db, result, extractionSource);
                await maybeReflect(db, anthropicClient, config.models.classifier);
              }
            })
            .catch(err => {
              logger.debug({ error: err }, 'Background extraction failed');
            });
        }

        logger.info({ channel: batch.channel }, 'processBatch complete');
      }
    },

    async shutdown() {
      logger.info('Hybrid agent shutting down');
    },
  };
}
