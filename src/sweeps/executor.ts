/**
 * Sweep Executor — orchestrates collectors → workspace → Opus synthesis → memory.
 *
 * Runs all registered collectors, aggregates their raw content chunks,
 * pipes everything through a single Opus CLI synthesis pass that
 * cross-references across sources, and stores the resulting facts.
 *
 * Fail-fast: if ANY enabled collector errors, the entire sweep aborts.
 * No partial data synthesis — it's all or nothing.
 */

import { writeFileSync, readFileSync, mkdtempSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { getPrompts } from '../prompts.js';
import { executeDeepPath } from '../agent/deep-path.js';
import { retrieveContext } from '../memory/retriever.js';
import { findTaskByTitle, createTask } from '../tasks/store.js';
import type { Collector, SweepResult } from './types.js';

export { type SweepResult } from './types.js';

export interface SweepDeps {
  sql: Sql;
  dataDir: string;
  /** Collect data only — persist workspace to debug dir, skip synthesis */
  collectOnly?: boolean;
}

/**
 * Execute a full sweep: run all collectors, synthesize, store facts.
 * Aborts if any collector fails — no partial synthesis.
 */
export async function executeSweep(
  collectors: Collector[],
  deps: SweepDeps,
): Promise<SweepResult> {
  const startTime = Date.now();
  const config = getConfig();
  let itemsCollected = 0;
  let sourcesSwept = 0;

  // ── 1. Collect from all sources (fail-fast) ──
  const allChunks: string[] = [];

  // Run all collectors in parallel — they're independent data sources
  logger.info({ collectors: collectors.map(c => c.name) }, 'Sweep: running all collectors in parallel');

  const results = await Promise.allSettled(
    collectors.map(async (collector) => {
      logger.info({ collector: collector.name }, 'Sweep: starting collector');
      const result = await collector.collect();
      logger.info(
        { collector: collector.name, scanned: result.itemsScanned, new: result.itemsNew, chunks: result.contentChunks.length },
        'Sweep: collector complete',
      );
      return { name: collector.name, result };
    }),
  );

  // Check results — abort if any failed or returned empty
  for (const settled of results) {
    if (settled.status === 'rejected') {
      const errMsg = settled.reason instanceof Error ? settled.reason.message : JSON.stringify(settled.reason);
      logger.error({ error: errMsg }, 'Sweep: collector failed — ABORTING sweep');
      return { sourcesSwept, itemsCollected, factsStored: 0, durationMs: Date.now() - startTime };
    }

    const { name, result } = settled.value;
    if (result.itemsScanned === 0 && result.itemsNew === 0 && result.contentChunks.length === 0) {
      logger.warn({ collector: name }, 'Sweep: collector returned zero items — ABORTING sweep (possible auth/config issue)');
      return { sourcesSwept, itemsCollected, factsStored: 0, durationMs: Date.now() - startTime };
    }

    sourcesSwept++;
    itemsCollected += result.itemsNew;
    allChunks.push(...result.contentChunks);
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

  // Write sweep content for debug inspection
  writeFileSync(join(contextDir, 'sweep-content.md'), allChunks.join('\n\n---\n\n'));

  // Persist workspace to debug dir if configured
  if (process.env.DEBUG_WORKSPACE) {
    try {
      const { cpSync: cp } = await import('node:fs');
      const debugDir = join(process.env.DEBUG_WORKSPACE, `sweep-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      mkdirSync(debugDir, { recursive: true });
      cp(workspaceDir, debugDir, { recursive: true });
      logger.info({ debugDir }, 'Sweep workspace persisted for debugging');
    } catch (err) {
      logger.debug({ error: err }, 'Failed to persist debug workspace');
    }
  }

  // Collect-only mode: stop here
  if (deps.collectOnly) {
    const sweepContent = readFileSync(join(contextDir, 'sweep-content.md'), 'utf-8');
    logger.info({
      chunks: allChunks.length,
      sources: sourcesSwept,
      sweepContentLength: sweepContent.length,
    }, 'Sweep: collect-only mode — workspace ready for inspection, skipping synthesis');
    return { sourcesSwept, itemsCollected, factsStored: 0, durationMs: Date.now() - startTime };
  }

  // ── 3. Run Opus synthesis via deep path ──
  // Build system prompt with all content inline, write to file
  // (too large for CLI args — use --append-system-prompt-file)
  const sweepContent = readFileSync(join(contextDir, 'sweep-content.md'), 'utf-8');

  let memoryContent = '';
  try {
    const memoryContext = await retrieveContext(deps.sql, 'recent facts decisions people projects', {
      tokenBudget: config.context.deepPathLongTermTokenBudget,
    });
    if (memoryContext.context) memoryContent = memoryContext.context;
  } catch { /* first sweep — no memory */ }

  const synthesisPrompt = getPrompts().sweepSynthesis.replaceAll('{{WORKSPACE_DIR}}', workspaceDir);
  const fullPrompt = [
    synthesisPrompt,
    '\n## Sweep Content\n',
    sweepContent,
    memoryContent ? '\n## Existing Memory (for deduplication)\n' + memoryContent : '',
  ].join('\n');

  // Write system prompt to file (avoids E2BIG on large prompts)
  const systemPromptFile = join(workspaceDir, '.system-prompt.md');
  writeFileSync(systemPromptFile, fullPrompt);

  logger.info({
    chunks: allChunks.length,
    sources: sourcesSwept,
    sweepContentLength: sweepContent.length,
    memoryContentLength: memoryContent.length,
    systemPromptFileSize: fullPrompt.length,
  }, 'Sweep: starting Opus synthesis');

  const sweepPrompt = `Synthesize the content provided in your system prompt. Write findings to ${workspaceDir}/findings/findings.md using a single cat command.`;

  const result = await executeDeepPath(
    sweepPrompt,
    {
      dataDir: deps.dataDir,
      workspaceDir,
      synthesisMode: true,
      systemPromptFile,
    },
    undefined, // no SlackHandler — background task
  );

  // Clean up system prompt file
  try { unlinkSync(systemPromptFile); } catch { /* */ }

  if (!result.success) {
    logger.warn({ error: result.error, durationMs: result.durationMs }, 'Sweep: synthesis failed');
    return { sourcesSwept, itemsCollected, factsStored: 0, durationMs: Date.now() - startTime };
  }

  const durationMs = Date.now() - startTime;
  logger.info({ sourcesSwept, itemsCollected, durationMs, synthesisDurationMs: result.durationMs }, 'Sweep: synthesis complete');

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
    description: 'Background sweep of all data sources (Slack, Gmail, Drive, Fireflies). Collects new content, synthesizes cross-source, stores to memory.',
    cron_expression: cron,
    priority: 3,
    created_by_type: 'system',
  });

  logger.info({ cron }, 'Sweep task registered');
}
