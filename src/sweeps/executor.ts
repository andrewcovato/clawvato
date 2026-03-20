/**
 * Sweep Executor — orchestrates collectors → workspace → Opus synthesis → memory.
 *
 * Runs all registered collectors, aggregates their raw content chunks,
 * pipes everything through a single Opus CLI synthesis pass that
 * cross-references across sources, and stores the resulting facts.
 *
 * Triggered by the task scheduler as a recurring task.
 */

import { writeFileSync, readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { getPrompts } from '../prompts.js';

import { executeDeepPath } from '../agent/deep-path.js';
import { retrieveContext } from '../memory/retriever.js';
import { findTaskByTitle, createTask } from '../tasks/store.js';
import type { Collector, SweepResult } from './types.js';

// Re-export for convenience
export { type SweepResult } from './types.js';

export interface SweepDeps {
  sql: Sql;
  dataDir: string;
}

/**
 * Execute a full sweep: run all collectors, synthesize, store facts.
 */
export async function executeSweep(
  collectors: Collector[],
  deps: SweepDeps,
): Promise<SweepResult> {
  const startTime = Date.now();
  const config = getConfig();
  let itemsCollected = 0;
  let sourcesSwept = 0;

  // ── 1. Collect from all sources ──
  const allChunks: string[] = [];

  for (const collector of collectors) {
    try {
      logger.info({ collector: collector.name }, 'Sweep: running collector');
      const result = await collector.collect();
      sourcesSwept++;
      itemsCollected += result.itemsNew;

      // Respect per-source chunk limit
      allChunks.push(...result.contentChunks);

      logger.info(
        { collector: collector.name, scanned: result.itemsScanned, new: result.itemsNew, chunks: result.contentChunks.length },
        'Sweep: collector complete',
      );
    } catch (err) {
      logger.warn({ error: err, collector: collector.name }, 'Sweep: collector failed — continuing with others');
    }
  }

  if (allChunks.length === 0) {
    logger.info('Sweep: no new content across all sources — skipping synthesis');
    return { sourcesSwept, itemsCollected: 0, factsStored: 0, durationMs: Date.now() - startTime };
  }

  // ── 2. Create workspace and write content ──
  const baseDir = join(process.cwd(), '.workspaces');
  mkdirSync(baseDir, { recursive: true });
  const workspaceDir = mkdtempSync(join(baseDir, 'sweep-'));
  const contextDir = join(workspaceDir, 'context');
  const findingsDir = join(workspaceDir, 'findings');
  mkdirSync(contextDir, { recursive: true });
  mkdirSync(findingsDir, { recursive: true });

  // Write all collected content
  writeFileSync(join(contextDir, 'sweep-content.md'), allChunks.join('\n\n---\n\n'));

  // Write existing memory context so synthesis can deduplicate
  try {
    const memoryContext = await retrieveContext(deps.sql, 'recent facts decisions people projects', {
      tokenBudget: config.context.deepPathLongTermTokenBudget,
    });
    if (memoryContext.context) {
      writeFileSync(join(contextDir, 'memory.md'), memoryContext.context);
    }
  } catch (err) {
    logger.debug({ error: err }, 'Sweep: failed to load memory context for dedup — proceeding without');
  }

  // ── 3. Run Opus synthesis via deep path ──
  // Log workspace content size for debugging
  const sweepContent = readFileSync(join(contextDir, 'sweep-content.md'), 'utf-8');
  logger.info({
    chunks: allChunks.length,
    sources: sourcesSwept,
    sweepContentLength: sweepContent.length,
    sweepContentPreview: sweepContent.slice(0, 500),
  }, 'Sweep: starting Opus synthesis');

  const sweepPrompt = 'Process the sweep content in workspace/context/sweep-content.md. ' +
    'Cross-reference across all sources, deduplicate against existing memory in workspace/context/memory.md, ' +
    'and write synthesized findings to workspace/findings/findings.md.';

  const result = await executeDeepPath(
    sweepPrompt,
    {
      dataDir: deps.dataDir,
      workspaceDir,
      promptOverride: getPrompts().sweepSynthesis.replaceAll('{{WORKSPACE_DIR}}', workspaceDir),
    },
    undefined, // no SlackHandler — background task
  );

  if (!result.success) {
    logger.warn({ error: result.error }, 'Sweep: synthesis failed');
    return { sourcesSwept, itemsCollected, factsStored: 0, durationMs: Date.now() - startTime };
  }

  // ── 4. Process findings (handled by caller via processWorkspaceFiles) ──
  // The workspace dir is returned so the caller can process findings
  // and clean up. For the task executor integration, we return the workspace path
  // in the result for post-processing.

  const durationMs = Date.now() - startTime;
  logger.info({ sourcesSwept, itemsCollected, durationMs }, 'Sweep: synthesis complete');

  return {
    sourcesSwept,
    itemsCollected,
    factsStored: 0, // updated by caller after processWorkspaceFiles
    durationMs,
    // @ts-expect-error — extended result for internal use
    workspaceDir,
  };
}

/**
 * Register the recurring sweep task (idempotent).
 */
export async function registerSweepTask(sql: Sql, cron: string): Promise<void> {
  const existing = await findTaskByTitle(sql, 'sweep:all-sources');
  if (existing) {
    logger.debug('Sweep task already registered');
    return;
  }

  await createTask(sql, {
    title: 'sweep:all-sources',
    description: 'Background sweep of all data sources (Slack, Gmail, Fireflies). Collects new content, synthesizes cross-source, stores to memory.',
    cron_expression: cron,
    priority: 3,
    created_by_type: 'system',
  });

  logger.info({ cron }, 'Sweep task registered');
}
