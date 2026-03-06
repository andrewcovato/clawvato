/**
 * Agent SDK Hook Adapters — bridges our security modules to the SDK's hook system.
 *
 * The Agent SDK fires hooks at two checkpoints:
 *   PreToolUse  — before each tool call (our security gate + interrupt checkpoint)
 *   PostToolUse — after each tool call (audit logging + output sanitization)
 *
 * These adapters call our existing security functions (sender-verify, rate-limiter,
 * path-validator, policy-engine) and training wheels (graduation) — keeping all
 * security logic in our modules rather than duplicating it in hook callbacks.
 */

import { logger } from '../logger.js';
import { preToolUse, type ToolUseContext } from '../hooks/pre-tool-use.js';
import { postToolUse, type ToolResult } from '../hooks/post-tool-use.js';
import { evaluatePolicy } from '../training-wheels/policy-engine.js';
import { isGraduated } from '../training-wheels/graduation.js';
import { classifyInterrupt, generateClarificationMessage } from '../slack/interrupt-classifier.js';
import { getConfig } from '../config.js';
import type { SlackHandler } from '../slack/handler.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * State shared between the hook and the orchestrator.
 * When a redirect or cancel happens, the orchestrator needs to know.
 */
export interface InterruptState {
  type: 'cancel' | 'redirect' | 'additive' | null;
  newMessage?: string;
  clarificationMessage?: string;
}

// The Agent SDK hook callback signature:
// (input: HookInput, toolUseID: string | undefined, options: { signal: AbortSignal }) => Promise<HookJSONOutput>
// We define compatible types here to avoid importing SDK internal types directly.

interface HookInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
  tool_use_id?: string;
  session_id?: string;
  [key: string]: unknown;
}

interface HookOutput {
  continue?: boolean;
  decision?: 'approve' | 'block';
  reason?: string;
  hookSpecificOutput?: Record<string, unknown>;
}

/**
 * Create the PreToolUse hook callback for the Agent SDK.
 *
 * This hook fires before every tool call and performs:
 * 1. Interrupt checking (drain from handler's buffer)
 * 2. Security checks (sender verify, rate limit, path validation)
 * 3. Training wheels policy enforcement
 *
 * @param handler - SlackHandler for interrupt buffer access
 * @param db - Database for graduation status checks
 * @param classifierFn - Function to call Haiku for interrupt classification
 * @param interruptState - Shared state for communicating interrupts to orchestrator
 * @param senderSlackId - The owner's Slack user ID (for sender verification)
 */
