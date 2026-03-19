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
import { getPrompts } from '../prompts.js';
import { getConfig } from '../config.js';

export type InterruptType = 'additive' | 'redirect' | 'cancel' | 'unrelated';

export interface InterruptClassification {
  type: InterruptType;
  confidence: number;
  /** If confidence is below threshold, suggest asking the user */
  shouldAsk: boolean;
}

// Confidence threshold read from config.slack.interruptConfidenceThreshold

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
    const response = await classifierFn(getPrompts().interruptClassification, userMessage);

    // Parse the JSON response
    const parsed = JSON.parse(response);
    const type = parsed.type as InterruptType;
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0.5;

    // Validate the type
    if (!['additive', 'redirect', 'cancel', 'unrelated'].includes(type)) {
      logger.warn({ parsed }, 'Invalid interrupt classification — defaulting to ask');
      return { type: 'additive', confidence: 0, shouldAsk: true };
    }

    const shouldAsk = confidence < getConfig().slack.interruptConfidenceThreshold;

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
