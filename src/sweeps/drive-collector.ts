/**
 * Drive Collector — wraps existing syncDrive for the sweep pipeline.
 *
 * Unlike other collectors that dump raw content for Opus synthesis,
 * the Drive collector uses the existing drive-sync engine which already
 * handles content extraction, Haiku summarization, and memory storage.
 *
 * For the sweep pipeline, it outputs file metadata + summaries as
 * markdown chunks so the Opus synthesis can cross-reference files
 * with Slack/Gmail/Fireflies content.
 *
 * High-water mark: sweep:drive:last_sync (ISO date of last sync)
 */

import { google } from 'googleapis';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getHighWaterMark, setHighWaterMark, type Collector, type CollectorResult } from './types.js';

interface DriveSweepConfig {
  maxFiles: number;
}

/**
 * Create a Drive collector that lists files and produces metadata chunks.
 * File content extraction and summarization happen separately via the
 * existing drive-sync pipeline — this collector focuses on giving the
 * Opus synthesizer awareness of what files exist and where.
 */
export function createDriveCollector(
  auth: InstanceType<typeof google.auth.OAuth2>,
  sql: Sql,
  config: DriveSweepConfig,
): Collector {
  return {
    name: 'drive',

    async collect(): Promise<CollectorResult> {
      let itemsScanned = 0;
      let itemsNew = 0;
      const contentChunks: string[] = [];

      const drive = google.drive({ version: 'v3', auth });
      const hwmKey = 'drive:last_sync';
      const lastSync = await getHighWaterMark(sql, hwmKey);

      try {
        // Query files modified since last sweep
        let q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
        if (lastSync) {
          q += ` and modifiedTime > '${lastSync}'`;
        }

        const files: Array<{
          id: string;
          name: string;
          mimeType: string;
          modifiedTime: string;
          owners: string;
          parents: string[];
          webViewLink?: string;
        }> = [];

        let pageToken: string | undefined;
        while (files.length < config.maxFiles) {
          const result = await drive.files.list({
            q,
            pageSize: Math.min(100, config.maxFiles - files.length),
            pageToken,
            fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, owners, parents, webViewLink)',
            orderBy: 'modifiedTime desc',
          });

          for (const f of result.data.files ?? []) {
            files.push({
              id: f.id!,
              name: f.name!,
              mimeType: f.mimeType!,
              modifiedTime: f.modifiedTime!,
              owners: (f.owners ?? []).map(o => o.displayName ?? 'unknown').join(', '),
              parents: (f.parents ?? []) as string[],
              webViewLink: f.webViewLink ?? undefined,
            });
          }

          pageToken = result.data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }

        itemsScanned = files.length;

        if (files.length === 0) {
          logger.info('Drive sweep: no new/modified files');
          return { source: 'drive', itemsScanned: 0, itemsNew: 0, contentChunks: [] };
        }

        // Resolve folder paths for context
        const folderNames = new Map<string, string>();
        const parentIds = new Set(files.flatMap(f => f.parents));
        for (const parentId of parentIds) {
          try {
            const folder = await drive.files.get({ fileId: parentId, fields: 'name' });
            if (folder.data.name) folderNames.set(parentId, folder.data.name);
          } catch { /* skip — might be root or shared drive */ }
        }

        // Format as markdown
        const lines: string[] = [];
        for (const file of files) {
          itemsNew++;
          const folder = file.parents.length > 0
            ? (folderNames.get(file.parents[0]) ?? 'root')
            : 'root';
          const type = simplifyMimeType(file.mimeType);

          lines.push(
            `- **${file.name}** (${type})\n` +
            `  Folder: ${folder} | Owner: ${file.owners} | Modified: ${file.modifiedTime.split('T')[0]}`,
          );
        }

        contentChunks.push(`## Google Drive: Recent/modified files\n\n${lines.join('\n')}`);

        // Update high-water mark
        if (files.length > 0) {
          await setHighWaterMark(sql, hwmKey, files[0].modifiedTime);
        }

        logger.info({ itemsScanned, itemsNew, chunks: contentChunks.length }, 'Drive sweep complete');
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : JSON.stringify(err);
        logger.warn({ error: errMsg }, 'Drive sweep failed');
      }

      return { source: 'drive', itemsScanned, itemsNew, contentChunks };
    },
  };
}

function simplifyMimeType(mime: string): string {
  if (mime.includes('document')) return 'Google Doc';
  if (mime.includes('spreadsheet')) return 'Google Sheet';
  if (mime.includes('presentation')) return 'Google Slides';
  if (mime.includes('pdf')) return 'PDF';
  if (mime.includes('image')) return 'Image';
  if (mime.includes('video')) return 'Video';
  if (mime.includes('folder')) return 'Folder';
  return mime.split('/').pop() ?? mime;
}
