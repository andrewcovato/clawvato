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
import { getConfig } from '../config.js';
import type { Sql } from '../db/index.js';

/**
 * PatternRecord uses snake_case to match Postgres column names directly.
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
  non_graduatable: number; // Postgres stores booleans as 0/1 in this schema
}

/**
 * Compute a stable hash for an action pattern.
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
export async function recordOccurrence(
  sql: Sql,
  actionType: string,
  description: string,
  keyParams: Record<string, string>,
  outcome: 'approved' | 'rejected' | 'modified',
  nonGraduatable: boolean = false,
): Promise<{ graduated: boolean; pattern: PatternRecord }> {
  const hash = computePatternHash(actionType, keyParams);
  const now = new Date().toISOString();

  // Upsert the pattern
  const [existing] = await sql`
    SELECT * FROM action_patterns WHERE pattern_hash = ${hash}
  ` as unknown as [PatternRecord | undefined];

  if (!existing) {
    const id = createHash('sha256').update(`${hash}-${now}`).digest('hex').slice(0, 16);
    await sql`
      INSERT INTO action_patterns (id, pattern_hash, action_type, description,
        total_occurrences, total_approvals, total_rejections, total_modifications,
        current_trust_level, last_occurred_at, non_graduatable)
      VALUES (${id}, ${hash}, ${actionType}, ${description},
        1, ${outcome === 'approved' ? 1 : 0}, ${outcome === 'rejected' ? 1 : 0},
        ${outcome === 'modified' ? 1 : 0}, 0, ${now}, ${nonGraduatable ? 1 : 0})
    `;

    const [pattern] = await sql`
      SELECT * FROM action_patterns WHERE id = ${id}
    ` as unknown as [PatternRecord];

    return { graduated: false, pattern };
  }

  // Update existing pattern
  const approvals = existing.total_approvals + (outcome === 'approved' ? 1 : 0);
  const rejections = existing.total_rejections + (outcome === 'rejected' ? 1 : 0);
  const modifications = existing.total_modifications + (outcome === 'modified' ? 1 : 0);
  const occurrences = existing.total_occurrences + 1;

  await sql`
    UPDATE action_patterns SET
      total_occurrences = ${occurrences},
      total_approvals = ${approvals},
      total_rejections = ${rejections},
      total_modifications = ${modifications},
      last_occurred_at = ${now}
    WHERE pattern_hash = ${hash}
  `;

  // Check graduation eligibility
  const shouldGraduate = checkGraduation(
    occurrences, approvals, rejections, nonGraduatable || !!existing.non_graduatable,
    existing.graduated_at,
  );

  if (shouldGraduate && !existing.graduated_at) {
    await sql`
      UPDATE action_patterns SET graduated_at = ${now}, current_trust_level = current_trust_level + 1
      WHERE pattern_hash = ${hash}
    `;

    logger.info(
      { actionType, hash, approvals, occurrences },
      'Pattern graduated!',
    );
  }

  const [updatedPattern] = await sql`
    SELECT * FROM action_patterns WHERE pattern_hash = ${hash}
  ` as unknown as [PatternRecord];

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
  if (nonGraduatable) return false;
  if (alreadyGraduated) return false;

  const twConfig = getConfig().trainingWheels;
  if (totalApprovals < twConfig.graduationThreshold) return false;

  if (totalOccurrences > 0) {
    const rejectionRate = totalRejections / totalOccurrences;
    if (rejectionRate >= twConfig.maxRejectionRate) return false;
  }

  return true;
}

/**
 * Check if a specific action pattern has graduated.
 */
export async function isGraduated(sql: Sql, actionType: string, keyParams: Record<string, string> = {}): Promise<boolean> {
  const hash = computePatternHash(actionType, keyParams);
  const [row] = await sql`
    SELECT graduated_at FROM action_patterns WHERE pattern_hash = ${hash}
  `;

  return !!(row?.graduated_at);
}

/**
 * Get all graduated patterns (for the status command).
 */
export async function getGraduatedPatterns(sql: Sql): Promise<PatternRecord[]> {
  return await sql`
    SELECT * FROM action_patterns WHERE graduated_at IS NOT NULL ORDER BY graduated_at DESC
  ` as unknown as PatternRecord[];
}
