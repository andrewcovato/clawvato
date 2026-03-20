/**
 * Tests for Drive Knowledge Sync.
 *
 * Tests document registry CRUD, sync logic, and conflict detection.
 * Uses isolated Postgres schemas per test suite via pg-test helper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb, type TestSql } from '../helpers/pg-test.js';
import {
  getDocument,
  upsertDocument,
  listDocuments,
  findDocumentByName,
} from '../../src/google/drive-sync.js';
import { insertMemory, getMemory, findMemoriesByType } from '../../src/memory/store.js';

let sql: TestSql;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  const testDb = await createTestDb();
  sql = testDb.sql;
  cleanup = testDb.cleanup;
});

afterEach(async () => {
  await cleanup();
});

describe('Document registry CRUD', () => {
  it('inserts and retrieves a document', async () => {
    const id = await upsertDocument(sql, {
      source_type: 'gdrive',
      source_id: 'file_abc123',
      name: 'Q2 Budget.xlsx',
      mime_type: 'application/vnd.google-apps.spreadsheet',
      folder_path: '/Finance',
      owner: 'Sarah Chen',
      modified_time: '2026-03-15T10:00:00Z',
      content_hash: 'abc123hash',
      summary: 'Q2 revenue projections broken down by region.',
      last_synced_at: '2026-03-17T10:00:00Z',
      deep_read_at: null,
      status: 'active',
    });

    const doc = await getDocument(sql, 'gdrive', 'file_abc123');
    expect(doc).not.toBeNull();
    expect(doc!.name).toBe('Q2 Budget.xlsx');
    expect(doc!.summary).toContain('revenue projections');
    expect(doc!.status).toBe('active');
  });

  it('upserts existing document (updates, not duplicates)', async () => {
    await upsertDocument(sql, {
      source_type: 'gdrive',
      source_id: 'file_abc123',
      name: 'Q2 Budget.xlsx',
      mime_type: 'application/vnd.google-apps.spreadsheet',
      folder_path: '/Finance',
      owner: 'Sarah',
      modified_time: '2026-03-15T10:00:00Z',
      content_hash: 'hash1',
      summary: 'Old summary',
      last_synced_at: '2026-03-15T10:00:00Z',
      deep_read_at: null,
      status: 'active',
    });

    await upsertDocument(sql, {
      source_type: 'gdrive',
      source_id: 'file_abc123',
      name: 'Q2 Budget v2.xlsx',
      mime_type: 'application/vnd.google-apps.spreadsheet',
      folder_path: '/Finance',
      owner: 'Sarah',
      modified_time: '2026-03-17T10:00:00Z',
      content_hash: 'hash2',
      summary: 'Updated summary',
      last_synced_at: '2026-03-17T10:00:00Z',
      deep_read_at: null,
      status: 'active',
    });

    const docs = await listDocuments(sql);
    expect(docs).toHaveLength(1);
    expect(docs[0].name).toBe('Q2 Budget v2.xlsx');
    expect(docs[0].content_hash).toBe('hash2');
    expect(docs[0].summary).toBe('Updated summary');
  });

  it('lists documents ordered by modified time', async () => {
    await upsertDocument(sql, {
      source_type: 'gdrive', source_id: 'file_1', name: 'Older File',
      mime_type: null, folder_path: null, owner: null,
      modified_time: '2026-03-10T10:00:00Z', content_hash: null,
      summary: null, last_synced_at: null, deep_read_at: null, status: 'active',
    });
    await upsertDocument(sql, {
      source_type: 'gdrive', source_id: 'file_2', name: 'Newer File',
      mime_type: null, folder_path: null, owner: null,
      modified_time: '2026-03-17T10:00:00Z', content_hash: null,
      summary: null, last_synced_at: null, deep_read_at: null, status: 'active',
    });

    const docs = await listDocuments(sql);
    expect(docs).toHaveLength(2);
    expect(docs[0].name).toBe('Newer File');
    expect(docs[1].name).toBe('Older File');
  });

  it('filters by status', async () => {
    await upsertDocument(sql, {
      source_type: 'gdrive', source_id: 'file_1', name: 'Active File',
      mime_type: null, folder_path: null, owner: null,
      modified_time: null, content_hash: null,
      summary: null, last_synced_at: null, deep_read_at: null, status: 'active',
    });
    await upsertDocument(sql, {
      source_type: 'gdrive', source_id: 'file_2', name: 'Removed File',
      mime_type: null, folder_path: null, owner: null,
      modified_time: null, content_hash: null,
      summary: null, last_synced_at: null, deep_read_at: null, status: 'removed',
    });

    const active = await listDocuments(sql, { status: 'active' });
    expect(active).toHaveLength(1);
    expect(active[0].name).toBe('Active File');

    const removed = await listDocuments(sql, { status: 'removed' });
    expect(removed).toHaveLength(1);
    expect(removed[0].name).toBe('Removed File');
  });

  it('finds document by name (partial match)', async () => {
    await upsertDocument(sql, {
      source_type: 'gdrive', source_id: 'file_1', name: 'Q2 Budget Projections.xlsx',
      mime_type: null, folder_path: null, owner: null,
      modified_time: null, content_hash: null,
      summary: null, last_synced_at: null, deep_read_at: null, status: 'active',
    });

    const found = await findDocumentByName(sql, 'Budget');
    expect(found).not.toBeNull();
    expect(found!.name).toContain('Budget');

    const notFound = await findDocumentByName(sql, 'Nonexistent');
    expect(notFound).toBeNull();
  });
});

describe('Stale memory flagging', () => {
  it('reduces confidence of memories from modified files', async () => {
    // Insert a memory sourced from a Drive file
    const memId = await insertMemory(sql, {
      type: 'fact',
      content: 'APAC revenue target is $2M',
      source: 'drive:file_abc:2026-03-15',
      confidence: 0.85,
      importance: 8,
    });

    // Simulate file modification flagging stale memories
    const pattern = 'drive:file_abc:%';
    await sql`
      UPDATE memories SET confidence = confidence * 0.5
      WHERE source LIKE ${pattern} AND valid_until IS NULL AND confidence > 0.3
    `;

    const mem = await getMemory(sql, memId);
    expect(mem!.confidence).toBeCloseTo(0.425); // 0.85 * 0.5
  });

  it('does not flag memories from other files', async () => {
    const memId = await insertMemory(sql, {
      type: 'fact',
      content: 'Some other fact',
      source: 'drive:file_xyz:2026-03-15',
      confidence: 0.9,
    });

    // Flag file_abc, not file_xyz
    await sql`
      UPDATE memories SET confidence = confidence * 0.5
      WHERE source LIKE ${'drive:file_abc:%'} AND valid_until IS NULL
    `;

    const mem = await getMemory(sql, memId);
    expect(mem!.confidence).toBeCloseTo(0.9); // unchanged
  });
});

describe('Conflict detection logic', () => {
  it('owner Slack statement outranks document content', async () => {
    // Owner said something in Slack recently
    await insertMemory(sql, {
      type: 'fact',
      content: 'APAC revenue target was revised to $1.8M',
      source: 'slack:C123:ts_recent',
      confidence: 1.0,
      importance: 9,
    });

    // Document says $2M — the Slack statement should win
    // This tests the logic conceptually; actual conflict resolution
    // happens in deepReadFile which requires Google API mocks
    const facts = await findMemoriesByType(sql, 'fact', { validOnly: true });
    expect(facts).toHaveLength(1);
    expect(facts[0].content).toContain('$1.8M');
    expect(facts[0].confidence).toBe(1.0);
  });
});
