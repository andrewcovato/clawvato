/**
 * Start the Clawvato agent process.
 *
 * This is the full bootstrap that:
 * 1. Validates required credentials (Anthropic, Slack)
 * 2. Verifies database connectivity
 * 3. Connects to Slack via Socket Mode
 * 4. Creates the Agent SDK orchestrator
 * 5. Wires handler.onBatch → agent.processBatch
 * 6. Handles graceful shutdown
 */

import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { getDb, closeDb } from '../db/index.js';
import { hasCredential, requireCredential } from '../credentials.js';
import { createSlackConnection } from '../slack/socket-mode.js';
import { createAgent } from '../agent/index.js';

export async function startAgent(): Promise<void> {
  const config = getConfig();

  logger.info({ dataDir: config.dataDir, trustLevel: config.trustLevel }, 'Starting Clawvato agent');

  // ── Verify database ──
  const db = getDb();
  const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as
    | { version: number }
    | undefined;
  logger.info({ schemaVersion: version?.version ?? 0 }, 'Database connected');

  // ── Verify required credentials ──
  const missingCreds: string[] = [];
  if (!await hasCredential('anthropic-api-key')) missingCreds.push('anthropic-api-key');
  if (!await hasCredential('slack-bot-token')) missingCreds.push('slack-bot-token');
  if (!await hasCredential('slack-app-token')) missingCreds.push('slack-app-token');

  if (missingCreds.length > 0) {
    logger.error(
      { missing: missingCreds },
      'Missing required credentials. Run: clawvato setup',
    );
    console.error(`\nMissing credentials: ${missingCreds.join(', ')}`);
    console.error('Run `clawvato setup` to configure all required credentials.\n');
    process.exit(1);
  }

  // ── Verify owner config ──
  if (!config.ownerSlackUserId) {
    logger.warn('No ownerSlackUserId configured — agent will not verify senders');
    logger.warn('Set with: clawvato config set ownerSlackUserId YOUR_SLACK_USER_ID');
  }

  // ── Log startup summary ──
  const trustLabels = ['FULL SUPERVISION', 'TRUSTED READS', 'TRUSTED ROUTINE', 'FULL AUTONOMY'];
  logger.info({
    trustLevel: `${config.trustLevel} (${trustLabels[config.trustLevel]})`,
    model: config.models.executor,
  }, 'Agent configuration loaded');

  // ── Connect to Slack via Socket Mode ──
  const botToken = await requireCredential('slack-bot-token');
  const appToken = await requireCredential('slack-app-token');
  let userToken: string | undefined;
  try {
    userToken = (await hasCredential('slack-user-token'))
      ? await requireCredential('slack-user-token')
      : undefined;
  } catch {
    // User token is optional — search will be limited
  }

  const slack = await createSlackConnection({ appToken, botToken, userToken });

  // ── Create the Agent ──
  const agent = await createAgent({
    botClient: slack.botClient,
    userClient: slack.userClient,
  });

  // ── Wire batch processing ──
  slack.handler.onBatch(async (batch) => {
    await agent.processBatch(batch, slack.handler);
  });

  // ── Graceful shutdown ──
  const shutdown = async () => {
    logger.info('Shutting down...');
    await agent.shutdown();
    await slack.stop();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // ── Start Socket Mode connection ──
  await slack.start();

  logger.info('Clawvato agent is running. DM the bot or @mention it in a channel.');
  logger.info('Press Ctrl+C to stop.');

  // Socket Mode keeps the process alive via the WebSocket connection
}
