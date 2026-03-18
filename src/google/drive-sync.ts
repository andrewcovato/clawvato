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
import { generateId } from '../db/index.js';
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
}

export interface DeepReadResult {
  factsExtracted: number;
  conflictsFound: number;
}

// ── Summary generation prompt ──

const SUMMARY_PROMPT = `Analyze this document and return a JSON object with:
- "summary": 2-3 sentence summary — what it is, what it contains, who it's relevant to
- "entities": array of person names, company names, and key topics mentioned

Be specific enough that someone could decide whether to read it based on your summary alone.
Return ONLY valid JSON, no markdown.`;

// ── Fact extraction from document content ──

const DOC_EXTRACTION_PROMPT = `Extract structured facts from this document. Return a JSON array of objects.

Each item has:
- type: "fact", "decision", "strategy", "conclusion", or "commitment"
- content: A clear statement with enough context to be useful without the original document
- confidence: 0.8-1.0 (documents are generally reliable sources)
- importance: 1-10
- entities: Array of person names, company names, or key topics

Rules:
- Capture key facts, decisions, deadlines, and action items
- Include the WHY behind decisions and strategies
- For commitments, include who, what, and when
- Skip boilerplate, formatting artifacts, and generic content
- If nothing worth extracting, return []
- Return ONLY valid JSON array, no markdown`;

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

// ── Content export ──

const EXPORTABLE_MIMES: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.spreadsheet': 'text/csv',
  'application/vnd.google-apps.presentation': 'text/plain',
};

/**
 * Export a Google Doc/Sheet/Slides as text. Returns null if not exportable.
 */
async function exportFileContent(
  drive: ReturnType<typeof google.drive>,
  fileId: string,
  mimeType: string,
  maxChars: number = 10000,
): Promise<string | null> {
  const exportMime = EXPORTABLE_MIMES[mimeType];
  if (!exportMime) return null;

  try {
    const result = await drive.files.export({
      fileId,
      mimeType: exportMime,
    }, { responseType: 'text' });

    const content = typeof result.data === 'string' ? result.data : String(result.data);
    return content.slice(0, maxChars);
  } catch (error) {
    logger.debug({ error, fileId }, 'Failed to export file content');
    return null;
  }
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

  for (const file of driveFiles) {
    seenIds.add(file.id);
    const existing = existingDocs.get(file.id);

    if (!existing) {
      // New file
      const folderPath = await getFilePath(drive, file.parents);
      const content = await exportFileContent(drive, file.id, file.mimeType, 2000);
      const contentHash = content ? hashContent(content) : null;

      let summary: string | null = null;
      let fileEntities: string[] = [];
      if (content && content.length > 50) {
        const result = await generateSummary(client, model, file.name, content);
        summary = result.summary;
        fileEntities = result.entities;
        summariesGenerated++;
      }

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
      newFiles++;

    } else if (existing.modified_time !== file.modifiedTime) {
      // Modified file — check if content actually changed
      const content = await exportFileContent(drive, file.id, file.mimeType, 2000);
      const contentHash = content ? hashContent(content) : null;

      if (contentHash !== existing.content_hash) {
        // Content actually changed — re-summarize
        let summary = existing.summary;
        let fileEntities = existing.entities;
        if (content && content.length > 50) {
          const result = await generateSummary(client, model, file.name, content);
          summary = result.summary;
          fileEntities = JSON.stringify(result.entities);
          summariesGenerated++;
        }

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
  }

  // ── 3. Detect removed files ──
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
): Promise<DeepReadResult> {
  const drive = google.drive({ version: 'v3', auth });

  // Get file metadata
  const fileMeta = await drive.files.get({
    fileId,
    fields: 'id, name, mimeType, modifiedTime',
  });

  const name = fileMeta.data.name ?? 'Unknown';
  const mimeType = fileMeta.data.mimeType ?? '';

  // Export content
  const content = await exportFileContent(drive, fileId, mimeType);
  if (!content) {
    return { factsExtracted: 0, conflictsFound: 0 };
  }

  logger.info({ fileId, name, contentLength: content.length }, 'Deep reading file');

  // Extract facts via Haiku
  const source = `drive:${fileId}:${fileMeta.data.modifiedTime ?? 'unknown'}`;
  let factsExtracted = 0;
  let conflictsFound = 0;

  try {
    const response = await client.messages.create({
      model,
      max_tokens: 2000,
      system: DOC_EXTRACTION_PROMPT,
      messages: [{ role: 'user', content: `Document: "${name}"\n\n${content}` }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonStr = text.replace(/^```json?\s*/i, '').replace(/\s*```$/, '').trim();
    const facts = JSON.parse(jsonStr);

    if (!Array.isArray(facts)) {
      logger.warn('Document extraction returned non-array');
      return { factsExtracted: 0, conflictsFound: 0 };
    }

    const newMemoryIds: { id: string; content: string }[] = [];

    for (const fact of facts) {
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
        // Conflict detection
        const isSlackSource = closeMatch.source.startsWith('slack:');
        const isRecent = closeMatch.created_at > new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        if (isSlackSource && isRecent && closeMatch.confidence >= confidence) {
          // Owner's recent Slack statement outranks document — flag conflict but keep owner's version
          conflictsFound++;
          logger.info({
            existing: closeMatch.content.slice(0, 80),
            new: factContent.slice(0, 80),
            source: 'drive',
          }, 'Conflict detected: owner statement vs document — keeping owner version');
          continue;
        }

        if (confidence > closeMatch.confidence || !isSlackSource) {
          // Document outranks old memory — supersede
          const newId = insertMemory(db, {
            type: factType, content: factContent, source, importance, confidence, entities,
          });
          supersedeMemory(db, closeMatch.id, newId);
          deleteEmbedding(db, closeMatch.id);
          newMemoryIds.push({ id: newId, content: factContent });
          factsExtracted++;
        }
        // Otherwise skip (existing memory is better)
      } else {
        // No conflict — store as new
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
    logger.error({ error, fileId }, 'Document fact extraction failed');
  }

  logger.info({ fileId, name, factsExtracted, conflictsFound }, 'Deep read complete');
  return { factsExtracted, conflictsFound };
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
 * Generate a Tier 2 summary + entity extraction for a file.
 */
async function generateSummary(
  client: Anthropic,
  model: string,
  fileName: string,
  content: string,
): Promise<{ summary: string; entities: string[] }> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 300,
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: `File: "${fileName}"\n\n${content.slice(0, 2000)}` }],
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
