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
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, mkdirSync, readdirSync, rmSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from '../db/index.js';
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
import { executeDeepPath, seedWorkspace } from './deep-path.js';
import { planContext } from './context-planner.js';
import { extractFacts, storeExtractionResult, type ExtractedFact } from '../memory/extractor.js';
import { maybeReflect } from '../memory/reflection.js';
import { findOrCreateCategory, insertMemory, findDuplicates, supersedeMemory, deleteEmbedding, insertEmbedding } from '../memory/store.js';
import { contentSimilarity } from '../memory/extractor.js';
import { embedBatch } from '../memory/embeddings.js';
import { classifyInterrupt, generateClarificationMessage } from '../slack/interrupt-classifier.js';
import { createTaskTools, type TaskToolContext } from '../tasks/tools.js';
import type { TaskChannelManager } from '../tasks/channel-manager.js';
import { scanForSecrets } from '../security/output-sanitizer.js';
import type { SlackHandler } from '../slack/handler.js';
import type { AccumulatedBatch } from '../slack/event-queue.js';

export interface HybridAgent {
  processBatch(batch: AccumulatedBatch, handler: SlackHandler): Promise<void>;
  shutdown(): Promise<void>;
  /** Expose the full fast-path tool list for task executor reuse */
  getFastPathTools(): Array<{ definition: Anthropic.Tool; handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult> }>;
}

export interface HybridAgentOptions {
  apiKey?: string;
  botClient: WebClient;
  userClient?: WebClient;
  taskChannelManager?: TaskChannelManager;
}

/** Create a unique workspace directory per deep-path invocation.
 *  Must be inside cwd — Claude CLI sandbox blocks writes outside the project dir. */
function createWorkspaceDir(): string {
  const baseDir = join(process.cwd(), '.workspaces');
  mkdirSync(baseDir, { recursive: true });
  return mkdtempSync(join(baseDir, 'ws-'));
}

/**
 * Process all files written by the deep path to its workspace directory.
 *
 * The deep path model writes findings as files in any format — .md, .txt, .json, etc.
 * This function reads each file and routes it through the appropriate pipeline:
 * - .json files: parsed as structured findings (legacy findings file format)
 * - Everything else (.md, .txt, etc.): fed through Haiku extraction to produce atomic facts
 *
 * All extracted facts go through dedup + embedding before storage.
 * Runs as a background task after deep path completes.
 */
async function processWorkspaceFiles(
  db: Sql,
  anthropicClient: Anthropic,
  classifierModel: string,
  source: string,
  workspaceDir: string,
  opts?: { surface_id?: string },
): Promise<{ stored: number; skipped: number; errors: number; filesProcessed: number }> {
  let stored = 0;
  let skipped = 0;
  let errors = 0;
  let filesProcessed = 0;

  const findingsDir = join(workspaceDir, 'findings');

  if (!existsSync(findingsDir)) {
    logger.info('No findings directory in workspace — skipping');
    return { stored, skipped, errors, filesProcessed };
  }

  try {
    const files = readdirSync(findingsDir).filter(f => !f.startsWith('.'));

    if (files.length === 0) {
      logger.info('Workspace directory empty — no findings to process');
      return { stored, skipped, errors, filesProcessed };
    }

    logger.info({ fileCount: files.length, files }, 'Processing deep path workspace files');

    for (const fileName of files) {
      const filePath = join(findingsDir, fileName);
      try {
        const content = readFileSync(filePath, 'utf-8').trim();
        if (!content || content.length < 10) continue;

        filesProcessed++;

        if (fileName.endsWith('.json')) {
          // Structured JSON — parse and store directly (legacy findings file path)
          const result = await processStructuredFindings(db, source, content, { surface_id: opts?.surface_id });
          stored += result.stored;
          skipped += result.skipped;
          errors += result.errors;
        } else {
          // Unstructured text (.md, .txt, etc.) — extract via Haiku
          const fileSource = `${source}:file:${fileName}`;
          const result = await extractFacts(anthropicClient, classifierModel, content, fileSource, db);
          if (result.facts.length > 0) {
            const storeResult = await storeExtractionResult(db, result, fileSource, { surface_id: opts?.surface_id });
            stored += storeResult.memoriesStored;
            skipped += storeResult.duplicatesSkipped;
          }
          logger.debug(
            { fileName, facts: result.facts.length },
            'Workspace file extracted',
          );
        }
      } catch (err) {
        errors++;
        logger.debug({ error: err, fileName }, 'Failed to process workspace file');
      }
    }
  } catch (err) {
    logger.warn({ error: err }, 'Failed to process workspace directory');
  } finally {
    // Persist workspace for debugging if DEBUG_WORKSPACE is set
    if (process.env.DEBUG_WORKSPACE) {
      try {
        const debugDir = join(process.env.DEBUG_WORKSPACE, `workspace-${new Date().toISOString().replace(/[:.]/g, '-')}`);
        mkdirSync(debugDir, { recursive: true });
        cpSync(workspaceDir, debugDir, { recursive: true });
        logger.info({ debugDir }, 'Workspace persisted for debugging');
      } catch (err) {
        logger.debug({ error: err }, 'Failed to persist debug workspace');
      }
    }
    // NOTE: Workspace cleanup is handled by the processBatch finally block,
    // not here, to prevent orphaned directories if the process crashes
    // between completeProcessing() and this fire-and-forget function.
  }

  return { stored, skipped, errors, filesProcessed };
}

