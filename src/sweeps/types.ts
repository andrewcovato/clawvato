/**
 * Sweep Types — generic collector interface for incremental data ingestion.
 *
 * Any data source (Slack, Gmail, Fireflies, GitHub, QuickBooks, etc.)
 * implements the Collector interface. The sweep executor runs all registered
 * collectors, aggregates their output, and pipes it through Opus synthesis.
 *
 * High-water marks are stored in agent_state with `sweep:` prefix keys.
 */

import type { Sql } from '../db/index.js';

/** Result of a single collector run */
export interface CollectorResult {
  /** Source identifier (e.g., "slack", "gmail", "fireflies") */
  source: string;
  /** Total items scanned (messages, threads, meetings) */
  itemsScanned: number;
  /** New items since last sweep */
  itemsNew: number;
  /** Raw markdown content chunks for synthesis */
  contentChunks: string[];
}

/** Generic collector interface — implement for each data source */
export interface Collector {
  /** Human-readable name (e.g., "slack", "gmail", "fireflies") */
  name: string;
  /** Run incremental collection since last high-water mark */
  collect(): Promise<CollectorResult>;
}

/** Result of a full sweep (all collectors + synthesis) */
export interface SweepResult {
  /** Number of sources that were swept */
  sourcesSwept: number;
  /** Total new items collected across all sources */
  itemsCollected: number;
  /** Facts stored to memory after synthesis */
  factsStored: number;
  /** Duration in milliseconds */
  durationMs: number;
  /** Workspace directory for post-synthesis processing (internal use) */
  workspaceDir?: string;
}

// ── High-water mark helpers ──

/**
 * Read a high-water mark from agent_state.
 * Returns null if no mark exists (first sweep).
 */
export async function getHighWaterMark(sql: Sql, key: string): Promise<string | null> {
  const fullKey = `sweep:${key}`;
  const [row] = await sql`
    SELECT value FROM agent_state WHERE key = ${fullKey} AND status = 'active'
  ` as unknown as Array<{ value: string }>;
  return row?.value ?? null;
}

/**
 * Write a high-water mark to agent_state.
 * Upserts — creates if new, updates if exists.
 */
export async function setHighWaterMark(sql: Sql, key: string, value: string): Promise<void> {
  const fullKey = `sweep:${key}`;
  await sql`
    INSERT INTO agent_state (key, value, status, updated_at)
    VALUES (${fullKey}, ${value}, 'active', NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
}
