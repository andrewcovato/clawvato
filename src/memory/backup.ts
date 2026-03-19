/**
 * Memory Backup — uploads the SQLite database to Google Drive.
 *
 * Runs as part of the consolidation pipeline (daily).
 * Creates/updates a single backup file in a "Clawvato Backups" folder.
 * The agent backing up its own brain.
 */

import { google } from 'googleapis';
import { readFileSync, copyFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { getGoogleAuth } from '../google/auth.js';
import { getConfig } from '../config.js';
import { logger } from '../logger.js';

const BACKUP_FOLDER_NAME = 'Clawvato Backups';
const BACKUP_FILE_NAME = 'clawvato-memory.db';

/**
 * Backup the SQLite database to Google Drive.
 * Creates a "Clawvato Backups" folder if it doesn't exist.
 * Updates the existing backup file or creates a new one.
 */
export async function backupToGoogleDrive(): Promise<void> {
  const config = getConfig();
  const dbPath = join(config.dataDir, 'clawvato.db');

  if (!existsSync(dbPath)) {
    logger.debug('No database file to backup');
    return;
  }

  const auth = await getGoogleAuth();
  if (!auth) {
    logger.debug('Google auth not available — skipping Drive backup');
    return;
  }

  const drive = google.drive({ version: 'v3', auth });

  try {
    // Create a local copy first (avoid reading while SQLite writes)
    const backupPath = `${dbPath}.backup`;
    copyFileSync(dbPath, backupPath);

    // Find or create the backup folder
    const folderId = await findOrCreateFolder(drive, BACKUP_FOLDER_NAME);

    // Find existing backup file
    const existing = await drive.files.list({
      q: `name = '${BACKUP_FILE_NAME}' and '${folderId}' in parents and trashed = false`,
      fields: 'files(id)',
      pageSize: 1,
    });

    const fileContent = readFileSync(backupPath);
    const media = {
      mimeType: 'application/x-sqlite3',
      body: Readable.from(fileContent),
    };

    if (existing.data.files?.[0]?.id) {
      // Update existing backup
      await drive.files.update({
        fileId: existing.data.files[0].id,
        media,
      });
      logger.info({ fileId: existing.data.files[0].id, sizeBytes: fileContent.length }, 'Memory backup updated on Google Drive');
    } else {
      // Create new backup
      const created = await drive.files.create({
        requestBody: {
          name: BACKUP_FILE_NAME,
          parents: [folderId],
        },
        media,
        fields: 'id',
      });
      logger.info({ fileId: created.data.id, sizeBytes: fileContent.length }, 'Memory backup created on Google Drive');
    }

    // Clean up local copy
    try { unlinkSync(backupPath); } catch { /* */ }
  } catch (error) {
    logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Drive backup failed — non-critical');
  }
}

/**
 * Find a folder by name or create it.
 */
async function findOrCreateFolder(
  drive: ReturnType<typeof google.drive>,
  folderName: string,
): Promise<string> {
  // Search for existing folder
  const existing = await drive.files.list({
    q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id)',
    pageSize: 1,
  });

  if (existing.data.files?.[0]?.id) {
    return existing.data.files[0].id;
  }

  // Create the folder
  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
    },
    fields: 'id',
  });

  logger.info({ folderId: created.data.id }, `Created "${folderName}" folder on Google Drive`);
  return created.data.id!;
}
