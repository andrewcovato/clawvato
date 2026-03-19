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
import { logger } from '../logger.js';

export type RoutingDecision = 'fast' | 'heavy';

export interface RouterResult {
  decision: RoutingDecision;
  confidence: number;
  reasoning: string;
}

const CLASSIFIER_PROMPT = `You are a complexity classifier for a personal AI assistant. You will see the user's NEW MESSAGE and recent CONVERSATION HISTORY for context.

Decide whether the new message needs the FAST path or HEAVY path.

FAST — can be answered from memory or a single API call:
- Memory lookups: "who is Sarah?", "what's my preference for X?"
- Single calendar check: "what's my next meeting?", "when is the standup?"
- Simple commands: "remember X", "update working context"
- Status checks from one source: "did Sarah reply?" (just check memory)
- Greetings, acknowledgments, simple questions

HEAVY — needs reasoning, multiple sources, or multi-step work:
- Cross-source queries: "what's outstanding across email and meetings?"
- Email analysis: "find that email about the budget", "what did Sarah commit to?"
- Meeting deep dives: "prep me for the Acme call", "summarize last week's meetings"
- Document analysis: "read the SOW and tell me the deliverables"
- Multi-step tasks: "draft a follow-up email based on the meeting"
- Synthesis: "cross-reference X with Y", "give me a status report"
- Ambiguous requests that need investigation: "what's going on with Project X?"
- Follow-ups to a previous HEAVY task: "try again", "continue", "do it"

IMPORTANT: If the conversation history shows the user was previously asking for something complex (cross-source search, comprehensive analysis, etc.) and the new message is a follow-up ("try again", "yes do it", "continue", "approved", "go ahead"), classify as HEAVY.

Output exactly one line: FAST or HEAVY
Then a confidence score 0-100.
Then one sentence explaining why.

Format:
DECISION: <FAST|HEAVY>
CONFIDENCE: <0-100>
REASON: <explanation>`;

/**
 * Classify a message as fast or heavy path.
 * Includes conversation history so follow-ups route correctly.
 */
export async function routeMessage(
  client: Anthropic,
  message: string,
  conversationHistory?: string,
): Promise<RouterResult> {
  const config = getConfig();

  // Build the classifier input with context
  let classifierInput = '';
  if (conversationHistory) {
    classifierInput += `CONVERSATION HISTORY:\n${conversationHistory}\n\n`;
  }
  classifierInput += `NEW MESSAGE: ${message}`;

  try {
    const response = await client.messages.create({
      model: config.models.classifier,
      max_tokens: 100,
      system: CLASSIFIER_PROMPT,
      messages: [{ role: 'user', content: classifierInput }],
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
