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

import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { generateId } from '../db/index.js';
import { contentSimilarity } from './extractor.js';
import { deleteEmbedding, insertMemory } from './store.js';

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
export function shouldConsolidate(db: DatabaseSync): boolean {
  try {
    const row = db.prepare(`
      SELECT completed_at FROM consolidation_runs
      ORDER BY completed_at DESC LIMIT 1
    `).get() as { completed_at: string } | undefined;

    if (!row) return true; // Never run before

    const lastRun = new Date(row.completed_at).getTime();
    const hoursSince = (Date.now() - lastRun) / (1000 * 60 * 60);
    return hoursSince >= getConfig().memory.consolidationIntervalHours;
  } catch {
    return true;
  }
}

/**
 * Run the full consolidation pipeline.
 */
export function consolidate(db: DatabaseSync): ConsolidationResult {
  const runId = generateId();
  const startedAt = new Date().toISOString();

  logger.info('Starting memory consolidation');

  let merged = 0;
  let decayed = 0;
  let archived = 0;

  // ── 1. Merge near-duplicates ──
  merged = mergeDuplicates(db);

  // ── 2. Decay stale memories ──
  decayed = decayStaleMemories(db);

  // ── 3. Archive very low importance ──
  archived = archiveMemories(db);

  // ── 4. Working context cleanup ──
  archiveStaleWorkingContext(db);

  const memoriesProcessed = merged + decayed + archived;

  // Record the run
  try {
    db.prepare(`
      INSERT INTO consolidation_runs (id, started_at, completed_at, memories_processed, memories_merged, memories_archived)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(runId, startedAt, new Date().toISOString(), memoriesProcessed, merged, archived);
  } catch (error) {
    logger.debug({ error }, 'Failed to record consolidation run — non-critical');
  }

  logger.info({ merged, decayed, archived, memoriesProcessed }, 'Memory consolidation complete');
  return { memoriesProcessed, merged, decayed, archived };
}

/**
 * Find and merge near-duplicate memories.
 * Keeps the higher-importance/higher-confidence version.
 */
function mergeDuplicates(db: DatabaseSync): number {
  let merged = 0;

  // Get all valid memories grouped by type
  const types = ['fact', 'preference', 'decision', 'strategy', 'conclusion', 'commitment', 'observation'];

  for (const type of types) {
    const memories = db.prepare(
      'SELECT id, content, importance, confidence, created_at FROM memories WHERE type = ? AND valid_until IS NULL ORDER BY importance DESC'
    ).all(type) as unknown as Array<{ id: string; content: string; importance: number; confidence: number; created_at: string }>;

    // Compare pairs — O(n²) but n is small per type
    const superseded = new Set<string>();

    for (let i = 0; i < memories.length; i++) {
      if (superseded.has(memories[i].id)) continue;

      for (let j = i + 1; j < memories.length; j++) {
        if (superseded.has(memories[j].id)) continue;

        const similarity = contentSimilarity(memories[i].content, memories[j].content);
        if (similarity >= getConfig().memory.mergeSimilarityThreshold) {
          // Keep i (higher importance due to ORDER BY), supersede j
          db.prepare(`
            UPDATE memories SET valid_until = datetime('now'), superseded_by = ?
            WHERE id = ?
          `).run(memories[i].id, memories[j].id);
          deleteEmbedding(db, memories[j].id);
          superseded.add(memories[j].id);
          merged++;

          logger.debug(
            { kept: memories[i].id, superseded: memories[j].id, similarity: similarity.toFixed(2), type },
            'Merged duplicate memory',
          );
        }
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
function decayStaleMemories(db: DatabaseSync): number {
  const now = Date.now();

  // 90-day decay (stronger)
  const decay90 = db.prepare(`
    UPDATE memories
    SET importance = MAX(1, CAST(importance * 0.7 AS INTEGER))
    WHERE valid_until IS NULL
      AND type NOT IN ('preference', 'commitment')
      AND (last_accessed_at IS NOT NULL AND julianday('now') - julianday(last_accessed_at) > ?)
      AND importance > 1
  `).run(getConfig().memory.decayThresholdDays90);

  // 30-day decay (lighter)
  const decay30 = db.prepare(`
    UPDATE memories
    SET importance = MAX(1, CAST(importance * 0.9 AS INTEGER))
    WHERE valid_until IS NULL
      AND type NOT IN ('preference', 'commitment')
      AND (last_accessed_at IS NOT NULL AND julianday('now') - julianday(last_accessed_at) > ?)
      AND (last_accessed_at IS NULL OR julianday('now') - julianday(last_accessed_at) <= ?)
      AND importance > 1
  `).run(getConfig().memory.decayThresholdDays30, getConfig().memory.decayThresholdDays90);

  const total = Number(decay90.changes ?? 0) + Number(decay30.changes ?? 0);

  if (total > 0) {
    logger.info({ decayed: total }, 'Decayed stale memories');
  }

  return total;
}

/**
 * Archive memories with importance at or below the threshold.
 * Sets valid_until to now (removes from active retrieval) but keeps in DB for audit.
 */
function archiveMemories(db: DatabaseSync): number {
  const result = db.prepare(`
    UPDATE memories
    SET valid_until = datetime('now')
    WHERE valid_until IS NULL
      AND importance <= ?
      AND type NOT IN ('preference', 'commitment', 'reflection')
  `).run(getConfig().memory.archiveThreshold);

  const count = Number(result.changes ?? 0);

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
function archiveStaleWorkingContext(db: DatabaseSync): void {
  try {
    const staleEntries = db.prepare(`
      SELECT key, value, updated_at FROM agent_state
      WHERE key LIKE 'wctx:%'
        AND status = 'active'
        AND julianday('now') - julianday(updated_at) > ?
    `).all(getConfig().memory.workingContextArchiveDays) as unknown as Array<{ key: string; value: string; updated_at: string }>;

    for (const entry of staleEntries) {
      // Extract a summary to LTM as a pointer
      insertMemory(db, {
        type: 'fact',
        content: `[Past working context] ${entry.value}`,
        source: `working_context:${entry.key}`,
        importance: 4,
        confidence: 0.7,
      });

      // Sleep — don't delete. Can be woken by retriever if query matches.
      db.prepare("UPDATE agent_state SET status = 'sleeping' WHERE key = ?").run(entry.key);
    }

    if (staleEntries.length > 0) {
      logger.info({ slept: staleEntries.length }, 'Working context entries put to sleep → summaries promoted to LTM');
    }
  } catch {
    // agent_state may not exist — non-critical
  }
}
