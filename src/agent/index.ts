import { getConfig } from '../config.js';
import { logger } from '../logger.js';
import { requireCredential } from '../credentials.js';

/**
 * Agent bootstrap — configures the Claude Agent SDK runtime.
 *
 * The Agent SDK handles:
 * - Agent loop (message → tool call → response)
 * - MCP server connections
 * - Tool routing and discovery
 * - Model selection per subagent
 * - Session persistence
 *
 * Our code configures:
 * - Which MCP servers to connect to
 * - PreToolUse / PostToolUse hooks (security, audit)
 * - Model routing (Haiku/Opus/Sonnet)
 * - Training wheels policy
 *
 * This is a skeleton for Track A. Full implementation in Track B.
 */

export interface AgentOptions {
  /** Override the Anthropic API key (otherwise reads from Keychain/env) */
  apiKey?: string;
}

export async function createAgent(options?: AgentOptions) {
  const config = getConfig();
  const apiKey = options?.apiKey ?? await requireCredential('anthropic-api-key');

  logger.info('Initializing agent...');

  // Agent SDK will be fully configured in Track B.
  // For now, verify we can reach the Anthropic API.
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  logger.info({
    models: config.models,
    trustLevel: config.trustLevel,
  }, 'Agent initialized');

  return {
    client,
    config,

    /**
     * Process a user message through the Plan-Then-Execute loop.
     * Skeleton — full implementation in Track B.
     */
    async processMessage(message: string, context?: { slackChannel?: string; slackThreadTs?: string }) {
      logger.info({ messageLength: message.length, context }, 'Processing message');

      // Track B will implement:
      // 1. Classify intent (Haiku)
      // 2. Retrieve memory context
      // 3. Generate plan (Opus)
      // 4. Execute plan steps (Sonnet) with PreToolUse/PostToolUse hooks
      // 5. Store new memories from interaction

      return {
        response: 'Agent is running but not yet connected to integrations. Track B will add Slack + Agent SDK query loop.',
        actions: [],
      };
    },
  };
}
