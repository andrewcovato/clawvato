/**
 * Hybrid Agent — orchestrates fast path (API) and deep path (SDK).
 *
 * Replaces the old monolithic createAgent() with a two-path architecture:
 * - Haiku router classifies each message as fast or deep
 * - Fast path: direct API, limited tools, 10 turns, 60s timeout
 * - Deep path: Claude Code SDK subprocess, MCP memory, gws CLI, Fireflies CLI
 *
 * Both paths share:
 * - Memory retrieval + working context (via context.ts)
 * - Security checks + training wheels
 * - Background extraction (post-interaction)
 * - Slack reaction lifecycle
 */

import Anthropic from '@anthropic-ai/sdk';
import type { WebClient } from '@slack/web-api';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { requireCredential, getCredential } from '../credentials.js';
import { getPrompts, NO_RESPONSE } from '../prompts.js';
import { getDb } from '../db/index.js';
import { google } from 'googleapis';
import { getGoogleAuth } from '../google/auth.js';
import { createGoogleTools } from '../google/tools.js';
import { createSlackTools, type SlackTool, type ToolHandlerResult } from '../mcp/slack/server.js';
import { FirefliesClient } from '../fireflies/api.js';
import { createFirefliesTools } from '../fireflies/tools.js';
import { assembleContext, loadWorkingContext } from './context.js';
import { retrieveContext } from '../memory/retriever.js';
import { routeMessage, type RouterResult } from './router.js';
import { executeFastPath, createFastPathMemoryTools } from './fast-path.js';
import { executeDeepPath } from './deep-path.js';
import { extractFacts, storeExtractionResult, type ExtractedFact } from '../memory/extractor.js';
import { maybeReflect } from '../memory/reflection.js';
import { findOrCreateCategory, insertMemory, findDuplicates, supersedeMemory, deleteEmbedding, hasVectorSupport, insertEmbedding } from '../memory/store.js';
import { contentSimilarity } from '../memory/extractor.js';
import { embedBatch } from '../memory/embeddings.js';
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

const FINDINGS_FILE = '/tmp/clawvato-findings.json';

/**
 * Process the findings file written by the deep path subprocess.
 * Parses JSON, deduplicates, normalizes categories, and stores to DB.
 * Runs as a background task after deep path completes.
 */
async function processDeepPathFindings(
  db: DatabaseSync,
  source: string,
): Promise<{ stored: number; skipped: number; errors: number }> {
  let stored = 0;
  let skipped = 0;
  let errors = 0;

  if (!existsSync(FINDINGS_FILE)) {
    logger.info('No findings file from deep path — skipping');
    return { stored, skipped, errors };
  }

  try {
    const raw = readFileSync(FINDINGS_FILE, 'utf-8');
    // Clean up: handle markdown wrapping, multiple JSON arrays, JSONL
    const cleaned = raw
      .replace(/^```json?\s*/gim, '')
      .replace(/\s*```$/gm, '')
      .trim();

    let findings: Array<Record<string, unknown>>;
    try {
      findings = JSON.parse(cleaned);
    } catch {
      // Try parsing as JSONL (one JSON object per line)
      findings = cleaned
        .split('\n')
        .filter(line => line.trim().startsWith('{'))
        .map(line => {
          try { return JSON.parse(line); } catch { return null; }
        })
        .filter((f): f is Record<string, unknown> => f !== null);
    }

    if (!Array.isArray(findings) || findings.length === 0) {
      logger.warn({ rawLength: raw.length }, 'Findings file empty or unparseable');
      return { stored, skipped, errors };
    }

    logger.info({ findingsCount: findings.length }, 'Processing deep path findings');

    const newMemoryIds: { id: string; content: string }[] = [];

    for (const finding of findings) {
      try {
        const content = String(finding.content ?? '');
        if (!content || content.length < 10) continue;

        const type = findOrCreateCategory(db, String(finding.type ?? 'fact'));
        const entities = Array.isArray(finding.entities) ? finding.entities.map(String) : [];
        const importance = Math.max(1, Math.min(10, Math.round(Number(finding.importance) || 5)));
        const confidence = Math.max(0, Math.min(1, Number(finding.confidence) || 0.7));
        const factSource = finding.source ? `${source}:${finding.source}` : source;

        // Dedup check
        const duplicates = findDuplicates(db, content, type);
        const closeMatch = duplicates.find(d => contentSimilarity(d.content, content) > 0.8);

        if (closeMatch) {
          if (confidence > closeMatch.confidence) {
            // Higher confidence — supersede
            const newId = insertMemory(db, { type, content, source: factSource, importance, confidence, entities });
            supersedeMemory(db, closeMatch.id, newId);
            deleteEmbedding(db, closeMatch.id);
            newMemoryIds.push({ id: newId, content });
            stored++;
          } else {
            skipped++;
          }
        } else {
          const newId = insertMemory(db, { type, content, source: factSource, importance, confidence, entities });
          newMemoryIds.push({ id: newId, content });
          stored++;
        }
      } catch (err) {
        errors++;
        logger.debug({ error: err, finding: JSON.stringify(finding).slice(0, 200) }, 'Failed to process finding');
      }
    }

    // Batch embed all new memories
    if (newMemoryIds.length > 0 && hasVectorSupport(db)) {
      try {
        const texts = newMemoryIds.map(m => m.content);
        const embeddings = await embedBatch(texts);
        for (let i = 0; i < newMemoryIds.length; i++) {
          insertEmbedding(db, newMemoryIds[i].id, embeddings[i]);
        }
        logger.debug({ count: newMemoryIds.length }, 'Findings embeddings stored');
      } catch (err) {
        logger.debug({ error: err }, 'Findings embedding failed — stored without vectors');
      }
    }
  } catch (err) {
    logger.warn({ error: err }, 'Failed to process findings file');
  } finally {
    // Clean up the findings file
    try { unlinkSync(FINDINGS_FILE); } catch { /* */ }
  }

  return { stored, skipped, errors };
}

