/**
 * Drive Collector — file metadata + content summaries for sweep synthesis.
 *
 * Lists new/modified files since last sweep, extracts a content snippet
 * from each, and formats as markdown for cross-referencing with Slack,
 * Gmail, and Fireflies content during Opus synthesis.
 *
 * For backfill: processes all files (slow, one-time cost).
 * For incremental: only new/modified files (fast, ~5-10 files).
 *
 * High-water mark: sweep:drive:last_sync (ISO date of last sync)
 */

import { google } from 'googleapis';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getFileContent } from '../google/drive-sync.js';
import { getHighWaterMark, setHighWaterMark, type Collector, type CollectorResult } from './types.js';

interface DriveSweepConfig {
  maxFiles: number;
}

/**
 * Create a Drive collector that lists files and extracts content summaries.
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
        // Query files modified since last sweep — business-relevant types only
        const relevantTypes = [
          "mimeType = 'application/vnd.google-apps.document'",       // Google Docs
          "mimeType = 'application/vnd.google-apps.spreadsheet'",    // Google Sheets
          "mimeType = 'application/vnd.google-apps.presentation'",   // Google Slides
          "mimeType = 'application/pdf'",                             // PDFs
          "mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'",  // .docx
          "mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'",        // .xlsx
          "mimeType = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'", // .pptx
          "mimeType = 'application/msword'",                          // .doc
          "mimeType = 'application/vnd.ms-excel'",                    // .xls
          "mimeType = 'application/vnd.ms-powerpoint'",               // .ppt
          "mimeType = 'text/plain'",                                  // .txt
          "mimeType = 'text/csv'",                                    // .csv
        ];
        let q = `trashed = false and (${relevantTypes.join(' or ')})`;
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
        }> = [];

        let pageToken: string | undefined;
        while (files.length < config.maxFiles) {
          const result = await drive.files.list({
            q,
            pageSize: Math.min(100, config.maxFiles - files.length),
            pageToken,
            fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, owners, parents)',
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

        // Resolve folder paths
        const folderNames = new Map<string, string>();
        const parentIds = new Set(files.flatMap(f => f.parents));
        for (const parentId of parentIds) {
          try {
            const folder = await drive.files.get({ fileId: parentId, fields: 'name' });
            if (folder.data.name) folderNames.set(parentId, folder.data.name);
          } catch { /* root or shared drive */ }
        }

        // Process files: metadata + content snippet
        const CONTENT_SNIPPET_CHARS = 2000; // First 2K chars of content
        const BATCH_SIZE = 5;
        const fileEntries: string[] = [];

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (file) => {
              const folder = file.parents.length > 0
                ? (folderNames.get(file.parents[0]) ?? 'root')
                : 'root';
              const type = simplifyMimeType(file.mimeType);

              // Extract content snippet
              let snippet = '';
              try {
                const content = await getFileContent(drive, file.id, file.mimeType, CONTENT_SNIPPET_CHARS);
                if (content?.kind === 'text' && content.text) {
                  snippet = content.text.slice(0, CONTENT_SNIPPET_CHARS).trim();
                }
              } catch {
                // Content extraction failed — metadata only
              }

              const parts = [
                `### ${file.name}`,
                `Type: ${type} | Folder: ${folder} | Owner: ${file.owners} | Modified: ${file.modifiedTime.split('T')[0]}`,
              ];
              if (snippet) {
                parts.push(`\nContent preview:\n> ${snippet.slice(0, 500).replace(/\n/g, '\n> ')}`);
              }

              return parts.join('\n');
            }),
          );

          fileEntries.push(...results);
          itemsNew += batch.length;

          logger.debug({ batch: Math.floor(i / BATCH_SIZE) + 1, processed: fileEntries.length }, 'Drive sweep: batch processed');
        }

        contentChunks.push(`## Google Drive: Files\n\n${fileEntries.join('\n\n---\n\n')}`);

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
  return mime.split('/').pop() ?? mime;
}
