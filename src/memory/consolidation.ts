/**
 * Memory Consolidation — prevents unbounded growth.
 *
 * Runs periodically (on startup if >24h since last run) and performs:
 * 1. Merge near-duplicate memories
 * 2. Decay stale memories (not accessed in 30/90 days)
 * 3. Archive very low importance memories
 *
 * Target: memory count grows logarithmically, not linearly.
 * Without consolidation: 50K facts after 12 months.
 * With consolidation: ~3K facts at steady state.
 *
 * Cost: ~$0.01 per run (mostly DB operations, no LLM calls for basic consolidation).
 */

import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { generateId } from '../db/index.js';
import { contentSimilarity } from './extractor.js';
import { deleteEmbedding, insertMemory, findDuplicates, type Memory } from './store.js';

// Memory consolidation tunables loaded from config (memory.*)

export interface ConsolidationResult {
  memoriesProcessed: number;
  merged: number;
  decayed: number;
  archived: number;
}

/**
 * Check if consolidation should run (>24h since last run).
 */
export async function shouldConsolidate(sql: Sql): Promise<boolean> {
  try {
    const [row] = await sql`
      SELECT completed_at FROM consolidation_runs
      ORDER BY completed_at DESC LIMIT 1
    `;

    if (!row) return true; // Never run before

    const lastRun = new Date(row.completed_at as string).getTime();
    const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
    return hoursSince >= getConfig().memory.consolidationIntervalHours;
  } catch {
    return true;
  }
}

/**
 * Run the full consolidation pipeline.
 */
export async function consolidate(sql: Sql): Promise<ConsolidationResult> {
  const runId = generateId();
  const startedAt = new Date().toISOString();

  logger.info('Starting memory consolidation');

  let merged = 0;
  let decayed = 0;
  let archived = 0;

  // ── 1. Merge near-duplicates ──
  merged = await mergeDuplicates(sql);

  // ── 2. Decay stale memories ──
  decayed = await decayStaleMemories(sql);

  // ── 3. Archive very low importance ──
  archived = await archiveMemories(sql);

  // ── 4. Working context cleanup ──
  await archiveStaleWorkingContext(sql);

  // ── 5. Category reorganization (weekly cadence) ──
  await reorganizeCategories(sql);

  // Note: Railway Postgres handles backups automatically — no Drive backup needed

  const memoriesProcessed = merged + decayed + archived;

  // Record the run
  try {
    await sql`
      INSERT INTO consolidation_runs (id, started_at, completed_at, memories_processed, memories_merged, memories_archived)
      VALUES (${runId}, ${startedAt}, ${new Date().toISOString()}, ${memoriesProcessed}, ${merged}, ${archived})
    `;
  } catch (error) {
    logger.debug({ error }, 'Failed to record consolidation run — non-critical');
  }

  logger.info({ merged, decayed, archived, memoriesProcessed }, 'Memory consolidation complete');
  return { memoriesProcessed, merged, decayed, archived };
}

/**
 * Find and merge near-duplicate memories using tsvector-based candidate finding.
 * O(n × 5) instead of O(n²) — for each memory, find top 5 candidates and compare only those.
 */
async function mergeDuplicates(sql: Sql): Promise<number> {
  let merged = 0;
  const superseded = new Set<string>();
  const config = getConfig();

  // Get all valid memories ordered by importance (keep highest)
  const memories = await sql`
    SELECT id, type, content, importance, confidence FROM memories
    WHERE valid_until IS NULL ORDER BY importance DESC
  ` as unknown as Array<{ id: string; type: string; content: string; importance: number; confidence: number }>;

  for (const mem of memories) {
    if (superseded.has(mem.id)) continue;

    // Use tsvector to find candidate duplicates (already exists, returns top 5)
    const candidates = await findDuplicates(sql, mem.content, mem.type);

    for (const candidate of candidates) {
      if (candidate.id === mem.id || superseded.has(candidate.id)) continue;

      const similarity = contentSimilarity(mem.content, candidate.content);
      if (similarity >= config.memory.mergeSimilarityThreshold) {
        // mem has higher importance (ORDER BY DESC), supersede candidate
        await sql`
          UPDATE memories SET valid_until = NOW(), superseded_by = ${mem.id}
          WHERE id = ${candidate.id}
        `;
        await deleteEmbedding(sql, candidate.id);
        superseded.add(candidate.id);
        merged++;

        logger.debug(
          { kept: mem.id, superseded: candidate.id, similarity: similarity.toFixed(2), type: mem.type },
          'Merged duplicate memory',
        );
      }
    }
  }

  return merged;
}

/**
 * Decay importance of memories not accessed recently.
 * - Not accessed in 30 days: importance *= 0.9
 * - Not accessed in 90 days: importance *= 0.7
 */
