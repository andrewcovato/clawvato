/**
 * CC-Native Engine Launcher — starts the supervisor entrypoint script.
 *
 * Called from the CLI when ENGINE=cc-native or --engine cc-native is set.
 * Delegates to the bash supervisor script which manages the CC restart loop
 * and task scheduler sidecar.
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { logger } from '../logger.js';

export async function startCCNativeEngine(): Promise<void> {
  const scriptPath = join(process.cwd(), 'scripts', 'cc-native-entrypoint.sh');

  logger.info('Starting CC-Native Engine via supervisor script');
  logger.info({ script: scriptPath }, 'Launching supervisor');

  const proc = spawn('bash', [scriptPath], {
    stdio: 'inherit',
    env: process.env,
    cwd: process.cwd(),
  });

  proc.on('error', (err) => {
    logger.error({ error: err }, 'Failed to start CC-Native supervisor');
    process.exit(1);
  });

  proc.on('exit', (code) => {
    logger.info({ code }, 'CC-Native supervisor exited');
    process.exit(code ?? 0);
  });

  // Forward signals to the supervisor
  process.on('SIGTERM', () => proc.kill('SIGTERM'));
  process.on('SIGINT', () => proc.kill('SIGINT'));
}
