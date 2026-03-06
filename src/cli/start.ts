import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { getDb } from '../db/index.js';

/**
 * Start the Clawvato agent process.
 *
 * In Track A (Foundation), this is a skeleton that:
 * 1. Validates configuration
 * 2. Verifies database connectivity
 * 3. Starts the process and waits for shutdown signals
 *
 * In Track B+, this will also:
 * - Connect to Slack via Socket Mode
 * - Register MCP servers
 * - Start the Agent SDK query loop
 */
export async function startAgent(): Promise<void> {
  const config = getConfig();

  logger.info({ dataDir: config.dataDir, trustLevel: config.trustLevel }, 'Starting Clawvato agent');

  // Verify database
  const db = getDb();
  const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as
    | { version: number }
    | undefined;
  logger.info({ schemaVersion: version?.version ?? 0 }, 'Database connected');

  // Verify critical config
  if (!config.ownerSlackUserId) {
    logger.warn('No ownerSlackUserId configured — agent will not be able to verify senders');
    logger.warn('Set with: clawvato config set ownerSlackUserId YOUR_SLACK_USER_ID');
  }

  // Log startup summary
  const trustLabels = ['FULL SUPERVISION', 'TRUSTED READS', 'TRUSTED ROUTINE', 'FULL AUTONOMY'];
  logger.info({
    trustLevel: `${config.trustLevel} (${trustLabels[config.trustLevel]})`,
    classifier: config.models.classifier,
    planner: config.models.planner,
    executor: config.models.executor,
  }, 'Agent configuration loaded');

  logger.info('Clawvato agent is running. Waiting for events...');
  logger.info('Press Ctrl+C to stop.');

  // Graceful shutdown
  const shutdown = () => {
    logger.info('Shutting down...');
    db.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Keep process alive
  await new Promise(() => {
    // This promise intentionally never resolves.
    // The agent process stays alive waiting for events.
    // In Track B, the Slack Socket Mode connection will keep it alive naturally.
  });
}
