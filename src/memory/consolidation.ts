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
import { deleteEmbedding, insertMemory, findDuplicates, type Memory } from './store.js';
import { backupToGoogleDrive } from './backup.js';

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

  // ── 5. Category reorganization (weekly cadence) ──
  reorganizeCategories(db);

  // ── 6. Backup to Google Drive (fire-and-forget) ──
  backupToGoogleDrive().catch(err => {
    logger.debug({ error: err }, 'Drive backup failed during consolidation — non-critical');
  });

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
 * Find and merge near-duplicate memories using FTS5-based candidate finding.
 * O(n × 5) instead of O(n²) — for each memory, find top 5 FTS5 candidates and compare only those.
 */
function mergeDuplicates(db: DatabaseSync): number {
  let merged = 0;
  const superseded = new Set<string>();
  const config = getConfig();

  // Get all valid memories ordered by importance (keep highest)
  const memories = db.prepare(
    'SELECT id, type, content, importance, confidence FROM memories WHERE valid_until IS NULL ORDER BY importance DESC'
  ).all() as unknown as Array<{ id: string; type: string; content: string; importance: number; confidence: number }>;

  for (const mem of memories) {
    if (superseded.has(mem.id)) continue;

    // Use FTS5 to find candidate duplicates (already exists, returns top 5)
    const candidates = findDuplicates(db, mem.content, mem.type);

    for (const candidate of candidates) {
      if (candidate.id === mem.id || superseded.has(candidate.id)) continue;

      const similarity = contentSimilarity(mem.content, candidate.content);
      if (similarity >= config.memory.mergeSimilarityThreshold) {
        // mem has higher importance (ORDER BY DESC), supersede candidate
        db.prepare(`
          UPDATE memories SET valid_until = datetime('now'), superseded_by = ?
          WHERE id = ?
        `).run(mem.id, candidate.id);
        deleteEmbedding(db, candidate.id);
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
function decayStaleMemories(db: DatabaseSync): number {
  const config = getConfig();
  const decayExempt = config.memory.decayExemptCategories;
  const exemptPlaceholders = decayExempt.map(() => '?').join(',');

  // 90-day decay (stronger)
  const decay90 = db.prepare(`
    UPDATE memories
    SET importance = MAX(1, CAST(importance * 0.7 AS INTEGER))
    WHERE valid_until IS NULL
      AND type NOT IN (${exemptPlaceholders})
      AND (last_accessed_at IS NOT NULL AND julianday('now') - julianday(last_accessed_at) > ?)
      AND importance > 1
  `).run(...decayExempt, config.memory.decayThresholdDays90);

  // 30-day decay (lighter)
  const decay30 = db.prepare(`
    UPDATE memories
    SET importance = MAX(1, CAST(importance * 0.9 AS INTEGER))
    WHERE valid_until IS NULL
      AND type NOT IN (${exemptPlaceholders})
      AND (last_accessed_at IS NOT NULL AND julianday('now') - julianday(last_accessed_at) > ?)
      AND (last_accessed_at IS NULL OR julianday('now') - julianday(last_accessed_at) <= ?)
      AND importance > 1
  `).run(...decayExempt, config.memory.decayThresholdDays30, config.memory.decayThresholdDays90);

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
  const config = getConfig();
  const exemptCategories = config.memory.archiveExemptCategories;
  const exemptPlaceholders = exemptCategories.map(() => '?').join(',');

  const result = db.prepare(`
    UPDATE memories
    SET valid_until = datetime('now')
    WHERE valid_until IS NULL
      AND importance <= ?
      AND type NOT IN (${exemptPlaceholders})
  `).run(config.memory.archiveThreshold, ...exemptCategories);

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

/**
 * Reorganize memory categories — recalculate counts and prune empty discovered categories.
 * Runs as part of consolidation but at a weekly cadence (guarded by agent_state).
 * No merge needed — duplicates are prevented at insert time by findOrCreateCategory.
 */
function reorganizeCategories(db: DatabaseSync): void {
  try {
    const config = getConfig();
    const guardKey = 'last_category_reorg';
    const lastReorg = db.prepare(
      "SELECT value FROM agent_state WHERE key = ?"
    ).get(guardKey) as { value: string } | undefined;

    if (lastReorg) {
      const hoursSince = (Date.now() - new Date(lastReorg.value).getTime()) / (1000 * 60 * 60);
      if (hoursSince < config.memory.categoryReorgIntervalHours) return;
    }

    // Recalculate counts
    db.exec(`
      UPDATE memory_categories SET count = (
        SELECT COUNT(*) FROM memories WHERE type = memory_categories.name AND valid_until IS NULL
      )
    `);

    // Remove discovered categories with zero memories
    const removed = db.prepare(
      "DELETE FROM memory_categories WHERE source = 'discovered' AND count = 0"
    ).run();

    if (Number(removed.changes ?? 0) > 0) {
      logger.info({ removed: removed.changes }, 'Pruned empty discovered categories');
    }

    // Update guard
    db.prepare(
      "INSERT OR REPLACE INTO agent_state (key, value, status, updated_at) VALUES (?, ?, 'active', datetime('now'))"
    ).run(guardKey, new Date().toISOString());
  } catch (error) {
    logger.debug({ error }, 'Category reorganization failed — non-critical');
  }
}