async function decayStaleMemories(sql: Sql): Promise<number> {
  const config = getConfig();
  const decayExempt = config.memory.decayExemptCategories;

  // 90-day decay (stronger)
  const decay90 = await sql`
    UPDATE memories
    SET importance = GREATEST(1, CAST(importance * 0.7 AS INTEGER))
    WHERE valid_until IS NULL
      AND type != ALL(${decayExempt})
      AND last_accessed_at IS NOT NULL
      AND (NOW() - last_accessed_at) > ${config.memory.decayThresholdDays90 + ' days'}::interval
      AND importance > 1
  `;

  // 30-day decay (lighter)
  const decay30 = await sql`
    UPDATE memories
    SET importance = GREATEST(1, CAST(importance * 0.9 AS INTEGER))
    WHERE valid_until IS NULL
      AND type != ALL(${decayExempt})
      AND last_accessed_at IS NOT NULL
      AND (NOW() - last_accessed_at) > ${config.memory.decayThresholdDays30 + ' days'}::interval
      AND (NOW() - last_accessed_at) <= ${config.memory.decayThresholdDays90 + ' days'}::interval
      AND importance > 1
  `;

  const total = (decay90.count ?? 0) + (decay30.count ?? 0);

  if (total > 0) {
    logger.info({ decayed: total }, 'Decayed stale memories');
  }

  return Number(total);
}

/**
 * Archive memories with importance at or below the threshold.
 * Sets valid_until to now (removes from active retrieval) but keeps in DB for audit.
 */
async function archiveMemories(sql: Sql): Promise<number> {
  const config = getConfig();
  const exemptCategories = config.memory.archiveExemptCategories;

  const result = await sql`
    UPDATE memories
    SET valid_until = NOW()
    WHERE valid_until IS NULL
      AND importance <= ${config.memory.archiveThreshold}
      AND type != ALL(${exemptCategories})
  `;

  const count = Number(result.count ?? 0);

  if (count > 0) {
    logger.info({ archived: count }, 'Archived low-importance memories');
  }

  return count;
}

/**
 * Sleep stale working context entries.
 * - Active + not updated in 14 days → set to 'sleeping' + extract summary to LTM
 * - Sleeping entries persist indefinitely — woken by retriever when query matches
 * - No hard deletion: sleeping context is searchable and can always come back
 */
async function archiveStaleWorkingContext(sql: Sql): Promise<void> {
  try {
    const staleEntries = await sql`
      SELECT key, value, updated_at FROM agent_state
      WHERE key LIKE 'wctx:%'
        AND status = 'active'
        AND (NOW() - updated_at) > ${getConfig().memory.workingContextArchiveDays + ' days'}::interval
    ` as unknown as Array<{ key: string; value: string; updated_at: string }>;

    for (const entry of staleEntries) {
      // Extract a summary to LTM as a pointer
      await insertMemory(sql, {
        type: 'fact',
        content: `[Past working context] ${entry.value}`,
        source: `working_context:${entry.key}`,
        importance: 4,
        confidence: 0.7,
      });

      // Sleep — don't delete. Can be woken by retriever if query matches.
      await sql`UPDATE agent_state SET status = 'sleeping' WHERE key = ${entry.key}`;
    }

    if (staleEntries.length > 0) {
      logger.info({ slept: staleEntries.length }, 'Working context entries put to sleep → summaries promoted to LTM');
    }
  } catch {
    // agent_state may not exist — non-critical
  }
}

/**
 * Reorganize memory categories — recalculate counts and prune empty discovered categories.
 * Runs as part of consolidation but at a weekly cadence (guarded by agent_state).
 * No merge needed — duplicates are prevented at insert time by findOrCreateCategory.
 */
async function reorganizeCategories(sql: Sql): Promise<void> {
  try {
    const config = getConfig();
    const guardKey = 'last_category_reorg';
    const [lastReorg] = await sql`SELECT value FROM agent_state WHERE key = ${guardKey}`;

    if (lastReorg) {
      const hoursSince = (Date.now() - new Date(lastReorg.value as string).getTime()) / (1000 * 60 * 60);
      if (hoursSince < config.memory.categoryReorgIntervalHours) return;
    }

    // Recalculate counts
    await sql`
      UPDATE memory_categories SET count = (
        SELECT COUNT(*) FROM memories WHERE type = memory_categories.name AND valid_until IS NULL
      )
    `;

    // Remove discovered categories with zero memories
    const removed = await sql`
      DELETE FROM memory_categories WHERE source = 'discovered' AND count = 0
    `;

    if (Number(removed.count ?? 0) > 0) {
      logger.info({ removed: removed.count }, 'Pruned empty discovered categories');
    }

    // Update guard
    await sql`
      INSERT INTO agent_state (key, value, status, updated_at)
      VALUES (${guardKey}, ${new Date().toISOString()}, 'active', NOW())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `;
  } catch (error) {
    logger.debug({ error }, 'Category reorganization failed — non-critical');
  }
}
