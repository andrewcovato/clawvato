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
export async function logAction(entry: AuditEntry): Promise<string> {
  const sql = getDb();
  const id = generateId();

  await sql`
    INSERT INTO actions (id, type, status, trust_level, request_source, request_context,
                         planned_action, actual_result, confirmed_by_user, error_message)
    VALUES (${id}, ${entry.type}, ${entry.status}, ${entry.trustLevel},
            ${entry.requestSource}, ${entry.requestContext ?? null},
            ${entry.plannedAction}, ${entry.actualResult ?? null},
            ${entry.confirmedByUser ? 1 : 0}, ${entry.errorMessage ?? null})
  `;

  logger.debug({ actionId: id, type: entry.type, status: entry.status }, 'Action logged');
  return id;
}

/**
 * Update an existing action's status and result.
 */
export async function updateAction(
  id: string,
  updates: { status?: string; actualResult?: string; errorMessage?: string; confirmedByUser?: boolean },
): Promise<void> {
  const sql = getDb();

  if (updates.status) {
    await sql`UPDATE actions SET status = ${updates.status} WHERE id = ${id}`;
    if (updates.status === 'confirmed') {
      await sql`UPDATE actions SET confirmed_at = NOW() WHERE id = ${id}`;
    }
    if (updates.status === 'completed' || updates.status === 'failed') {
      await sql`UPDATE actions SET completed_at = NOW() WHERE id = ${id}`;
    }
  }
  if (updates.actualResult !== undefined) {
    await sql`UPDATE actions SET actual_result = ${updates.actualResult} WHERE id = ${id}`;
  }
  if (updates.errorMessage !== undefined) {
    await sql`UPDATE actions SET error_message = ${updates.errorMessage} WHERE id = ${id}`;
  }
  if (updates.confirmedByUser !== undefined) {
    await sql`UPDATE actions SET confirmed_by_user = ${updates.confirmedByUser ? 1 : 0} WHERE id = ${id}`;
  }
}

/**
 * Get recent actions for the audit log display.
 */
export async function getRecentActions(limit: number = 20, type?: string): Promise<AuditEntry[]> {
  const sql = getDb();

  if (type) {
    return await sql`
      SELECT * FROM actions WHERE type = ${type} ORDER BY created_at DESC LIMIT ${limit}
    ` as unknown as AuditEntry[];
  }

  return await sql`
    SELECT * FROM actions ORDER BY created_at DESC LIMIT ${limit}
  ` as unknown as AuditEntry[];
}
