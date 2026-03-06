/**
 * Graduation Engine — tracks action patterns and graduates them through trust levels.
 *
 * When the agent takes an action that gets approved by the user, the pattern is
 * recorded. After enough approvals with a low rejection rate, the pattern
 * "graduates" — meaning it can be auto-approved at the appropriate trust level.
 *
 * Graduation criteria:
 *   - 10+ total approvals
 *   - <5% rejection rate (rejections / total_occurrences)
 *   - 0 rejections in the last 5 occurrences
 *   - Action type is in the graduatable list (not in ALWAYS_CONFIRM)
 *
 * Pattern hashing:
 *   A pattern hash is computed from the action type + key parameters.
 *   For example, "send_email to:internal" and "send_email to:external"
 *   are different patterns, but "search_messages channel:general" and
 *   "search_messages channel:random" are the same pattern (channel varies).
 */

import { createHash } from 'node:crypto';
import { logger } from '../logger.js';
import type { DatabaseSync } from 'node:sqlite';

/**
 * PatternRecord uses snake_case to match SQLite column names directly.
 * node:sqlite's .get()/.all() return raw column names from the DB.
 */
export interface PatternRecord {
  id: string;
  pattern_hash: string;
  action_type: string;
  description: string;
  total_occurrences: number;
  total_approvals: number;
  total_rejections: number;
  total_modifications: number;
  current_trust_level: number;
  last_occurred_at: string | null;
  graduated_at: string | null;
  non_graduatable: number; // SQLite stores booleans as 0/1
}

const GRADUATION_THRESHOLD = 10;
const MAX_REJECTION_RATE = 0.05;
const RECENT_WINDOW = 5;

/**
 * Compute a stable hash for an action pattern.
 * The hash captures the action type and key structural parameters,
 * but not variable data like specific channel names or search queries.
 *
 * @param actionType - The action type (e.g., "send_email", "search_messages")
 * @param keyParams - Structural parameters that define the pattern
 */
export function computePatternHash(actionType: string, keyParams: Record<string, string> = {}): string {
  const normalized = [
    actionType.toLowerCase(),
    ...Object.entries(keyParams)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`),
  ].join('|');

  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Record an occurrence of an action pattern and check graduation eligibility.
 */
export function recordOccurrence(
  db: DatabaseSync,
  actionType: string,
  description: string,
  keyParams: Record<string, string>,
  outcome: 'approved' | 'rejected' | 'modified',
  nonGraduatable: boolean = false,
): { graduated: boolean; pattern: PatternRecord } {
  const hash = computePatternHash(actionType, keyParams);
  const now = new Date().toISOString();

  // Upsert the pattern
  const existing = db.prepare(
    'SELECT * FROM action_patterns WHERE pattern_hash = ?'
  ).get(hash) as unknown as PatternRecord | undefined;

  if (!existing) {
    const id = createHash('sha256').update(`${hash}-${now}`).digest('hex').slice(0, 16);
    db.prepare(`
      INSERT INTO action_patterns (id, pattern_hash, action_type, description,
        total_occurrences, total_approvals, total_rejections, total_modifications,
        current_trust_level, last_occurred_at, non_graduatable)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?)
    `).run(
      id, hash, actionType, description,
      outcome === 'approved' ? 1 : 0,
      outcome === 'rejected' ? 1 : 0,
      outcome === 'modified' ? 1 : 0,
      now,
      nonGraduatable ? 1 : 0,
    );

    const pattern = db.prepare(
      'SELECT * FROM action_patterns WHERE id = ?'
    ).get(id) as unknown as PatternRecord;

    return { graduated: false, pattern };
  }

  // Update existing pattern
  const approvals = existing.total_approvals + (outcome === 'approved' ? 1 : 0);
  const rejections = existing.total_rejections + (outcome === 'rejected' ? 1 : 0);
  const modifications = existing.total_modifications + (outcome === 'modified' ? 1 : 0);
  const occurrences = existing.total_occurrences + 1;

  db.prepare(`
    UPDATE action_patterns SET
      total_occurrences = ?,
      total_approvals = ?,
      total_rejections = ?,
      total_modifications = ?,
      last_occurred_at = ?
    WHERE pattern_hash = ?
  `).run(occurrences, approvals, rejections, modifications, now, hash);

  // Check graduation eligibility
  const shouldGraduate = checkGraduation(
    occurrences, approvals, rejections, nonGraduatable || !!existing.non_graduatable,
    existing.graduated_at,
  );

  if (shouldGraduate && !existing.graduated_at) {
    db.prepare(`
      UPDATE action_patterns SET graduated_at = ?, current_trust_level = current_trust_level + 1
      WHERE pattern_hash = ?
    `).run(now, hash);

    logger.info(
      { actionType, hash, approvals, occurrences },
      'Pattern graduated!',
    );
  }

  const updatedPattern = db.prepare(
    'SELECT * FROM action_patterns WHERE pattern_hash = ?'
  ).get(hash) as unknown as PatternRecord;

  return { graduated: shouldGraduate, pattern: updatedPattern };
}

/**
 * Check if a pattern meets graduation criteria.
 */
function checkGraduation(
  totalOccurrences: number,
  totalApprovals: number,
  totalRejections: number,
  nonGraduatable: boolean,
  alreadyGraduated: string | null,
): boolean {
  // Non-graduatable actions never graduate
  if (nonGraduatable) return false;

  // Already graduated
  if (alreadyGraduated) return false;

  // Must have enough approvals
  if (totalApprovals < GRADUATION_THRESHOLD) return false;

  // Rejection rate must be below threshold
  if (totalOccurrences > 0) {
    const rejectionRate = totalRejections / totalOccurrences;
    if (rejectionRate >= MAX_REJECTION_RATE) return false;
  }

  // Note: "zero rejections in last 5" requires tracking per-occurrence history.
  // For now, we use the overall rejection rate as a proxy.
  // TODO: Add occurrence history table for precise recent-window tracking.

  return true;
}

/**
 * Check if a specific action pattern has graduated.
 */
export function isGraduated(db: DatabaseSync, actionType: string, keyParams: Record<string, string> = {}): boolean {
  const hash = computePatternHash(actionType, keyParams);
  const row = db.prepare(
    'SELECT graduated_at FROM action_patterns WHERE pattern_hash = ?'
  ).get(hash) as unknown as { graduated_at: string | null } | undefined;

  return !!row?.graduated_at;
}

/**
 * Get all graduated patterns (for the status command).
 */
export function getGraduatedPatterns(db: DatabaseSync): PatternRecord[] {
  return db.prepare(
    'SELECT * FROM action_patterns WHERE graduated_at IS NOT NULL ORDER BY graduated_at DESC'
  ).all() as unknown as PatternRecord[];
}