export function createPreToolUseHook(
  handler: SlackHandler,
  db: DatabaseSync,
  classifierFn: (systemPrompt: string, userMessage: string) => Promise<string>,
  interruptState: InterruptState,
  senderSlackId?: string,
) {
  return async (input: HookInput, _toolUseID: string | undefined, _options: { signal: AbortSignal }): Promise<HookOutput> => {
    const toolName = input.tool_name ?? 'unknown';
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;

    // Derive server name from tool name (MCP tools are prefixed: mcp__slack__tool_name)
    const serverName = toolName.startsWith('mcp__') ? toolName.split('__')[1] ?? 'unknown' : 'agent';

    // ── 1. Interrupt Check ──
    const interrupt = handler.drainInterrupt();
    if (interrupt) {
      const activeTask = handler.getActiveTask();
      const taskDescription = activeTask?.description ?? 'current task';

      logger.info({ interrupt: interrupt.text.slice(0, 80) }, 'Interrupt detected at PreToolUse checkpoint');

      // ACK the interrupt message
      if (activeTask) {
        await handler.ackInterrupt(activeTask.channel, interrupt.ts);
      }

      try {
        const classification = await classifyInterrupt(taskDescription, interrupt.text, classifierFn);

        if (classification.shouldAsk) {
          // Low confidence — generate clarification and block
          interruptState.type = 'cancel';
          interruptState.clarificationMessage = generateClarificationMessage(taskDescription, interrupt.text);
          return {
            decision: 'block',
            reason: 'Interrupt requires clarification',
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: 'Interrupt requires clarification from user',
            },
          };
        }

        switch (classification.type) {
          case 'cancel':
            interruptState.type = 'cancel';
            return {
              decision: 'block',
              reason: 'Task cancelled by owner',
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Task cancelled by owner',
              },
            };

          case 'redirect':
            interruptState.type = 'redirect';
            interruptState.newMessage = interrupt.text;
            return {
              decision: 'block',
              reason: 'Task redirected by owner',
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'deny',
                permissionDecisionReason: 'Task redirected by owner',
              },
            };

          case 'additive':
            interruptState.type = 'additive';
            interruptState.newMessage = interrupt.text;
            // Allow the tool call but inject additional context
            return {
              continue: true,
              hookSpecificOutput: {
                hookEventName: 'PreToolUse',
                permissionDecision: 'allow',
                additionalContext: `Additional context from owner: ${interrupt.text}`,
              },
            };

          case 'unrelated':
            // Queue for later processing — don't interrupt current work
            logger.info('Unrelated interrupt — will process after current task');
            break;
        }
      } catch (error) {
        logger.error({ error }, 'Interrupt classification failed — continuing');
      }
    }

    // ── 2. Security Checks ──
    const securityCtx: ToolUseContext = {
      toolName,
      serverName,
      input: toolInput,
      senderSlackId,
    };

    const securityResult = preToolUse(securityCtx);
    if (!securityResult.allowed) {
      return {
        decision: 'block',
        reason: securityResult.reason ?? 'Security check failed',
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: securityResult.reason,
        },
      };
    }

    // ── 3. Training Wheels Policy ──
    const config = getConfig();
    const graduated = isGraduated(db, toolName);
    const policy = evaluatePolicy(toolName, graduated, config.trustLevel);

    if (!policy.autoApproved) {
      logger.info(
        { toolName, reason: policy.reason },
        'Training wheels: tool requires confirmation',
      );
      // At trust level 0-2, non-graduated actions need confirmation.
      // For now, we allow them (the SDK doesn't have Slack confirmation built in).
      // TODO: Implement Block Kit confirmation flow via Bolt action handlers.
      // For MVP, we log the policy decision but allow the action.
    }

    // ── Allow the tool call ──
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    };
  };
}

/**
 * Create the PostToolUse hook callback for the Agent SDK.
 *
 * This hook fires after every tool call and performs:
 * 1. Audit logging
 * 2. Output sanitization (secret scanning)
 * 3. Graduation recording
 */
export function createPostToolUseHook(db: DatabaseSync) {
  return async (input: HookInput, _toolUseID: string | undefined, _options: { signal: AbortSignal }): Promise<HookOutput> => {
    const toolName = input.tool_name ?? 'unknown';
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    const toolResponse = input.tool_response;
    const serverName = toolName.startsWith('mcp__') ? toolName.split('__')[1] ?? 'unknown' : 'agent';

    // Determine success from response (best effort)
    const responseStr = typeof toolResponse === 'string'
      ? toolResponse
      : JSON.stringify(toolResponse ?? '').slice(0, 500);
    const isError = typeof toolResponse === 'object' && toolResponse !== null &&
      'isError' in toolResponse && (toolResponse as Record<string, unknown>).isError === true;

    const result: ToolResult = {
      toolName,
      serverName,
      input: toolInput,
      output: responseStr,
      success: !isError,
      error: isError ? responseStr : undefined,
      durationMs: 0, // Not available from the SDK hook
    };

    const { sanitizedOutput } = postToolUse(result);

    // Record for graduation tracking (all outcomes are 'approved' since
    // the tool was allowed to execute — rejections are in PreToolUse)
    try {
      const { recordOccurrence } = await import('../training-wheels/graduation.js');
      recordOccurrence(db, toolName, `Tool call: ${toolName}`, {}, 'approved');
    } catch (error) {
      logger.debug({ error }, 'Failed to record graduation occurrence — non-critical');
    }

    // If output was sanitized, inject it back
    if (sanitizedOutput !== responseStr) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          updatedMCPToolOutput: sanitizedOutput,
        },
      };
    }

    return { continue: true };
  };
}
