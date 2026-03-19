/**
 * Reflection — synthesize higher-level insights from accumulated memories.
 *
 * Triggered when cumulative importance of recent memories exceeds a threshold.
 * Haiku analyzes recent memories and generates 3-5 high-level insights,
 * stored as type 'reflection'. This is inspired by the Generative Agents paper
 * (Park et al. 2023) — the agents that felt most "alive" were the ones that
 * reflected on their memories.
 *
 * Cost: ~$0.001 per reflection (Haiku). Triggered ~1-2x per day.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logger.js';
import { getRecentMemories, insertMemory, type Memory } from './store.js';
import { getPrompts } from '../prompts.js';
import { getConfig } from '../config.js';

/** Cumulative importance threshold to trigger reflection */
// Reflection threshold loaded from config (memory.reflectionThreshold)

/** Key used to store last reflection timestamp in agent_state */
const LAST_REFLECTION_KEY = 'last_reflection_at';

// Prompt loaded from config/prompts/reflection.md

/**
 * Check if reflection should be triggered, and if so, run it.
 * Call this after storing new memories.
 */
export async function maybeReflect(
  db: DatabaseSync,
  client: Anthropic,
  model: string,
): Promise<{ reflected: boolean; insightsGenerated: number }> {
  const lastReflectionAt = getLastReflectionTime(db);
  const recentMemories = getRecentMemories(db, lastReflectionAt, { limit: 100 });

  if (recentMemories.length === 0) {
    return { reflected: false, insightsGenerated: 0 };
  }

  const cumulativeImportance = recentMemories.reduce((sum, m) => sum + m.importance, 0);

  if (cumulativeImportance < getConfig().memory.reflectionThreshold) {
    logger.debug(
      { cumulativeImportance, threshold: getConfig().memory.reflectionThreshold, memoriesSince: recentMemories.length },
      'Reflection not triggered — below threshold',
    );
    return { reflected: false, insightsGenerated: 0 };
  }

  logger.info(
    { cumulativeImportance, memoriesSince: recentMemories.length },
    'Reflection triggered — generating insights',
  );

  const insightsGenerated = await runReflection(db, client, model, recentMemories);

  // Update last reflection time
  setLastReflectionTime(db);

  return { reflected: true, insightsGenerated };
}

/**
 * Run the reflection process — ask Haiku to synthesize insights.
 */
async function runReflection(
  db: DatabaseSync,
  client: Anthropic,
  model: string,
  recentMemories: Memory[],
): Promise<number> {
  const memoryList = recentMemories.map(m =>
    `- [${m.type}] ${m.content} (importance: ${m.importance})`
  ).join('\n');

  try {
    const config = getConfig();
    const response = await client.messages.create({
      model,
      max_tokens: config.memory.reflectionMaxTokens,
      system: getPrompts().reflection,
      messages: [{ role: 'user', content: `Recent memories:\n${memoryList}` }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
    const insights = JSON.parse(jsonStr);

    if (!Array.isArray(insights)) {
      logger.warn('Reflection returned non-array — skipping');
      return 0;
    }

    let stored = 0;
    for (const insight of insights) {
      if (!insight.content || typeof insight.content !== 'string') continue;

      insertMemory(db, {
        type: 'reflection',
        content: String(insight.content).slice(0, 500),
        source: `reflection:${new Date().toISOString()}`,
        importance: Math.max(1, Math.min(10, Math.round(Number(insight.importance) || 7))),
        confidence: 0.8,
      });
      stored++;
    }

    logger.info({ insightsGenerated: stored }, 'Reflection complete');
    return stored;
  } catch (error) {
    logger.error({ error }, 'Reflection failed');
    return 0;
  }
}

/**
 * Get the last reflection timestamp from the agent_state table.
 */
function getLastReflectionTime(db: DatabaseSync): string {
  try {
    const row = db.prepare(
      `SELECT value FROM agent_state WHERE key = ?`
    ).get(LAST_REFLECTION_KEY) as { value: string } | undefined;
    return row?.value ?? '2000-01-01T00:00:00';
  } catch {
    return '2000-01-01T00:00:00';
  }
}

/**
 * Record the current time as the last reflection time in agent_state.
 */
function setLastReflectionTime(db: DatabaseSync): void {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO agent_state (key, value, status, updated_at)
      VALUES (?, ?, 'active', ?)
    `).run(LAST_REFLECTION_KEY, now, now);
  } catch (error) {
    logger.debug({ error }, 'Failed to record reflection time — non-critical');
  }
}
