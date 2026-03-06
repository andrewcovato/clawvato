import { getDb } from '../db/index.js';
import { getConfig } from '../config.js';

/**
 * Show agent status: config, database stats, active workflows, recent actions.
 */
export function showStatus(): void {
  const config = getConfig();
  const db = getDb();

  console.log('\n=== Clawvato Status ===\n');

  // Config
  const trustLabels = ['FULL SUPERVISION', 'TRUSTED READS', 'TRUSTED ROUTINE', 'FULL AUTONOMY'];
  console.log(`Trust Level:  ${config.trustLevel} (${trustLabels[config.trustLevel]})`);
  console.log(`Data Dir:     ${config.dataDir}`);
  console.log(`Owner Slack:  ${config.ownerSlackUserId ?? 'not set'}`);
  console.log();

  // Database stats
  const memoriesCount = (db.prepare('SELECT COUNT(*) as n FROM memories WHERE valid_until IS NULL').get() as unknown as { n: number }).n;
  const peopleCount = (db.prepare('SELECT COUNT(*) as n FROM people').get() as unknown as { n: number }).n;
  const actionsCount = (db.prepare('SELECT COUNT(*) as n FROM actions').get() as unknown as { n: number }).n;

  console.log('Database:');
  console.log(`  Active memories: ${memoriesCount}`);
  console.log(`  Known people:    ${peopleCount}`);
  console.log(`  Actions logged:  ${actionsCount}`);
  console.log();

  // Active workflows
  const activeWorkflows = db.prepare(
    "SELECT id, type, status, created_at FROM workflows WHERE status IN ('active', 'waiting_reply', 'waiting_confirmation') ORDER BY updated_at DESC LIMIT 5",
  ).all() as unknown as Array<{ id: string; type: string; status: string; created_at: string }>;

  if (activeWorkflows.length > 0) {
    console.log('Active Workflows:');
    for (const wf of activeWorkflows) {
      console.log(`  [${wf.status}] ${wf.type} (${wf.id.slice(0, 8)}) — started ${wf.created_at}`);
    }
  } else {
    console.log('Active Workflows: none');
  }
  console.log();

  // Recent actions
  const recentActions = db.prepare(
    'SELECT type, status, created_at FROM actions ORDER BY created_at DESC LIMIT 5',
  ).all() as unknown as Array<{ type: string; status: string; created_at: string }>;

  if (recentActions.length > 0) {
    console.log('Recent Actions:');
    for (const action of recentActions) {
      console.log(`  [${action.status}] ${action.type} — ${action.created_at}`);
    }
  } else {
    console.log('Recent Actions: none');
  }

  // Graduated patterns
  const graduatedCount = (db.prepare('SELECT COUNT(*) as n FROM action_patterns WHERE graduated_at IS NOT NULL').get() as unknown as { n: number }).n;
  console.log(`\nGraduated Patterns: ${graduatedCount}`);

  console.log();
}
