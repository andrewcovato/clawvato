/**
 * Drive Knowledge Sync — maintains an up-to-date understanding of the owner's files.
 *
 * Three tiers of knowledge:
 *   Tier 1 (File Index): metadata — name, type, owner, modified time
 *   Tier 2 (Summary): 2-3 sentence Haiku summary of content
 *   Tier 3 (Deep Read): full fact extraction into memory
 *
 * Sync uses hash-based delta detection:
 *   - modifiedTime changed? → re-export and check content_hash
 *   - content_hash changed? → re-summarize + re-extract facts
 *   - No change? → skip (catches 80%+ of files at near-zero cost)
 *
 * Facts from files flow into the same memory system as Slack conversations.
 * Conflict resolution uses source authority:
 *   Owner's direct statement > Recent document > Old document > Inferred
 */

import { google } from 'googleapis';
import { createHash } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';
import type { DatabaseSync } from 'node:sqlite';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { getPrompts } from '../prompts.js';
import { generateId } from '../db/index.js';
import {
  extractContent,
  type ExtractedContent,
  getMaxFileSizeBytes,
} from './file-extractor.js';
import {
  insertMemory,
  findDuplicates,
  supersedeMemory,
  deleteEmbedding,
  hasVectorSupport,
  insertEmbedding,
  type MemoryType,
} from '../memory/store.js';
import { embedBatch } from '../memory/embeddings.js';
import { contentSimilarity } from '../memory/extractor.js';

// ── Document table types ──

export interface Document {
  id: string;
  source_type: string;
  source_id: string;
  name: string;
  mime_type: string | null;
  folder_path: string | null;
  owner: string | null;
  modified_time: string | null;
  content_hash: string | null;
  summary: string | null;
  entities: string; // JSON array
  last_synced_at: string | null;
  deep_read_at: string | null;
  status: string;
  created_at: string;
}

export interface SyncResult {
  filesScanned: number;
  newFiles: number;
  updatedFiles: number;
  removedFiles: number;
  summariesGenerated: number;
  memoriesBackfilled: number;
}

export interface DeepReadResult {
  factsExtracted: number;
  conflictsFound: number;
}

// ── Summary generation prompt ──

// Prompts loaded from config/prompts/ at startup
// Edit those files to change extraction behavior — no code change needed.

// ── Document CRUD ──

export function getDocument(db: DatabaseSync, sourceType: string, sourceId: string): Document | null {
  const row = db.prepare(
    'SELECT * FROM documents WHERE source_type = ? AND source_id = ?'
  ).get(sourceType, sourceId);
  return row ? row as unknown as Document : null;
}

