/**
 * Drive Collector — file metadata + content summaries for sweep synthesis.
 *
 * Lists new/modified files since last sweep via Google Drive API,
 * extracts a content snippet from each, and formats as markdown for
 * cross-referencing during Opus synthesis.
 *
 * High-water mark: sweep:drive:last_sync (ISO date of last sync)
 */

import { google } from 'googleapis';
import type { Sql } from '../db/index.js';
import { logger } from '../logger.js';
import { getFileContent, buildFolderPathMap } from '../google/drive-sync.js';
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
        // Query business files — exclude folders, git repos, hidden files, lock files.
        // Git repos synced to Drive flood results with .git/ objects.
        // GitHub integration (future) handles code — Drive sweep is for business docs.
        let q = [
          "trashed = false",
          "mimeType != 'application/vnd.google-apps.folder'",
          "mimeType != 'application/octet-stream'",  // git objects, binaries
          "not name contains '.git'",                 // .git/, .gitignore, etc.
          "not name contains '.lock'",                // lock files
          "not name starts with '.'",                 // hidden files (.DS_Store, .env, etc.)
          "not name starts with '~'",                 // temp files (~$doc.docx)
        ].join(' and ');
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
            // Include shared drives and files shared with user
            includeItemsFromAllDrives: true,
            supportsAllDrives: true,
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

        // Log what we found for debugging
        const mimeTypeCounts = new Map<string, number>();
        for (const f of files) {
          mimeTypeCounts.set(f.mimeType, (mimeTypeCounts.get(f.mimeType) ?? 0) + 1);
        }
        logger.info({
          fileCount: files.length,
          mimeTypes: Object.fromEntries(mimeTypeCounts),
          sampleFiles: files.slice(0, 10).map(f => `${f.name} (${f.mimeType})`),
        }, 'Drive sweep: files discovered');

        if (files.length === 0) {
          logger.info('Drive sweep: no new/modified files');
          return { source: 'drive', itemsScanned: 0, itemsNew: 0, contentChunks: [] };
        }

        // Build full folder path map (BFS of all folders — reuses drive-sync engine)
        const folderPathMap = await buildFolderPathMap(drive);

        // Process files: full path + content snippet
        const CONTENT_SNIPPET_CHARS = 2000;
        const BATCH_SIZE = 5;
        const fileEntries: string[] = [];

        for (let i = 0; i < files.length; i += BATCH_SIZE) {
          const batch = files.slice(i, i + BATCH_SIZE);
          const results = await Promise.all(
            batch.map(async (file) => {
              const parentPath = file.parents.length > 0
                ? (folderPathMap.get(file.parents[0]) ?? '/')
                : '/';
              const fullPath = `${parentPath}/${file.name}`;

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

              const summary = snippet
                ? snippet.slice(0, 500).replace(/\n/g, ' ').trim()
                : '(no text content)';

              return `${fullPath} — ${summary}`;
            }),
          );

          fileEntries.push(...results);
          itemsNew += batch.length;
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
