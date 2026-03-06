import { getDb, generateId } from '../db/index.js';
import { logger } from '../logger.js';

export interface AuditEntry {
  type: string;
  status: 'planned' | 'pending_confirmation' | 'confirmed' | 'executing' | 'completed' | 'failed' | 'rejected' | 'undone';
  trustLevel: number;
  requestSource: string;
  requestContext?: string;
  plannedAction: string;
  actualResult?: string;
  confirmedByUser?: boolean;
  errorMessage?: string;
}

/**
 * Log an action to the immutable audit trail.
 * Every tool call and outbound action is recorded here.
 */
export function logAction(entry: AuditEntry): string {
  const db = getDb();
  const id = generateId();

  db.prepare(`
    INSERT INTO actions (id, type, status, trust_level, request_source, request_context,
                         planned_action, actual_result, confirmed_by_user, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    entry.type,
    entry.status,
    entry.trustLevel,
    entry.requestSource,
    entry.requestContext ?? null,
    entry.plannedAction,
    entry.actualResult ?? null,
    entry.confirmedByUser ? 1 : 0,
    entry.errorMessage ?? null,
  );

  logger.debug({ actionId: id, type: entry.type, status: entry.status }, 'Action logged');
  return id;
}

/**
 * Update an existing action's status and result.
 */
export function updateAction(
  id: string,
  updates: { status?: string; actualResult?: string; errorMessage?: string; confirmedByUser?: boolean },
): void {
  const db = getDb();

  if (updates.status) {
    db.prepare("UPDATE actions SET status = ? WHERE id = ?").run(updates.status, id);
    if (updates.status === 'confirmed') {
      db.prepare("UPDATE actions SET confirmed_at = datetime('now') WHERE id = ?").run(id);
    }
    if (updates.status === 'completed' || updates.status === 'failed') {
      db.prepare("UPDATE actions SET completed_at = datetime('now') WHERE id = ?").run(id);
    }
  }
  if (updates.actualResult !== undefined) {
    db.prepare("UPDATE actions SET actual_result = ? WHERE id = ?").run(updates.actualResult, id);
  }
  if (updates.errorMessage !== undefined) {
    db.prepare("UPDATE actions SET error_message = ? WHERE id = ?").run(updates.errorMessage, id);
  }
  if (updates.confirmedByUser !== undefined) {
    db.prepare("UPDATE actions SET confirmed_by_user = ? WHERE id = ?").run(updates.confirmedByUser ? 1 : 0, id);
  }
}

/**
 * Get recent actions for the audit log display.
 */
export function getRecentActions(limit: number = 20, type?: string): AuditEntry[] {
  const db = getDb();

  if (type) {
    return db.prepare(
      'SELECT * FROM actions WHERE type = ? ORDER BY created_at DESC LIMIT ?',
    ).all(type, limit) as unknown as AuditEntry[];
  }

  return db.prepare(
    'SELECT * FROM actions ORDER BY created_at DESC LIMIT ?',
  ).all(limit) as unknown as AuditEntry[];
}
