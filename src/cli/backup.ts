/**
 * Standalone backup entrypoint — runs as a Railway cron service.
 * Copies the SQLite DB to Google Drive and exits.
 *
 * Railway cron config: schedule "0 7 * * *" (2am EST / 7am UTC daily)
 * Mounts the same /data volume as the main service.
 */

import { loadConfig } from '../config.js';
import { backupToGoogleDrive } from '../memory/backup.js';
import { logger } from '../logger.js';

async function main() {
  loadConfig();
  logger.info('Starting scheduled backup');

  try {
    await backupToGoogleDrive();
    logger.info('Scheduled backup complete');
  } catch (error) {
    logger.error({ error: error instanceof Error ? error.message : String(error) }, 'Scheduled backup failed');
    process.exit(1);
  }

  process.exit(0);
}

main();
