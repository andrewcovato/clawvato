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

/** Cumulative importance threshold to trigger reflection */
const REFLECTION_THRESHOLD = 50;

/** Key used to store last reflection timestamp in the DB */
const LAST_REFLECTION_KEY = '__last_reflection_at__';

const REFLECTION_PROMPT = `You are analyzing recent memories stored by a personal AI assistant. Identify 3-5 high-level insights, patterns, or conclusions from these memories.

Focus on:
- Recurring patterns (e.g., "owner consistently declines Friday afternoon meetings")
- Relationship dynamics (e.g., "owner collaborates closely with Sarah on marketing")
- Workflow opportunities (e.g., "owner often shares standup notes — could automate")
- Strategic themes (e.g., "Client X engagement is shifting from sales to marketing focus")
- Preference changes (e.g., "owner has started preferring shorter meetings")

For each insight, return a JSON array of objects with:
- content: The insight in 1-2 clear sentences with enough context to be useful months later
- importance: 1-10 (how critical is this insight for future decisions?)

Return ONLY a valid JSON array. No markdown, no explanation.`;

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

  if (cumulativeImportance < REFLECTION_THRESHOLD) {
    logger.debug(
      { cumulativeImportance, threshold: REFLECTION_THRESHOLD, memoriesSince: recentMemories.length },
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
    const response = await client.messages.create({
      model,
      max_tokens: 1000,
      system: REFLECTION_PROMPT,
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
 * Get the last reflection timestamp from the DB.
 */
function getLastReflectionTime(db: DatabaseSync): string {
  try {
    const row = db.prepare(
      `SELECT completed_at FROM consolidation_runs WHERE id = ? ORDER BY completed_at DESC LIMIT 1`
    ).get(LAST_REFLECTION_KEY) as { completed_at: string } | undefined;
    return row?.completed_at ?? '2000-01-01T00:00:00';
  } catch {
    return '2000-01-01T00:00:00';
  }
}

/**
 * Record the current time as the last reflection time.
 */
function setLastReflectionTime(db: DatabaseSync): void {
  const now = new Date().toISOString();
  try {
    db.prepare(`
      INSERT OR REPLACE INTO consolidation_runs (id, started_at, completed_at, reflections_generated)
      VALUES (?, ?, ?, 1)
    `).run(LAST_REFLECTION_KEY, now, now);
  } catch (error) {
    logger.debug({ error }, 'Failed to record reflection time — non-critical');
  }
}
