/**
 * Interrupt Classifier — determines what to do when new messages arrive
 * while the agent is actively processing a task.
 *
 * Uses Haiku for fast, cheap classification into four categories:
 *   additive   — "also check X" — inject into current context
 *   redirect   — "actually do Y instead" — abort current, start Y
 *   cancel     — "scratch that" / "never mind" — abort, idle
 *   unrelated  — different topic entirely — queue separately
 *
 * When classification confidence is low, returns 'ask' to prompt the user.
 */

import { logger } from '../logger.js';

export type InterruptType = 'additive' | 'redirect' | 'cancel' | 'unrelated';

export interface InterruptClassification {
  type: InterruptType;
  confidence: number;
  /** If confidence is below threshold, suggest asking the user */
  shouldAsk: boolean;
}

const CONFIDENCE_THRESHOLD = 0.7;

const CLASSIFICATION_PROMPT = `You are an interrupt classifier for a personal AI agent. The agent is currently working on a task when the user sends a new message.

Classify the new message into exactly one category:

- additive: The message adds context to the current task (e.g., "also include the Q3 deck", "and make it 30 minutes", "mention the projector")
- redirect: The message replaces the current task entirely (e.g., "actually, make a reservation at Prato instead", "never mind that, do Y")
- cancel: The message cancels the current task with no replacement (e.g., "scratch that", "stop", "never mind", "forget it")
- unrelated: The message is about a completely different topic (e.g., asking about something else while agent works)

Respond with JSON only: {"type": "<category>", "confidence": <0.0-1.0>}`;

/**
 * Classify an interrupt message against the current task context.
 *
 * @param currentTaskDescription - What the agent is currently working on
 * @param newMessage - The interrupt message from the user
 * @param classifierFn - Function to call Haiku (injected for testability)
 */
export async function classifyInterrupt(
  currentTaskDescription: string,
  newMessage: string,
  classifierFn: (systemPrompt: string, userMessage: string) => Promise<string>,
): Promise<InterruptClassification> {

  // Fast-path: obvious cancel patterns don't need an LLM call
  const cancelPatterns = /^(scratch that|stop|cancel|never\s?mind|forget it|nvm|nah|abort)\s*[.!]?$/i;
  if (cancelPatterns.test(newMessage.trim())) {
    logger.debug({ newMessage }, 'Fast-path cancel detected');
    return { type: 'cancel', confidence: 0.99, shouldAsk: false };
  }

  const userMessage = `Current task: ${currentTaskDescription}\n\nNew message from user: ${newMessage}`;

  try {
    const response = await classifierFn(CLASSIFICATION_PROMPT, userMessage);

    // Parse the JSON response
    const parsed = JSON.parse(response);
    const type = parsed.type as InterruptType;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;

    // Validate the type
    if (!['additive', 'redirect', 'cancel', 'unrelated'].includes(type)) {
      logger.warn({ parsed }, 'Invalid interrupt classification — defaulting to ask');
      return { type: 'additive', confidence: 0, shouldAsk: true };
    }

    const shouldAsk = confidence < CONFIDENCE_THRESHOLD;

    logger.info(
      { type, confidence, shouldAsk, currentTask: currentTaskDescription.slice(0, 50) },
      'Interrupt classified',
    );

    return { type, confidence, shouldAsk };
  } catch (error) {
    // If classification fails, default to asking the user
    logger.error({ error, newMessage }, 'Interrupt classification failed — will ask user');
    return { type: 'additive', confidence: 0, shouldAsk: true };
  }
}

/**
 * Generate a clarification question when the classifier isn't confident.
 */
export function generateClarificationMessage(
  currentTaskDescription: string,
  newMessage: string,
): string {
  return `I'm currently working on: ${currentTaskDescription}\n\nYou said: "${newMessage}"\n\nShould I:\n• Add this to what I'm working on\n• Drop what I'm doing and do this instead\n• Cancel everything`;
}
