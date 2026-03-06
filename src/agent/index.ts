/**
 * Agent Orchestrator — configures the Claude Agent SDK and wires everything together.
 *
 * The Agent SDK replaces our custom Plan-Then-Execute loop with native capabilities:
 * - Automatic tool-calling loop (message → tool call → response)
 * - MCP server discovery (tools auto-discovered via mcpServers config)
 * - PreToolUse/PostToolUse hooks (our security + interrupt bridge)
 *
 * Architecture:
 *   Sonnet handles the full agent loop (understanding → planning → executing → responding)
 *   Haiku handles interrupt classification only (fast, cheap, called in hook code)
 *   Opus reserved for future complex reasoning tasks
 *
 * Our value-add (not in the SDK):
 *   EventQueue — message accumulation with debounce + typing awareness
 *   SlackHandler — reaction lifecycle (⏳→🧠→response), milestone updates
 *   Interrupt classifier — four-way classification (additive/redirect/cancel/unrelated)
 *   Training wheels — policy engine + graduation
 *   All security modules — sender verify, output sanitizer, path validator, rate limiter
 */

import Anthropic from '@anthropic-ai/sdk';
import { query, type HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { requireCredential } from '../credentials.js';
import { getDb } from '../db/index.js';
import { createSlackMcpServer } from '../mcp/slack/server.js';
import { createPreToolUseHook, createPostToolUseHook, type InterruptState } from './hooks.js';
import type { SlackHandler } from '../slack/handler.js';
import type { AccumulatedBatch } from '../slack/event-queue.js';
import type { WebClient } from '@slack/web-api';

const SYSTEM_PROMPT = `You are Clawvato, a personal AI chief of staff. You help your owner manage their work life — Slack messages, meetings, emails, documents, and tasks.

Personality:
- Concise and professional, with occasional dry humor
- You prefer action over asking unnecessary questions
- When uncertain, you ask one clear question rather than guessing
- You use reactions and brief responses rather than long explanations

Guidelines:
- You can search Slack, post messages, and look up user info using the slack tools
- Always confirm before sending messages on the owner's behalf
- Never share the owner's private information with others
- When you complete a task, report the result briefly — no need to narrate your process
- If a task has multiple steps, report meaningful milestones (e.g., "Found 3 available slots, drafting invite...")`;

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
 * Create the agent orchestrator.
 * Configures the Agent SDK with MCP servers and security hooks.
 */
export async function createAgent(options: AgentOptions): Promise<Agent> {
  const config = getConfig();
  const apiKey = options.apiKey ?? await requireCredential('anthropic-api-key');
  const db = getDb();

  // Create Anthropic client for Haiku interrupt classification
  const anthropicClient = new Anthropic({ apiKey });

  // Create the Slack MCP server (in-process via SDK's createSdkMcpServer)
  const slackMcp = createSlackMcpServer(options.botClient, options.userClient);

  logger.info({
    model: config.models.executor,
    trustLevel: config.trustLevel,
  }, 'Agent initialized');

  /**
   * Haiku classifier function — used by interrupt classifier.
   * Intentionally cheap and fast (Haiku is ~20x cheaper than Sonnet).
   */
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

  return {
    async processBatch(batch: AccumulatedBatch, handler: SlackHandler): Promise<void> {
      const message = batch.combinedText;

      logger.info(
        { channel: batch.channel, messageLength: message.length },
        'Agent processing batch',
      );

      // Set active task for interrupt routing
      handler.setActiveTask(
        message.slice(0, 100),
        batch.channel,
        batch.threadTs,
      );

      // Post initial ACK message for milestone updates
      let ackTs: string | undefined;
      try {
        const messages = handler.getMessages();
        const ackResult = await messages.post(
          batch.channel,
          `🧠 Working on it...`,
          batch.threadTs,
        );
        ackTs = ackResult.ts;
        handler.setActiveTask(
          message.slice(0, 100),
          batch.channel,
          batch.threadTs,
          ackTs,
        );
      } catch {
        // Non-critical — we can still respond without the ACK message
      }

      // Create interrupt state (shared between hook and this orchestrator)
      const interruptState: InterruptState = { type: null };

      // Create hooks with current handler state
      const preToolUseHook = createPreToolUseHook(
        handler,
        db,
        classifierCall,
        interruptState,
        config.ownerSlackUserId,
      );

      const postToolUseHook = createPostToolUseHook(db);

      try {
        // Run the Agent SDK query
        const agentQuery = query({
          prompt: message,
          options: {
            model: config.models.executor,
            systemPrompt: SYSTEM_PROMPT,
            mcpServers: {
              slack: slackMcp,
            },
            permissionMode: 'bypassPermissions',
            hooks: {
              PreToolUse: [{
                hooks: [preToolUseHook as unknown as HookCallback],
              }],
              PostToolUse: [{
                hooks: [postToolUseHook as unknown as HookCallback],
              }],
            },
          },
        });

        // Iterate the async generator to completion, collecting the final response
        let finalResponse = '';
        for await (const sdkMessage of agentQuery) {
          // The SDK emits various message types; we care about the assistant's text
          if (sdkMessage && typeof sdkMessage === 'object' && 'type' in sdkMessage) {
            const msg = sdkMessage as Record<string, unknown>;
            if (msg.type === 'assistant' && typeof msg.content === 'string') {
              finalResponse = msg.content;
            }
            // Handle content blocks
            if (msg.type === 'assistant' && Array.isArray(msg.content)) {
              const textBlocks = (msg.content as Array<Record<string, unknown>>)
                .filter(b => b.type === 'text')
                .map(b => b.text as string);
              if (textBlocks.length > 0) {
                finalResponse = textBlocks.join('\n');
              }
            }
          }
        }

        const messages = handler.getMessages();

        // Check if we were interrupted
        if (interruptState.type === 'cancel') {
          logger.info('Task cancelled by owner interrupt');
          if (ackTs) {
            try {
              await messages.update(batch.channel, ackTs, '✅ Cancelled.');
            } catch { /* non-critical */ }
          }
          handler.clearActiveTask();
          return;
        }

        if (interruptState.type === 'redirect' && interruptState.newMessage) {
          logger.info({ newMessage: interruptState.newMessage.slice(0, 80) }, 'Task redirected');
          if (ackTs) {
            try {
              await messages.update(batch.channel, ackTs, '↪️ Redirecting...');
            } catch { /* non-critical */ }
          }
          handler.clearActiveTask();
          // Re-enqueue the redirect message for processing
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
            await messages.post(
              batch.channel,
              interruptState.clarificationMessage,
              batch.threadTs,
            );
          } catch (error) {
            logger.error({ error }, 'Failed to post clarification message');
          }
          handler.clearActiveTask();
          return;
        }

        // Post the final response
        if (finalResponse) {
          try {
            if (ackTs) {
              await messages.update(batch.channel, ackTs, finalResponse);
            } else {
              await messages.post(batch.channel, finalResponse, batch.threadTs);
            }
          } catch (error) {
            logger.error({ error }, 'Failed to post response to Slack');
          }
        }

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.error({ error: errorMsg }, 'Agent query failed');

        try {
          const errorText = `Sorry, I hit an error: ${errorMsg}`;
          const messages = handler.getMessages();
          if (ackTs) {
            await messages.update(batch.channel, ackTs, errorText);
          } else {
            await messages.post(batch.channel, errorText, batch.threadTs);
          }
        } catch { /* non-critical */ }
      }

      handler.clearActiveTask();
    },

    async shutdown() {
      logger.info('Agent shutting down');
    },
  };
}