export function upsertDocument(
  db: DatabaseSync,
  doc: Omit<Document, 'id' | 'created_at'> & { id?: string },
): string {
  const existing = getDocument(db, doc.source_type, doc.source_id);
  const entities = doc.entities ?? '[]';
  if (existing) {
    db.prepare(`
      UPDATE documents SET name = ?, mime_type = ?, folder_path = ?, owner = ?,
        modified_time = ?, content_hash = ?, summary = ?, entities = ?, last_synced_at = ?,
        deep_read_at = ?, status = ?
      WHERE id = ?
    `).run(
      doc.name, doc.mime_type ?? null, doc.folder_path ?? null, doc.owner ?? null,
      doc.modified_time ?? null, doc.content_hash ?? null, doc.summary ?? null,
      entities, doc.last_synced_at ?? null, doc.deep_read_at ?? null, doc.status,
      existing.id,
    );
    return existing.id;
  }

  const id = doc.id ?? generateId();
  db.prepare(`
    INSERT INTO documents (id, source_type, source_id, name, mime_type, folder_path, owner,
      modified_time, content_hash, summary, entities, last_synced_at, deep_read_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, doc.source_type, doc.source_id, doc.name, doc.mime_type ?? null,
    doc.folder_path ?? null, doc.owner ?? null, doc.modified_time ?? null,
    doc.content_hash ?? null, doc.summary ?? null, entities,
    doc.last_synced_at ?? null, doc.deep_read_at ?? null, doc.status,
  );
  return id;
}

export function listDocuments(db: DatabaseSync, opts?: { status?: string; limit?: number }): Document[] {
  const status = opts?.status ?? 'active';
  const limit = opts?.limit ?? 200;
  return db.prepare(
    'SELECT * FROM documents WHERE status = ? ORDER BY modified_time DESC LIMIT ?'
  ).all(status, limit) as unknown as Document[];
}

/**
 * Find documents mentioning a specific entity (person, company, topic).
 */
export function findDocumentsByEntity(db: DatabaseSync, entity: string, opts?: { limit?: number }): Document[] {
  const limit = opts?.limit ?? 5;
  const escapedEntity = entity.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
  // Search both name and entities JSON array
  return db.prepare(`
    SELECT * FROM documents
    WHERE status = 'active'
      AND (entities LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')
    ORDER BY modified_time DESC LIMIT ?
  `).all(`%${escapedEntity}%`, `%${escapedEntity}%`, limit) as unknown as Document[];
}

export function findDocumentByName(db: DatabaseSync, name: string): Document | null {
  const row = db.prepare(
    "SELECT * FROM documents WHERE name LIKE ? AND status = 'active' ORDER BY modified_time DESC LIMIT 1"
  ).get(`%${name}%`);
  return row ? row as unknown as Document : null;
}

// ── Content retrieval ──

/** Google-native MIME types that can be exported as text via the Drive API */
const EXPORTABLE_MIMES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/**
 * Export a Google-native file (Docs/Sheets/Slides) as text.
 */
async function exportFileContent(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  mimeType: string,
  maxChars: number = 10000,
): Promise<ExtractedContent | null> {
  const exportMime = EXPORTABLE_MIMES[mimeType];
  if (!exportMime) return null;

  try {
    const result = await drive.files.export({
      fileId,
      mimeType: exportMime,
    }, { responseType: 'text' });

    const content = typeof result.data === 'string' ? result.data : String(result.data);
    return { kind: 'text', text: content.slice(0, maxChars) };
  } catch (error) {
    logger.debug({ error, fileId }, 'Failed to export file content');
    return null;
  }
}

/**
 * Download a non-Google-native file (uploaded .docx, .pdf, .xlsx, etc.) as a Buffer.
 */
async function downloadFileBuffer(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
): Promise<Buffer | null> {
  try {
    // Check file size before downloading
    const meta = await drive.files.get({ fileId, fields: 'size' });
    const size = Number(meta.data.size ?? 0);
    if (size > getMaxFileSizeBytes()) {
      logger.warn({ fileId, size, max: getMaxFileSizeBytes() }, 'File too large to download');
      return null;
    }

    const result = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' },
    );

    return Buffer.from(result.data as ArrayBuffer);
  } catch (error) {
    logger.debug({ error, fileId }, 'Failed to download file');
    return null;
  }
}

/**
 * Get content from any Drive file — Google-native or uploaded binary.
 * Tries Google export first, then falls back to download + extraction.
 */
export async function getFileContent(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  mimeType: string,
  maxChars: number = 10000,
): Promise<ExtractedContent | null> {
  // Google-native files → export via Drive API
  const exported = await exportFileContent(drive, fileId, mimeType, maxChars);
  if (exported) return exported;

  // Google-native types that weren't exportable (e.g., Forms, Sites) → skip
  if (mimeType.startsWith('application/vnd.google-apps.')) return null;

  // Binary files → download and extract
  const buffer = await downloadFileBuffer(drive, fileId);
  if (!buffer) return null;

  return await extractContent(buffer, mimeType);
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ── Build folder path ──

async function getFilePath(
  drive: ReturnType<typeof google.drive>,
  parents: string[] | undefined,
): Promise<string> {
  if (!parents || parents.length === 0) return '/';
  try {
    const parts: string[] = [];
    let currentId = parents[0];
    for (let i = 0; i < 5; i++) { // max depth to avoid infinite loop
      const parent = await drive.files.get({ fileId: currentId, fields: 'name, parents' });
      if (!parent.data.name) break;
      parts.unshift(parent.data.name);
      if (!parent.data.parents || parent.data.parents.length === 0) break;
      currentId = parent.data.parents[0];
    }
    return '/' + parts.join('/');
  } catch {
    return '/';
  }
}

/**
 * Build a complete folder ID → path map by recursively discovering all folders.
 * Much more reliable than per-file getFilePath which makes N API calls and fails under concurrency.
 */
async function buildFolderPathMap(
  drive: ReturnType<typeof google.drive>,
  rootFolderId?: string,
): Promise<Map<string, string>> {
  const pathMap = new Map<string, string>();

  // If we have a root folder, get its name first
  if (rootFolderId) {
    try {
      const root = await drive.files.get({ fileId: rootFolderId, fields: 'name, parents' });
      const rootName = root.data.name ?? 'root';
      // Walk up to get full path of root
      const rootPath = await getFilePath(drive, [rootFolderId]);
      pathMap.set(rootFolderId, rootPath);
    } catch {
      pathMap.set(rootFolderId, '/');
    }
  }

  // Discover all folders recursively
  const queue = rootFolderId ? [rootFolderId] : [];

  // If no root, discover top-level folders
  if (!rootFolderId) {
    try {
      const result = await drive.files.list({
        q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents",
        pageSize: 200,
        fields: 'files(id, name)',
      });
      for (const f of result.data.files ?? []) {
        if (f.id && f.name) {
          pathMap.set(f.id, `/${f.name}`);
          queue.push(f.id);
        }
      }
    } catch { /* non-critical */ }
  }

  // BFS to find all subfolders and build paths
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    const parentPath = pathMap.get(parentId) ?? '/';

    try {
      let pageToken: string | undefined;
      do {
        const result = await drive.files.list({
          q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          pageSize: 200,
          pageToken,
          fields: 'nextPageToken, files(id, name)',
        });
        for (const f of result.data.files ?? []) {
          if (f.id && f.name) {
            pathMap.set(f.id, `${parentPath}/${f.name}`);
            queue.push(f.id);
          }
        }
        pageToken = result.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (error) {
      logger.debug({ error, parentId }, 'Failed to list subfolders');
    }
  }

  logger.info({ folderCount: pathMap.size }, 'Built folder path map');
  return pathMap;
}

/**
 * Recursively collect all subfolder IDs under a given folder.
 */
async function getAllSubfolderIds(
  drive: ReturnType<typeof google.drive>,
  rootFolderId: string,
): Promise<string[]> {
  const allIds: string[] = [rootFolderId];
  const queue = [rootFolderId];

  while (queue.length > 0) {
    const parentId = queue.shift()!;
    try {
      let pageToken: string | undefined;
      do {
        const result = await drive.files.list({
          q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
          pageSize: 100,
          pageToken,
          fields: 'nextPageToken, files(id)',
        });
        for (const f of result.data.files ?? []) {
          if (f.id) {
            allIds.push(f.id);
            queue.push(f.id);
          }
        }
        pageToken = result.data.nextPageToken ?? undefined;
      } while (pageToken);
    } catch (error) {
      logger.debug({ error, parentId }, 'Failed to list subfolders');
    }
  }

  return allIds;
}

/**
 * Build the expected memory content for a file.
 * Used both for creating new memories and checking if existing ones are current.
 * The summary is a conclusion (e.g., "Acme Corp is a client with an active proposal")
 * not a file description, so we include the file name as context but let the summary lead.
 */
function buildFileMemoryContent(
  fileName: string,
  folderPath: string | null,
  summary: string,
): string {
  const pathLabel = folderPath && folderPath !== '/' ? ` [source: ${folderPath}/${fileName}]` : ` [source: ${fileName}]`;
  return `${summary}${pathLabel}`;
}

/**
 * Build the full entity list for a file memory (includes folder names).
 */
function buildFileEntities(entities: string[], folderPath: string | null): string[] {
  const result = [...entities];
  if (folderPath && folderPath !== '/') {
    for (const part of folderPath.split('/').filter(Boolean)) {
      if (!result.includes(part)) result.push(part);
    }
  }
  return result;
}

/**
 * Store a file summary as a memory, linking it back to the document via source.
 * Supersedes any existing memory for this file.
 */
function storeFileSummaryAsMemory(
  db: DatabaseSync,
  fileId: string,
  fileName: string,
  folderPath: string | null,
  summary: string,
  entities: string[],
  modifiedTime: string,
): void {
  const source = `drive:${fileId}:${modifiedTime}`;
  const content = buildFileMemoryContent(fileName, folderPath, summary);
  const allEntities = buildFileEntities(entities, folderPath);

  // Supersede any existing memory from this file
  const existingPattern = `drive:${fileId}:%`;
  const existing = db.prepare(`
    SELECT id FROM memories
    WHERE source LIKE ? AND valid_until IS NULL AND type = 'fact'
    ORDER BY created_at DESC LIMIT 1
  `).get(existingPattern) as { id: string } | undefined;

  logger.info({ fileId, content: content.slice(0, 200), entities: allEntities }, 'Storing file summary as memory');

  const newId = insertMemory(db, {
    type: 'fact',
    content,
    source,
    importance: 5,
    confidence: 0.85,
    entities: allEntities,
  });

  if (existing) {
    supersedeMemory(db, existing.id, newId);
    deleteEmbedding(db, existing.id);
  }

  // Embed the new memory
  if (hasVectorSupport(db)) {
    embedBatch([content]).then(embeddings => {
      if (embeddings.length > 0) {
        insertEmbedding(db, newId, embeddings[0]);
      }
    }).catch(() => { /* non-critical */ });
  }
}

// ── Sync engine ──

/**
 * Sync files from Google Drive into the document registry.
 * Detects new, modified, and removed files. Generates Tier 2 summaries for changes.
 */
export async function syncDrive(
  auth: InstanceType<typeof google.auth.OAuth2>,
  db: DatabaseSync,
  client: Anthropic,
  model: string,
  opts?: { folderId?: string; maxFiles?: number },
): Promise<SyncResult> {
  const drive = google.drive({ version: 'v3', auth });
  const maxFiles = opts?.maxFiles ?? 500;
  const now = new Date().toISOString();

  logger.info({ folderId: opts?.folderId, maxFiles }, 'Starting Drive sync');

  // ── 1. List files from Drive ──
  const driveFiles: Array<{
    id: string; name: string; mimeType: string; modifiedTime: string;
    owners: Array<{ displayName: string }>; parents?: string[];
  }> = [];

  // If a folder is specified, recursively find all subfolder IDs
  let folderIds: string[] | null = null;
  if (opts?.folderId) {
    folderIds = await getAllSubfolderIds(drive, opts.folderId);
    logger.info({ rootFolder: opts.folderId, totalFolders: folderIds.length }, 'Resolved folder tree');
  }

  let pageToken: string | undefined;
  // If we have folder IDs, query each folder; otherwise query all of Drive
  const folderQueue = folderIds ? [...folderIds] : [null];
  let currentFolderIdx = 0;

  while (driveFiles.length < maxFiles && currentFolderIdx < folderQueue.length) {
    const currentFolder = folderQueue[currentFolderIdx];
    let q = "trashed = false and mimeType != 'application/vnd.google-apps.folder'";
    if (currentFolder) {
      q += ` and '${currentFolder}' in parents`;
    }

    const result = await drive.files.list({
      q,
      pageSize: Math.min(100, maxFiles - driveFiles.length),
      pageToken,
      fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, owners, parents)',
      orderBy: 'modifiedTime desc',
    });

    for (const f of result.data.files ?? []) {
      driveFiles.push({
        id: f.id!,
        name: f.name!,
        mimeType: f.mimeType!,
        modifiedTime: f.modifiedTime!,
        owners: (f.owners ?? []).map(o => ({ displayName: o.displayName ?? 'unknown' })),
        parents: f.parents as string[] | undefined,
      });
    }

    pageToken = result.data.nextPageToken ?? undefined;
    if (!pageToken) {
      // Move to next folder in the queue
      currentFolderIdx++;
      pageToken = undefined;
    }
  }

  logger.info({ filesFound: driveFiles.length }, 'Drive files listed');

  // Build folder path map upfront — much faster and more reliable than per-file API calls
  const folderPathMap = await buildFolderPathMap(drive, opts?.folderId);

  // ── 2. Compare against document registry ──
  const existingDocs = new Map<string, Document>();
  for (const doc of listDocuments(db, { limit: 10000 })) {
    if (doc.source_type === 'gdrive') {
      existingDocs.set(doc.source_id, doc);
    }
  }

  let newFiles = 0;
  let updatedFiles = 0;
  let summariesGenerated = 0;
  const seenIds = new Set<string>();

  // Process files in parallel batches for speed
  const batchSize = getConfig().drive.syncBatchSize;
  for (let batchStart = 0; batchStart < driveFiles.length; batchStart += batchSize) {
    const batch = driveFiles.slice(batchStart, batchStart + batchSize);

    await Promise.all(batch.map(async (file) => {
    seenIds.add(file.id);
    const existing = existingDocs.get(file.id);

    if (!existing) {
      // New file — resolve folder path from pre-built map
      const parentId = file.parents?.[0];
      const folderPath = parentId ? (folderPathMap.get(parentId) ?? '/') : '/';
      const extracted = await getFileContent(drive, file.id, file.mimeType, 2000);
      const contentHash = extracted?.kind === 'text' ? hashContent(extracted.text) : null;

      // Always generate a summary — content is a bonus, not a requirement.
      const { summary: genSummary, entities: genEntities } = await generateSummary(
        client, model, file.name, folderPath, extracted,
      );
      const summary = genSummary;
      const fileEntities = genEntities;
      summariesGenerated++;
      logger.debug({ name: file.name, folderPath, summaryLen: summary.length, entities: fileEntities.length }, 'Generated summary for new file');

      upsertDocument(db, {
        source_type: 'gdrive',
        source_id: file.id,
        name: file.name,
        mime_type: file.mimeType,
        folder_path: folderPath,
        owner: file.owners[0]?.displayName ?? null,
        modified_time: file.modifiedTime,
        content_hash: contentHash,
        summary,
        entities: JSON.stringify(fileEntities),
        last_synced_at: now,
        deep_read_at: null,
        status: 'active',
      });

      // Store summary as a memory so it flows through the standard retrieval pipeline
      if (summary) {
        storeFileSummaryAsMemory(db, file.id, file.name, folderPath, summary, fileEntities, file.modifiedTime);
      }
      newFiles++;

    } else if (existing.modified_time !== file.modifiedTime) {
      // Modified file — check if content actually changed
      const extracted = await getFileContent(drive, file.id, file.mimeType, 2000);
      const contentHash = extracted?.kind === 'text' ? hashContent(extracted.text) : null;

      if (contentHash !== existing.content_hash) {
        // Content actually changed — re-summarize
        const { summary: genSummary, entities: genEntities } = await generateSummary(
          client, model, file.name, existing.folder_path, extracted,
        );
        const summary = genSummary;
        const fileEntities = JSON.stringify(genEntities);
        summariesGenerated++;

        upsertDocument(db, {
          source_type: 'gdrive',
          source_id: file.id,
          name: file.name,
          mime_type: file.mimeType,
          folder_path: existing.folder_path,
          owner: file.owners[0]?.displayName ?? existing.owner,
          modified_time: file.modifiedTime,
          content_hash: contentHash,
          summary,
          entities: fileEntities,
          last_synced_at: now,
          deep_read_at: null, // invalidate deep read
          status: 'active',
        });

        // Flag memories from old version as potentially stale
        flagStaleMemories(db, file.id, file.modifiedTime);

        // Update the summary memory
        if (summary) {
          const entityList = typeof fileEntities === 'string' ? JSON.parse(fileEntities) : fileEntities;
          storeFileSummaryAsMemory(db, file.id, file.name, existing.folder_path, summary, entityList, file.modifiedTime);
        }
        updatedFiles++;
      } else {
        // Content unchanged — just update sync time
        db.prepare(
          "UPDATE documents SET last_synced_at = ?, modified_time = ? WHERE source_type = 'gdrive' AND source_id = ?"
        ).run(now, file.modifiedTime, file.id);
      }
    } else {
      // Unchanged — update sync time
      db.prepare(
        "UPDATE documents SET last_synced_at = ? WHERE source_type = 'gdrive' AND source_id = ?"
      ).run(now, file.id);
    }
    })); // end Promise.all + batch.map
  } // end batch loop

  // ── 3. Self-heal: ensure every file with a summary has a corresponding memory ──
  const toBackfill: Array<{ fileId: string; name: string; folderPath: string | null; summary: string; entities: string[]; modifiedTime: string; existingMemoryId?: string }> = [];

  for (const file of driveFiles) {
    const doc = getDocument(db, 'gdrive', file.id);
    if (!doc || !doc.summary) continue;

    const entities = doc.entities ? JSON.parse(doc.entities) as string[] : [];
    const expectedContent = buildFileMemoryContent(doc.name, doc.folder_path, doc.summary);

    // Check if a current, correct memory exists for this file
    const existingMemory = db.prepare(
      "SELECT id, content FROM memories WHERE source LIKE ? AND valid_until IS NULL AND type = 'fact' LIMIT 1"
    ).get(`drive:${file.id}:%`) as { id: string; content: string } | undefined;

    const needsUpdate = !existingMemory || existingMemory.content !== expectedContent;

    if (needsUpdate) {
      toBackfill.push({
        fileId: file.id,
        name: doc.name,
        folderPath: doc.folder_path,
        summary: doc.summary,
        entities,
        modifiedTime: doc.modified_time ?? now,
        existingMemoryId: existingMemory?.id,
      });
    }
  }

  let memoriesBackfilled = 0;
  if (toBackfill.length > 0) {
    logger.info({ count: toBackfill.length }, 'Backfilling/updating file memories');

    // Store all memories first (fast, DB only)
    const newMemoryIds: { id: string; content: string }[] = [];
    for (const item of toBackfill) {
      const source = `drive:${item.fileId}:${item.modifiedTime}`;
      const content = buildFileMemoryContent(item.name, item.folderPath, item.summary);
      const entities = buildFileEntities(item.entities, item.folderPath);

      const newId = insertMemory(db, {
        type: 'fact',
        content,
        source,
        importance: 5,
        confidence: 0.85,
        entities,
      });

      // Supersede the old memory if it existed but was outdated
      if (item.existingMemoryId) {
        supersedeMemory(db, item.existingMemoryId, newId);
        deleteEmbedding(db, item.existingMemoryId);
      }

      newMemoryIds.push({ id: newId, content });
      memoriesBackfilled++;
    }

    // Batch embed all at once (one call instead of N)
    if (newMemoryIds.length > 0 && hasVectorSupport(db)) {
      try {
        const embeddings = await embedBatch(newMemoryIds.map(m => m.content));
        for (let i = 0; i < newMemoryIds.length; i++) {
          insertEmbedding(db, newMemoryIds[i].id, embeddings[i]);
        }
        logger.info({ count: newMemoryIds.length }, 'Batch embedded backfilled memories');
      } catch (error) {
        logger.debug({ error }, 'Batch embedding failed — memories stored without vectors');
      }
    }

    logger.info({ memoriesBackfilled }, 'Backfilled missing file memories');
  }

  // ── 4. Detect removed files ──
  let removedFiles = 0;
  for (const [sourceId, doc] of existingDocs) {
    if (!seenIds.has(sourceId) && doc.status === 'active') {
      db.prepare(
        "UPDATE documents SET status = 'removed', last_synced_at = ? WHERE id = ?"
      ).run(now, doc.id);
      flagStaleMemories(db, sourceId, 'removed');
      removedFiles++;
    }
  }

  const result: SyncResult = {
    filesScanned: driveFiles.length,
    newFiles,
    updatedFiles,
    removedFiles,
    summariesGenerated,
    memoriesBackfilled,
  };

  logger.info(result, 'Drive sync complete');
  return result;
}

/**
 * Deep read a file — export full content, extract facts into memory.
 */
export async function deepReadFile(
  auth: InstanceType<typeof google.auth.OAuth2>,
  db: DatabaseSync,
  client: Anthropic,
  model: string,
  fileId: string,
  synthesisModel?: string,
): Promise<DeepReadResult> {
  const drive = google.drive({ version: 'v3', auth });

  // Get file metadata
  const fileMeta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, modifiedTime',
  });

  const name = fileMeta.data.name ?? 'Unknown';
  const mimeType = fileMeta.data.mimeType ?? '';

  // Get content — works for both Google-native and uploaded files
  const extracted = await getFileContent(drive, fileId, mimeType);
  if (!extracted) {
    return { factsExtracted: 0, conflictsFound: 0 };
  }

  logger.info({ fileId, name, contentKind: extracted.kind }, 'Deep reading file');

  // ── Chunked extraction: split document into chunks, extract from each ──
  const source = `drive:${fileId}:${fileMeta.data.modifiedTime ?? 'unknown'}`;
  let factsExtracted = 0;
  let conflictsFound = 0;

  try {
    // For non-text content (PDF/images), use single-pass extraction
    const chunks = extracted.kind === 'text'
      ? chunkText(extracted.text, CHUNK_SIZE, CHUNK_OVERLAP)
      : [null]; // null = use multimodal content block

    logger.info({ fileId, name, chunks: chunks.length, contentKind: extracted.kind }, 'Starting chunked extraction');

    const allFacts: Array<Record<string, unknown>> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      // Build message content for this chunk
      let messageContent: Anthropic.ContentBlockParam[];
      if (chunk !== null) {
        // Text chunk
        const chunkLabel = chunks.length > 1 ? ` (section ${i + 1}/${chunks.length})` : '';
        messageContent = [{ type: 'text', text: `Document: "${name}"${chunkLabel}\n\n${chunk}` }];
      } else {
        // Binary content (PDF/image) — use multimodal block
        messageContent = buildSummaryMessageContent(name, null, extracted);
        const lastBlock = messageContent[messageContent.length - 1];
        if (lastBlock.type === 'text') {
          lastBlock.text = `Document: "${name}"\n\nAnalyze the file above and extract structured facts.`;
        }
      }

      try {
        const response = await client.messages.create({
          model,
          max_tokens: 4096,
          system: getPrompts().docExtraction,
          messages: [{ role: 'user', content: messageContent }],
        });

        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map(b => b.text)
          .join('');

        const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
        const parsed = parseJsonResilient(jsonStr);
        if (parsed) {
          allFacts.push(...parsed);
        }
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error), chunk: i }, 'Chunk extraction failed — continuing');
      }
    }

    logger.info({ fileId, rawFacts: allFacts.length, chunks: chunks.length }, 'Chunked extraction complete');

    // ── Sonnet synthesis pass: deduplicate, resolve conflicts, catch nuance ──
    let synthesizedFacts = allFacts;
    if (allFacts.length > 0 && synthesisModel) {
      try {
        synthesizedFacts = await synthesizeFacts(client, synthesisModel, name, allFacts);
        logger.info({ fileId, rawFacts: allFacts.length, synthesized: synthesizedFacts.length }, 'Sonnet synthesis complete');
      } catch (error) {
        logger.warn({ error: error instanceof Error ? error.message : String(error) }, 'Synthesis failed — using raw facts');
      }
    }

    // ── Store facts ──
    const newMemoryIds: { id: string; content: string }[] = [];

    for (const rawFact of synthesizedFacts) {
      const fact = rawFact as Record<string, unknown>;
      if (!fact.content || !fact.type) continue;

      const factContent = String(fact.content).slice(0, 500);
      const factType = fact.type as MemoryType;
      const confidence = Math.max(0, Math.min(1, Number(fact.confidence) || 0.85));
      const importance = Math.max(1, Math.min(10, Math.round(Number(fact.importance) || 5)));
      const entities = Array.isArray(fact.entities) ? fact.entities.map(String) : [];

      // Check for conflicts with existing memories
      const duplicates = findDuplicates(db, factContent, factType);
      const closeMatch = duplicates.find(d => contentSimilarity(d.content, factContent) > 0.7);

      if (closeMatch) {
        const isSlackSource = closeMatch.source.startsWith('slack:');
        const isRecent = closeMatch.created_at > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        if (isSlackSource && isRecent && closeMatch.confidence >= confidence) {
          conflictsFound++;
          continue;
        }

        if (confidence > closeMatch.confidence || !isSlackSource) {
          const newId = insertMemory(db, {
            type: factType, content: factContent, source, importance, confidence, entities,
          });
          supersedeMemory(db, closeMatch.id, newId);
          deleteEmbedding(db, closeMatch.id);
          newMemoryIds.push({ id: newId, content: factContent });
          factsExtracted++;
        }
      } else {
        const newId = insertMemory(db, {
          type: factType, content: factContent, source, importance, confidence, entities,
        });
        newMemoryIds.push({ id: newId, content: factContent });
        factsExtracted++;
      }
    }

    // Embed new memories
    if (newMemoryIds.length > 0 && hasVectorSupport(db)) {
      try {
        const embeddings = await embedBatch(newMemoryIds.map(m => m.content));
        for (let i = 0; i < newMemoryIds.length; i++) {
          insertEmbedding(db, newMemoryIds[i].id, embeddings[i]);
        }
      } catch (error) {
        logger.debug({ error }, 'Embedding generation failed for doc facts');
      }
    }

    // Update document record
    db.prepare(`
      UPDATE documents SET deep_read_at = datetime('now'), last_synced_at = datetime('now')
      WHERE source_type = 'gdrive' AND source_id = ?
    `).run(fileId);

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ error: errMsg, fileId }, 'Document fact extraction failed');
  }

  logger.info({ fileId, name, factsExtracted, conflictsFound }, 'Deep read complete');
  return { factsExtracted, conflictsFound };
}

// ── Chunking and synthesis helpers ──

/** Chunk size in characters (~2K tokens) */
const CHUNK_SIZE = 8000;

/** Overlap between chunks to avoid splitting facts at boundaries */
const CHUNK_OVERLAP = 500;

/**
 * Split text into overlapping chunks, breaking at paragraph boundaries when possible.
 */
function chunkText(text: string, chunkSize: number, overlap: number): string[] {
  if (text.length <= chunkSize) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end = start + chunkSize;

    // Try to break at a paragraph boundary
    if (end < text.length) {
      const lastParagraph = text.lastIndexOf('\n\n', end);
      if (lastParagraph > start + chunkSize / 2) {
        end = lastParagraph;
      }
    }

    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length) break;
  }

  return chunks;
}

/**
 * Resilient JSON array parser — handles truncated responses.
 */
function parseJsonResilient(jsonStr: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(jsonStr);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    const salvaged = jsonStr.replace(/,\s*\{[^}]*$/, '') + ']';
    try {
      const parsed = JSON.parse(salvaged);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

/**
 * Sonnet synthesis pass — deduplicates, resolves conflicts, and catches nuance
 * that Haiku may have missed. Takes the raw facts from chunked extraction
 * and produces a refined, higher-quality set.
 */
async function synthesizeFacts(
  client: Anthropic,
  model: string,
  fileName: string,
  rawFacts: Array<Record<string, unknown>>,
): Promise<Array<Record<string, unknown>>> {
  const factsJson = JSON.stringify(rawFacts, null, 2);

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: `You are refining facts extracted from a document. Your job:
1. Deduplicate — merge facts that say the same thing in different words
2. Resolve conflicts — if two facts contradict, keep the more specific/confident one
3. Enrich — add context or nuance that makes facts more useful long-term
4. Re-score — adjust importance (1-10) based on the full picture
5. Preserve all entities accurately

Return a JSON array in the same format. Every fact must have: type, content, confidence, importance, entities.
Return ONLY valid JSON, no markdown.`,
    messages: [{
      role: 'user',
      content: `Document: "${fileName}"\n\nRaw extracted facts (${rawFacts.length} items):\n${factsJson}`,
    }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('');

  const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
  const parsed = parseJsonResilient(jsonStr);
  return parsed ?? rawFacts; // fall back to raw facts if synthesis parsing fails
}

/**
 * Flag memories sourced from a file as potentially stale.
 * Reduces confidence of memories from older versions of the file.
 */
function flagStaleMemories(db: DatabaseSync, fileId: string, newModifiedTime: string): void {
  const pattern = `drive:${fileId}:%`;
  const result = db.prepare(`
    UPDATE memories SET confidence = confidence * 0.5
    WHERE source LIKE ? AND valid_until IS NULL AND confidence > 0.3
  `).run(pattern);

  const count = Number(result.changes ?? 0);
  if (count > 0) {
    logger.info({ fileId, memoriesFlagged: count }, 'Flagged stale memories from modified file');
  }
}

/**
 * Build the Claude message content for a file, handling text, PDF, and image content.
 */
function buildSummaryMessageContent(
  fileName: string,
  folderPath: string | null,
  extracted: ExtractedContent | null,
): Anthropic.ContentBlockParam[] {
  const pathContext = folderPath && folderPath !== '/' ? `Folder path: ${folderPath}\n` : '';
  const preamble = `${pathContext}File name: "${fileName}"`;

  if (!extracted) {
    // No content available — summarize from metadata only
    return [{ type: 'text', text: preamble }];
  }

  switch (extracted.kind) {
    case 'text':
      return [{ type: 'text', text: `${preamble}\n\n${extracted.text.slice(0, 2000)}` }];

    case 'document':
      return [
        {
          type: 'document',
          source: { type: 'base64', media_type: extracted.mediaType, data: extracted.base64 },
        },
        { type: 'text', text: `${preamble}\n\nAnalyze the PDF above.` },
      ];

    case 'image':
      return [
        {
          type: 'image',
          source: { type: 'base64', media_type: extracted.mediaType, data: extracted.base64 },
        },
        { type: 'text', text: `${preamble}\n\nDescribe the image above.` },
      ];
  }
}

/**
 * Generate a Tier 2 summary + entity extraction for a file.
 * Accepts any ExtractedContent — text, PDF document blocks, or image blocks.
 */
async function generateSummary(
  client: Anthropic,
  model: string,
  fileName: string,
  folderPath: string | null,
  extracted: ExtractedContent | null,
): Promise<{ summary: string; entities: string[] }> {
  try {
    const messageContent = buildSummaryMessageContent(fileName, folderPath, extracted);
    const response = await client.messages.create({
      model,
      max_tokens: 300,
      system: getPrompts().summary,
      messages: [{ role: 'user', content: messageContent }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
    try {
      const parsed = JSON.parse(jsonStr);
      return {
        summary: String(parsed.summary ?? '').trim() || `[Summary unavailable for ${fileName}]`,
        entities: Array.isArray(parsed.entities) ? parsed.entities.map(String) : [],
      };
    } catch {
      // Haiku returned plain text instead of JSON — use as summary
      return { summary: text.trim(), entities: [] };
    }
  } catch (error) {
    logger.error({ error, fileName }, 'Summary generation failed');
    return { summary: `[Summary unavailable for ${fileName}]`, entities: [] };
  }
}