/**
 * Process a structured JSON findings file (legacy format).
 * Handles both JSON arrays and JSONL (one object per line).
 */
async function processStructuredFindings(
  db: Sql,
  source: string,
  raw: string,
  opts?: { surface_id?: string },
): Promise<{ stored: number; skipped: number; errors: number }> {
  let stored = 0;
  let skipped = 0;
  let errors = 0;

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
    logger.warn({ rawLength: raw.length }, 'Structured findings empty or unparseable');
    return { stored, skipped, errors };
  }

  logger.info({ findingsCount: findings.length }, 'Processing structured findings');

  const newMemoryIds: { id: string; content: string }[] = [];

  for (const finding of findings) {
    try {
      const content = String(finding.content ?? '').slice(0, 10_000);
      if (!content || content.length < 10) continue;

      const type = await findOrCreateCategory(db, String(finding.type ?? 'fact'));
      const entities = Array.isArray(finding.entities) ? finding.entities.map(String) : [];
      const importance = Math.max(1, Math.min(10, Math.round(Number(finding.importance) || 5)));
      const confidence = Math.max(0, Math.min(1, Number(finding.confidence) || 0.7));
      const factSource = finding.source ? `${source}:${finding.source}` : source;

      const duplicates = await findDuplicates(db, content, type);
      const closeMatch = duplicates.find(d => contentSimilarity(d.content, content) > 0.8);

      if (closeMatch) {
        if (confidence > closeMatch.confidence) {
          const newId = await insertMemory(db, { type, content, source: factSource, importance, confidence, entities, surface_id: opts?.surface_id });
          await supersedeMemory(db, closeMatch.id, newId);
          await deleteEmbedding(db, closeMatch.id);
          newMemoryIds.push({ id: newId, content });
          stored++;
        } else {
          skipped++;
        }
      } else {
        const newId = await insertMemory(db, { type, content, source: factSource, importance, confidence, entities, surface_id: opts?.surface_id });
        newMemoryIds.push({ id: newId, content });
        stored++;
      }
    } catch (err) {
      errors++;
      logger.debug({ error: err, finding: JSON.stringify(finding).slice(0, 200) }, 'Failed to process finding');
    }
  }

  if (newMemoryIds.length > 0) {
    try {
      const texts = newMemoryIds.map(m => m.content);
      const embeddings = await embedBatch(texts, 'document');
      for (let i = 0; i < newMemoryIds.length; i++) {
        await insertEmbedding(db, newMemoryIds[i].id, embeddings[i]);
      }
      logger.debug({ count: newMemoryIds.length }, 'Structured findings embeddings stored');
    } catch (err) {
      logger.debug({ error: err }, 'Findings embedding failed — stored without vectors');
    }
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

  // Task queue tools — context is mutable, updated per-batch
  const taskCtx: TaskToolContext = {};
  const taskTools = createTaskTools(db, taskCtx, options.taskChannelManager);
  fastPathTools.push(...taskTools);

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

      // ── Update task tool context for this batch ──
      taskCtx.channelName = batch.channel; // will be replaced with resolved name below

      // ── Assemble shared context ──
      const context = await assembleContext(
        db,
        options.botClient,
        message,
        batch.channel,
        { botUserId, ownerUserId: config.ownerSlackUserId },
      );

      // Update task context with resolved channel name
      taskCtx.channelName = context.channelLabel;

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
      let workspaceDir: string | undefined;

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
            surfaces: [process.env.CLAWVATO_SURFACE ?? 'cloud', 'global'],
          });
          const deepWorkingContext = await loadWorkingContext(db, config.context.deepPathWorkingContextTokenBudget);

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

          // Context planner: Opus-powered pre-step that replaces preflight.
          // Gathers context from memory + tools while conversing with the user.
          let contextPlan: Awaited<ReturnType<typeof planContext>> | undefined;
          if (isRealSlackMessage) {
            contextPlan = await planContext(
              message,
              context.userPrompt,
              handler,
              batch.channel,
              batch.threadTs,
              {
                anthropicClient,
                sql: db,
                tools: fastPathTools,
              },
            );

            if (contextPlan.cancelled) {
              finalResponse = ' '; // non-empty but blank — prevents main response from posting
              logger.info('Context planner: cancelled by user');
            } else {
              // Start fresh processing cycle for deep path progress updates
              await handler.completeProcessing();
              await handler.startProcessing('Deep analysis...', batch.channel, [], batch.threadTs);
              await handler.updateProgress('Deep analysis in progress...');
              logger.info('Context planner: user confirmed — proceeding to deep path');
            }
          }

          if (!finalResponse) {
          // Build the deep path user prompt
          const deepPromptParts = [`## Request (in #${context.channelLabel})\n${message}`];
          if (contextPlan?.userClarifications) {
            deepPromptParts.push(`## Additional context from user\n${contextPlan.userClarifications.trim()}`);
          }
          const deepUserPrompt = deepPromptParts.join('\n\n');

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

          workspaceDir = createWorkspaceDir();
          seedWorkspace(workspaceDir, {
            memory: context.memoryResult.context,
            workingContext: deepWorkingContext,
            conversation: context.conversationHistory,
            channelLabel: context.channelLabel,
          });

          // Write planner context to workspace if available
          if (contextPlan?.gatheredContext) {
            writeFileSync(
              join(workspaceDir, 'context', 'planner-context.md'),
              contextPlan.gatheredContext,
            );
          }

          // Determine analysis mode: context planner says gathered context is sufficient
          const isAnalysisMode = contextPlan?.sufficientForAnalysis ?? false;

          let result;
          try {
            result = await executeDeepPath(
              deepUserPrompt,
              {
                dataDir: config.dataDir,
                workspaceDir,
                analysisMode: isAnalysisMode,
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
            logger.info({ durationMs: result.durationMs }, 'Deep path cancelled by owner');
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
          // ── Fast / Medium Path: direct API ──
          // Medium uses Opus for better reasoning; fast uses Sonnet for speed
          const model = routing.decision === 'medium' ? config.models.reasoner : undefined;
          const fastResult = await executeFastPath(
            context.userPrompt,
            context.systemPrompt,
            { client: anthropicClient, db, tools: fastPathTools, model },
            handler,
          );
          finalResponse = fastResult.response;
        }

        // ── Post response ──
        if (finalResponse && !finalResponse.trim().includes(NO_RESPONSE)) {
          let cleanResponse = finalResponse.replace(/\[NO_RESPONSE\]/g, '').trim();
          if (cleanResponse) {
            // Sanitize: scan for accidentally leaked secrets before posting
            const scan = scanForSecrets(cleanResponse);
            if (scan.hasSecrets) {
              logger.warn({ patterns: scan.matches?.length }, 'Secrets detected in response — redacting before Slack post');
              cleanResponse = scan.redacted;
            }
            logger.info({ responseLength: cleanResponse.length, path: routing.decision }, 'Posting response');
            try {
              if (isAssistantMode) {
                await assistantAPI.say(cleanResponse);
              } else {
                await handler.getMessages().post(batch.channel, cleanResponse, batch.threadTs);
              }
            } catch (error) {
              const errDetail = error instanceof Error ? error.message : String(error);
              logger.error({ error: errDetail }, 'Failed to post response to Slack');

              // Fallback: if deep path response failed to post, save it to memory
              // so the work isn't lost entirely
              if (routing?.decision === 'deep' && cleanResponse.length > 200) {
                try {
                  const truncated = cleanResponse.slice(0, 10_000);
                  await insertMemory(db, {
                    type: 'research',
                    content: `[Undelivered deep path response] ${truncated}`,
                    source: `deep:${batch.channel}:${lastMsg.ts}:undelivered`,
                    importance: 8,
                    confidence: 0.9,
                    entities: [],
                  });
                  logger.info({ responseLength: cleanResponse.length }, 'Deep path response saved to memory as fallback');
                } catch (memErr) {
                  logger.error({ error: memErr }, 'Failed to save fallback response to memory');
                }
              }

              // Always tell the user something went wrong
              try {
                const userMsg = routing?.decision === 'deep'
                  ? `Sorry, I finished the analysis but hit an error posting the response (${errDetail.slice(0, 100)}). The response has been saved to my memory — ask me to retrieve it.`
                  : `Sorry, I hit an error posting my response: ${errDetail.slice(0, 100)}`;
                await handler.getMessages().post(batch.channel, userMsg, batch.threadTs);
              } catch { /* last resort — can't reach Slack at all */ }
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
          const extractionSurfaceId = process.env.CLAWVATO_SURFACE ?? 'cloud';
          extractFacts(anthropicClient, config.models.classifier, message, extractionSource, db)
            .then(async result => {
              if (result.facts.length > 0) {
                await storeExtractionResult(db, result, extractionSource, { surface_id: extractionSurfaceId });
                await maybeReflect(db, anthropicClient, config.models.classifier);
              }
            })
            .catch(err => {
              logger.debug({ error: err }, 'Background extraction failed');
            });
        }

        // Process workspace files from deep path (unique dir per invocation)
        // Cleanup happens here (not in processWorkspaceFiles) to prevent orphaned
        // directories if the process crashes between completeProcessing() and the
        // fire-and-forget processWorkspaceFiles call.
        if (routing?.decision === 'deep' && workspaceDir) {
          const wsDir = workspaceDir; // capture for closure
          processWorkspaceFiles(db, anthropicClient, config.models.classifier, `deep:${batch.channel}:${lastMsg.ts}`, wsDir, { surface_id: process.env.CLAWVATO_SURFACE ?? 'cloud' })
            .then(async result => {
              if (result.stored > 0 || result.filesProcessed > 0) {
                logger.info(
                  { stored: result.stored, skipped: result.skipped, errors: result.errors, filesProcessed: result.filesProcessed },
                  'Deep path workspace files processed into memory',
                );
                await maybeReflect(db, anthropicClient, config.models.classifier);
              } else {
                logger.info('Deep path produced no workspace files — no findings captured');
              }
            })
            .catch(err => {
              logger.debug({ error: err }, 'Deep path workspace processing failed');
            })
            .finally(() => {
              // Always clean up workspace directory, even if processing fails
              try { rmSync(wsDir, { recursive: true }); } catch { /* best effort */ }
            });
        }

        logger.info({ channel: batch.channel }, 'processBatch complete');
      }
    },

    async shutdown() {
      logger.info('Hybrid agent shutting down');
    },

    getFastPathTools() {
      return fastPathTools;
    },
  };
}
