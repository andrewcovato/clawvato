/**
 * Agent Loop — Plan-Then-Execute with checkpoint interruption.
 *
 * This is the core agent execution engine. It implements:
 *
 * 1. CLASSIFY (Haiku) — Determine intent from accumulated messages
 * 2. PLAN (Opus) — Generate a structured action plan
 * 3. EXECUTE (Sonnet) — Execute plan steps, checking for interrupts between each
 * 4. RESPOND — Post result back to Slack
 *
 * Checkpoint interruption: between each tool call, the loop checks if the owner
 * sent new messages. If so, the interrupt classifier determines whether to:
 *   - Inject additional context (additive)
 *   - Abort and restart with new task (redirect)
 *   - Cancel entirely (cancel)
 *   - Queue for later (unrelated)
 *
 * The loop receives messages from the SlackHandler as AccumulatedBatches.
 * It does NOT own the Slack connection — that's the handler's job.
 */

import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { classifyInterrupt, generateClarificationMessage, type InterruptType } from '../slack/interrupt-classifier.js';
import type { AccumulatedBatch } from '../slack/event-queue.js';
import type { SlackHandler } from '../slack/handler.js';

export interface PlanStep {
  id: number;
  description: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  status: 'pending' | 'executing' | 'completed' | 'skipped' | 'failed';
  result?: string;
}

export interface AgentPlan {
  summary: string;
  steps: PlanStep[];
  requiresConfirmation: boolean;
}

export interface ToolCallResult {
  success: boolean;
  output: string;
  error?: string;
}

/**
 * Dependencies injected into the agent loop.
 * This keeps the loop testable — no direct Anthropic or Slack API calls.
 */
export interface AgentLoopDeps {
  /** Classify intent using Haiku */
  classify: (message: string) => Promise<{ intent: string; confidence: number }>;

  /** Generate an action plan using Opus */
  plan: (message: string, intent: string, context?: string) => Promise<AgentPlan>;

  /** Execute a single tool call using Sonnet */
  executeTool: (toolName: string, input: Record<string, unknown>) => Promise<ToolCallResult>;

  /** Call Haiku for interrupt classification */
  classifierCall: (systemPrompt: string, userMessage: string) => Promise<string>;

  /** Check for new messages from the owner (reads from a shared queue) */
  checkForInterrupts: (channel: string, threadTs?: string) => string | null;

  /** Acknowledge an interrupt message (thumbs-up reaction) */
  ackInterrupt: (channel: string, messageTs: string) => Promise<void>;
}

export interface LoopResult {
  response: string;
  plan?: AgentPlan;
  interrupted?: { type: InterruptType; newMessage: string };
  error?: string;
}

/**
 * Run the Plan-Then-Execute loop for a single accumulated batch.
 *
 * @param batch - The accumulated messages to process
 * @param deps - Injected dependencies
 * @param slackHandler - For milestone updates and active task tracking
 */
export async function runAgentLoop(
  batch: AccumulatedBatch,
  deps: AgentLoopDeps,
  slackHandler?: SlackHandler,
): Promise<LoopResult> {
  const config = getConfig();
  const message = batch.combinedText;

  logger.info(
    { channel: batch.channel, messageLength: message.length },
    'Agent loop starting',
  );

  try {
    // ── Step 1: Classify Intent (Haiku) ──
    const classification = await deps.classify(message);
    logger.info(
      { intent: classification.intent, confidence: classification.confidence },
      'Intent classified',
    );

    // ── Step 2: Generate Plan (Opus) ──
    const agentPlan = await deps.plan(message, classification.intent);
    logger.info(
      { summary: agentPlan.summary, steps: agentPlan.steps.length },
      'Plan generated',
    );

    // Track active task for interrupt detection
    slackHandler?.setActiveTask(
      agentPlan.summary,
      batch.channel,
      batch.threadTs,
    );

    // ── Step 3: Execute Plan Steps (Sonnet) with checkpoint interruption ──
    const completedSteps: PlanStep[] = [];

    for (const step of agentPlan.steps) {
      // ── CHECKPOINT: Check for interrupts before each step ──
      const interrupt = deps.checkForInterrupts(batch.channel, batch.threadTs);

      if (interrupt) {
        logger.info({ interrupt: interrupt.slice(0, 80) }, 'Interrupt detected at checkpoint');

        const classification = await classifyInterrupt(
          agentPlan.summary,
          interrupt,
          deps.classifierCall,
        );

        // ACK the interrupt with 👍
        // (The interrupt message TS isn't available here — the handler manages this)

        if (classification.shouldAsk) {
          // Low confidence — ask the user what they meant
          slackHandler?.clearActiveTask();
          return {
            response: generateClarificationMessage(agentPlan.summary, interrupt),
            plan: agentPlan,
            interrupted: { type: classification.type, newMessage: interrupt },
          };
        }

        switch (classification.type) {
          case 'cancel':
            logger.info('Task cancelled by owner');
            slackHandler?.clearActiveTask();
            return {
              response: '', // Silence — ✅ reaction handles it
              plan: agentPlan,
              interrupted: { type: 'cancel', newMessage: interrupt },
            };

          case 'redirect':
            logger.info({ newMessage: interrupt.slice(0, 80) }, 'Task redirected by owner');
            slackHandler?.clearActiveTask();
            // Return the redirect so the caller can start a new loop
            return {
              response: '',
              plan: agentPlan,
              interrupted: { type: 'redirect', newMessage: interrupt },
            };

          case 'additive':
            logger.info({ addedContext: interrupt.slice(0, 80) }, 'Additive context injected');
            // Re-plan with the additional context
            // For now, we add it as context to remaining steps
            // TODO: Implement proper re-planning with Opus
            step.description += ` (additional context: ${interrupt})`;
            break;

          case 'unrelated':
            logger.info('Unrelated interrupt — queued for later');
            // The caller is responsible for processing this separately
            break;
        }
      }

      // ── Execute this step ──
      if (!step.toolName) {
        step.status = 'completed';
        completedSteps.push(step);
        continue;
      }

      step.status = 'executing';

      // Update milestone if we have a handler
      if (slackHandler && completedSteps.length > 0) {
        const milestone = `🧠 ${step.description}...`;
        await slackHandler.updateMilestone(milestone);
      }

      logger.debug(
        { step: step.id, tool: step.toolName },
        'Executing step',
      );

      const result = await deps.executeTool(step.toolName, step.toolInput ?? {});

      if (result.success) {
        step.status = 'completed';
        step.result = result.output;
      } else {
        step.status = 'failed';
        step.result = result.error ?? 'Unknown error';
        logger.warn(
          { step: step.id, tool: step.toolName, error: step.result },
          'Step failed',
        );
        // Don't abort the whole plan on one failure — let the planner decide
      }

      completedSteps.push(step);
    }

    // ── Step 4: Generate Response ──
    // In the full implementation, Sonnet synthesizes a response from all step results.
    // For now, we concatenate step results.
    const response = completedSteps
      .filter(s => s.result)
      .map(s => s.result)
      .join('\n') || agentPlan.summary;

    slackHandler?.clearActiveTask();

    logger.info(
      {
        steps: completedSteps.length,
        completed: completedSteps.filter(s => s.status === 'completed').length,
        failed: completedSteps.filter(s => s.status === 'failed').length,
      },
      'Agent loop completed',
    );

    return { response, plan: agentPlan };

  } catch (error) {
    slackHandler?.clearActiveTask();
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errorMsg }, 'Agent loop failed');
    return { response: `Sorry, I hit an error: ${errorMsg}`, error: errorMsg };
  }
}
