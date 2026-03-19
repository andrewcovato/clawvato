/**
 * Training Wheels Policy Engine — enforces trust levels on actions.
 *
 * Trust Levels:
 *   0: FULL SUPERVISION  — every action requires confirmation
 *   1: TRUSTED READS     — read-only actions auto-approved, writes need confirmation
 *   2: TRUSTED ROUTINE   — graduated patterns auto-approved, novel actions confirmed
 *   3: FULL AUTONOMY     — most actions auto-approved, destructive still confirmed
 *
 * The policy engine takes a proposed action and returns whether it needs
 * confirmation or can be auto-approved based on the current trust level
 * and the action's graduation status.
 */

import { logger } from '../logger.js';
import { getConfig } from '../config.js';

export type ActionCategory = 'read' | 'write' | 'destructive' | 'outbound';

export interface PolicyDecision {
  /** Whether the action can proceed without confirmation */
  autoApproved: boolean;
  /** Reason for the decision */
  reason: string;
  /** If not auto-approved, what kind of confirmation is needed */
  confirmationType?: 'reaction' | 'block_kit';
}

/**
 * Actions that NEVER get auto-approved regardless of trust level.
 * These are the non-graduatable actions from the spec.
 */
const ALWAYS_CONFIRM: RegExp[] = [
  /delete/i,
  /remove/i,
  /destroy/i,
  /revoke/i,
  /send.*external/i,
  /share.*external/i,
  /permission.*change/i,
  /branch.*protect/i,
  /repo.*setting/i,
];

/**
 * Read-only action types (auto-approved at trust level 1+).
 */
const READ_ACTIONS: RegExp[] = [
  /(?:^|_)search/i,
  /(?:^|_)list/i,
  /(?:^|_)get/i,
  /(?:^|_)read/i,
  /(?:^|_)find/i,
  /(?:^|_)check/i,
  /(?:^|_)lookup/i,
  /(?:^|_)fetch/i,
  /(?:^|_)query/i,
  /(?:^|_)view/i,
  /(?:^|_)sync/i,
  /(?:^|_)scan/i,
  // Internal agent state — not external writes, safe to auto-approve
  /^update_working_context$/i,
  /^store_fact$/i,
  /^mcp__memory__/i,
];

/**
 * Categorize an action based on its type/tool name.
 */
export function categorizeAction(actionType: string): ActionCategory {
  // Check destructive first (highest priority)
  if (ALWAYS_CONFIRM.some(p => p.test(actionType))) {
    return 'destructive';
  }

  // Check read-only
  if (READ_ACTIONS.some(p => p.test(actionType))) {
    return 'read';
  }

  // Check outbound (messages, emails)
  if (/send|post|reply|forward|email|message|slack/i.test(actionType)) {
    return 'outbound';
  }

  // Default to write
  return 'write';
}

/**
 * Evaluate whether an action should be auto-approved or needs confirmation.
 *
 * @param actionType - The action type or tool name (e.g., "search_messages", "send_email")
 * @param isGraduated - Whether this specific action pattern has graduated (from action_patterns table)
 * @param trustLevel - Override trust level (defaults to config value)
 */
export function evaluatePolicy(
  actionType: string,
  isGraduated: boolean = false,
  trustLevel?: number,
): PolicyDecision {
  const level = trustLevel ?? getConfig().trustLevel;
  const category = categorizeAction(actionType);

  // ── Destructive actions ALWAYS need confirmation ──
  if (category === 'destructive') {
    logger.debug({ actionType, category }, 'Policy: destructive — always confirm');
    return {
      autoApproved: false,
      reason: 'Destructive actions always require confirmation',
      confirmationType: 'block_kit',
    };
  }

  // ── Level 0: Everything needs confirmation ──
  if (level === 0) {
    return {
      autoApproved: false,
      reason: 'Trust level 0: all actions require confirmation',
      confirmationType: 'reaction',
    };
  }

  // ── Level 1: Reads are auto-approved ──
  if (level >= 1 && category === 'read') {
    return {
      autoApproved: true,
      reason: 'Trust level 1+: read actions auto-approved',
    };
  }

  // ── Level 2: Graduated patterns are auto-approved ──
  if (level >= 2 && isGraduated) {
    return {
      autoApproved: true,
      reason: 'Trust level 2+: graduated pattern auto-approved',
    };
  }

  // ── Level 3: Most actions auto-approved ──
  // Destructive is already handled above, so all remaining categories are safe here
  if (level >= 3) {
    return {
      autoApproved: true,
      reason: 'Trust level 3: non-destructive action auto-approved',
    };
  }

  // ── Default: needs confirmation ──
  return {
    autoApproved: false,
    reason: `Trust level ${level}: ${category} action requires confirmation`,
    confirmationType: category === 'outbound' ? 'block_kit' : 'reaction',
  };
}
