/**
 * Router — Haiku complexity classifier that routes to fast or heavy path.
 *
 * Cost: ~$0.0002 per classification (~200ms).
 *
 * FAST path: memory queries, single-source lookups, simple responses.
 * HEAVY path: cross-source reasoning, multi-step tasks, document analysis.
 */

import Anthropic from '@anthropic-ai/sdk';
import { getConfig } from '../config.js';
import { getPrompts } from '../prompts.js';
import { logger } from '../logger.js';

export type RoutingDecision = 'fast' | 'heavy';

export interface RouterResult {
  decision: RoutingDecision;
  confidence: number;
  reasoning: string;
}

/**
 * Classify a message as fast or heavy path.
 *
 * Receives the full assembled context (same thing both paths see):
 * working context, memory, conversation history, and new message.
 * This ensures the router makes the same decision a human would
 * after reading the full Slack thread.
 */
export async function routeMessage(
  client: Anthropic,
  fullContext: string,
): Promise<RouterResult> {
  const config = getConfig();

  try {
    const response = await client.messages.create({
      model: config.models.classifier,
      max_tokens: config.agent.classifierMaxTokens,
      system: getPrompts().router,
      messages: [{ role: 'user', content: fullContext }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    return parseRouterResponse(text);
  } catch (error) {
    logger.warn({ error }, 'Router classification failed — defaulting to fast path');
    return { decision: 'fast', confidence: 0, reasoning: 'Classification failed — defaulting to fast' };
  }
}

/**
 * Parse the classifier's response into a structured result.
 */
function parseRouterResponse(text: string): RouterResult {
  const lines = text.trim().split('\n');
  let decision: RoutingDecision = 'fast';
  let confidence = 50;
  let reasoning = '';

  for (const line of lines) {
    const upper = line.toUpperCase().trim();
    if (upper.startsWith('DECISION:')) {
      decision = upper.includes('HEAVY') ? 'heavy' : 'fast';
    } else if (upper.startsWith('CONFIDENCE:')) {
      const num = parseInt(line.replace(/[^0-9]/g, ''), 10);
      if (!isNaN(num)) confidence = Math.min(100, Math.max(0, num));
    } else if (upper.startsWith('REASON:')) {
      reasoning = line.replace(/^REASON:\s*/i, '').trim();
    }
  }

  logger.info({ decision, confidence, reasoning: reasoning.slice(0, 80) }, 'Message routed');
  return { decision, confidence, reasoning };
}