/**
 * Create the hybrid agent with both fast and deep paths.
 */
export async function createHybridAgent(options: HybridAgentOptions): Promise<HybridAgent> {
  const config = getConfig();
  const apiKey = options.apiKey ?? await requireCredential('anthropic-api-key');
  const anthropicClient = new Anthropic({ apiKey });

  // ── Build fast-path tool registry ──
  // Memory + read-only lookups across all sources
  const db = getDb();
  const fastPathTools = createFastPathMemoryTools(db);

  // Slack tools — channel history + search
  const slackTools = createSlackTools(options.botClient, options.userClient);
  const channelHistoryTool = slackTools.find(t => t.definition.name === 'slack_get_channel_history');
  if (channelHistoryTool) fastPathTools.push(channelHistoryTool);
  const slackSearch = slackTools.find(t => t.definition.name === 'slack_search_messages');
  if (slackSearch) fastPathTools.push(slackSearch);

  // Google tools — read-only calendar, gmail, drive
  const googleAuth = await getGoogleAuth();
  if (googleAuth) {
    const googleTools = createGoogleTools(googleAuth, config.google?.agentEmail);
    const FAST_PATH_GOOGLE_TOOLS = [
      'google_calendar_list_events',
      'google_calendar_get_event',
      'google_calendar_freebusy',
      'google_gmail_search',
      'google_gmail_read',
      'google_drive_search',
      'google_drive_get_file',
    ];
    const fastGoogleTools = googleTools.filter(t =>
      FAST_PATH_GOOGLE_TOOLS.includes(t.definition.name)
    );
    fastPathTools.push(...fastGoogleTools);
    logger.info({ fastPathGoogleTools: fastGoogleTools.map(t => t.definition.name) }, 'Google tools loaded for fast path');
  }

  // Fireflies tools — search + summary (lightweight, read-only)
  const firefliesApiKey = process.env.FIREFLIES_API_KEY ?? await getCredential('fireflies-api-key').catch(() => undefined);
  if (firefliesApiKey) {
    const ffClient = new FirefliesClient(firefliesApiKey);
    const ffTools = createFirefliesTools(ffClient);
    const FAST_PATH_FF_TOOLS = ['fireflies_search_meetings', 'fireflies_get_summary'];
    const fastFFTools = ffTools.filter(t => FAST_PATH_FF_TOOLS.includes(t.definition.name));
    fastPathTools.push(...fastFFTools);
    logger.info({ fastPathFirefliesTools: fastFFTools.map(t => t.definition.name) }, 'Fireflies tools loaded for fast path');
  }

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
      max_tokens: config.agent.classifierMaxTokens,
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

      let routing: RouterResult | undefined;
      let finalResponse = '';

      try {
        // ── Startup crawl: always fast path, bias toward silence ──
        if (!isRealSlackMessage) {
          routing = { decision: 'fast', confidence: 100, reasoning: 'Startup crawl — fast path only' };
        } else {
          // ── Route: fast or deep? Router sees full context (same as both paths) ──
          routing = await routeMessage(anthropicClient, context.userPrompt);
        }
        logger.info({ decision: routing.decision, confidence: routing.confidence }, 'Routing decision');

        if (routing.decision === 'deep') {
          // ── Deep Path: Re-retrieve with generous budget, then pre-flight + SDK ──

          // Re-retrieve memory with deep-path budget ($0 on Max — no cost reason to limit)
          const deepMemory = await retrieveContext(db, message, {
            tokenBudget: config.context.deepPathLongTermTokenBudget,
          });
          const deepWorkingContext = loadWorkingContext(db, config.context.deepPathWorkingContextTokenBudget);

          // Rebuild userPrompt with richer context
          const deepParts: string[] = [];
          if (deepWorkingContext) deepParts.push(deepWorkingContext);
          if (deepMemory.context) deepParts.push(deepMemory.context);
          if (context.conversationHistory) {
            deepParts.push(`## Recent conversation (in #${context.channelLabel})\n${context.conversationHistory}`);
          }
          deepParts.push(`## New message (in #${context.channelLabel})\n${message}`);
          context.userPrompt = deepParts.join('\n\n---\n\n');
          context.memoryResult = deepMemory;

          // Pre-flight: LLM-driven conversation to refine the request
          // (can't inject context mid-subprocess, so gather everything upfront)
          let preflightContext = '';
          if (isRealSlackMessage) {
            const PREFLIGHT_POLL_MS = 1000;
            const REMINDER_INTERVAL_MS = config.agent.preflightReminderMs;
            let lastActivityAt = Date.now();
            const originalText = message.toLowerCase().trim();

            // Build pre-flight conversation with Sonnet
            const preflightMessages: Anthropic.MessageParam[] = [
              { role: 'user', content: `The owner's request:\n${message}\n\nAssembled context:\n${context.userPrompt}` },
            ];

            // Get initial bot response (offer to clarify / ask if ready)
            const initialResponse = await anthropicClient.messages.create({
              model: config.models.executor,
              max_tokens: 500,
              system: getPrompts().preflight,
              messages: preflightMessages,
            });
            const initialText = initialResponse.content
              .filter((b): b is Anthropic.TextBlock => b.type === 'text')
              .map(b => b.text).join('');

            // Check if LLM already decided to proceed (clear request, no questions)
            if (initialText.includes('[PROCEED]')) {
              preflightContext = '';
              logger.info('Pre-flight: LLM determined request is clear — proceeding immediately');
              await handler.updateProgress('Deep analysis in progress...');
            } else if (initialText.includes('[CANCEL]')) {
              finalResponse = 'Cancelled.';
              logger.info('Pre-flight: LLM cancelled');
            } else {
              // Post the bot's response to Slack
              const cleanInitial = initialText.replace(/\[PROCEED\]|\[CANCEL\]/g, '').trim();
              let botMsgTs: string | undefined;
              try {
                const posted = await handler.getMessages().post(batch.channel, cleanInitial, batch.threadTs);
                botMsgTs = posted.ts;
              } catch { /* */ }

              preflightMessages.push({ role: 'assistant', content: initialText });

              // Conversation loop — wait for user messages, respond via LLM
              let proceed = false;
              while (!proceed && !finalResponse) {
                await new Promise(r => setTimeout(r, PREFLIGHT_POLL_MS));
                const interrupt = handler.drainInterrupt();

                if (!interrupt) {
                  // Periodic reminder
                  if (Date.now() - lastActivityAt > REMINDER_INTERVAL_MS && botMsgTs) {
                    try {
                      await handler.getMessages().post(
                        batch.channel,
                        `Still here — let me know when you're ready to start, or if you have more to add.`,
                        batch.threadTs,
                      );
                    } catch { /* */ }
                    lastActivityAt = Date.now();
                  }
                  continue;
                }

                lastActivityAt = Date.now();

                // Skip duplicate of original message
                if (interrupt.text.toLowerCase().trim() === originalText) {
                  logger.debug('Pre-flight: skipping duplicate of original message');
                  continue;
                }

                // Remove :eyes: from the user's message (no special reactions during pre-flight)
                await handler.dismissEyes(batch.channel, interrupt.ts);

                // Send user message to LLM
                preflightMessages.push({ role: 'user', content: interrupt.text });

                const llmResponse = await anthropicClient.messages.create({
                  model: config.models.executor,
                  max_tokens: 500,
                  system: getPrompts().preflight,
                  messages: preflightMessages,
                });
                const responseText = llmResponse.content
                  .filter((b): b is Anthropic.TextBlock => b.type === 'text')
                  .map(b => b.text).join('');

                preflightMessages.push({ role: 'assistant', content: responseText });

                if (responseText.includes('[PROCEED]')) {
                  proceed = true;
                  // Post confirmation (without the sentinel)
                  const cleanResponse = responseText.replace(/\[PROCEED\]/g, '').trim();
                  if (cleanResponse) {
                    try { await handler.getMessages().post(batch.channel, cleanResponse, batch.threadTs); } catch { /* */ }
                  }
                  // Collect all user messages from the conversation as additional context
                  preflightContext = preflightMessages
                    .filter(m => m.role === 'user')
                    .slice(1) // skip the initial system context message
                    .map(m => typeof m.content === 'string' ? m.content : '')
                    .filter(Boolean)
                    .join('\n');
                  logger.info('Pre-flight: user confirmed — proceeding to deep path');
                } else if (responseText.includes('[CANCEL]')) {
                  finalResponse = 'Cancelled.';
                  const cleanResponse = responseText.replace(/\[CANCEL\]/g, '').trim();
                  if (cleanResponse) {
                    try { await handler.getMessages().post(batch.channel, cleanResponse, batch.threadTs); } catch { /* */ }
                  }
                  logger.info('Pre-flight: cancelled by user');
                } else {
                  // Regular response — post to Slack, continue loop
                  const cleanResponse = responseText.replace(/\[PROCEED\]|\[CANCEL\]/g, '').trim();
                  try {
                    const posted = await handler.getMessages().post(batch.channel, cleanResponse, batch.threadTs);
                    botMsgTs = posted.ts;
                  } catch { /* */ }
                }
              }
            }

            if (!finalResponse) {
              await handler.updateProgress('Deep analysis in progress...');
            }
          }

          if (!finalResponse) {
          // Append any additional context from pre-flight conversation to the user prompt
          const deepUserPrompt = preflightContext
            ? `${context.userPrompt}\n\n## Additional context from pre-flight conversation\n${preflightContext.trim()}`
            : context.userPrompt;

          // Set up abort controller so interrupts can kill the SDK subprocess
          const deepAbort = new AbortController();

          // Poll for interrupts while deep path runs — any message from owner kills the subprocess
          const interruptPoll = setInterval(async () => {
            const interrupt = handler.drainInterrupt();
            if (interrupt) {
              const text = interrupt.text.toLowerCase().trim();
              // Only abort on clear cancel signals
              const isCancelIntent = /^(stop|cancel|nevermind|never mind|scratch that|abort|quit|nvm)/.test(text);
              if (isCancelIntent) {
                logger.info({ text: interrupt.text.slice(0, 80) }, 'Cancel interrupt during deep path — aborting');
                deepAbort.abort();
                try { await handler.ackInterrupt(batch.channel, interrupt.ts); } catch { /* */ }
              } else {
                // Non-cancel interrupt during deep path — queue for processing after completion
                // Swap :eyes: for 🔜 so user knows it'll be addressed after
                logger.info({ text: interrupt.text.slice(0, 80) }, 'Non-cancel interrupt during deep path — queued for after completion');
                await handler.queueInterrupt(batch.channel, interrupt.ts);
                // Push back to buffer (drainInterrupt shifted it out) for re-enqueue in completeProcessing
                handler.pushInterrupt(interrupt);
              }
            }
          }, config.agent.interruptPollMs);

          const workingContext = loadWorkingContext(db);
          let result;
          try {
            result = await executeDeepPath(
              deepUserPrompt,
              {
                dataDir: config.dataDir,
                systemPrompt: context.systemPrompt,
                memoryContext: context.memoryResult.context,
                workingContext,
              },
              handler,
              deepAbort.signal,
            );
          } finally {
            clearInterval(interruptPoll);
          }

          if (deepAbort.signal.aborted) {
            // Owner cancelled — acknowledge and stop
            finalResponse = 'Cancelled.';
            logger.info({ durationMs: result.durationMs, toolCalls: result.durationMs }, 'Deep path cancelled by owner');
          } else if (result.success && result.response) {
            finalResponse = result.response;
          } else {
            // Deep path failed — notify user and try fast path
            const errorDetail = result.error?.slice(0, 200) ?? 'unknown error';
            logger.warn({ error: errorDetail, durationMs: result.durationMs }, 'Deep path failed');

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
          } // end if (!finalResponse) — deep path execution
          } // end if (routing.decision === 'deep')
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
        // Extract facts from the owner's message
        if (isRealSlackMessage && message.length > 10) {
          const extractionSource = `slack:${batch.channel}:${lastMsg.ts}`;
          extractFacts(anthropicClient, config.models.classifier, message, extractionSource, db)
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

        // Process findings file from deep path (Opus writes findings to /tmp/clawvato-findings.json)
        if (routing?.decision === 'deep') {
          processDeepPathFindings(db, `deep:${batch.channel}:${lastMsg.ts}`)
            .then(async result => {
              if (result.stored > 0) {
                logger.info(
                  { stored: result.stored, skipped: result.skipped, errors: result.errors },
                  'Deep path findings processed into memory',
                );
                await maybeReflect(db, anthropicClient, config.models.classifier);
              }
            })
            .catch(err => {
              logger.debug({ error: err }, 'Deep path response extraction failed');
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
