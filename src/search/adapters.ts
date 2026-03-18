/**
 * Cross-Source Search Adapters — one per data source.
 *
 * Each adapter implements SearchAdapter: search() returns candidates,
 * enrich() fetches full content for cache misses.
 *
 * Adding a new source: implement SearchAdapter (~50-80 lines),
 * register in CrossSourceDeps, add to search-planning prompt.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { gmail_v1 } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { WebClient } from '@slack/web-api';
import type { FirefliesClient } from '../fireflies/api.js';
import { getThreadExtractionState } from '../google/email-scan.js';
import { searchMemories, type MemoryType } from '../memory/store.js';
import { logger } from '../logger.js';

// ── Types ──

export interface SearchHit {
  id: string;
  source: string;           // 'gmail', 'fireflies', 'slack', 'drive', 'memory'
  title: string;
  snippet: string;           // 200-300 chars
  date: string;
  participants: string[];
  memoryHit: boolean;        // Already extracted into memory?
}

export interface SourcePlan {
  queries?: string[];
  query?: string;
  daysBack?: number;
  keywords?: string[];
  ftsQuery?: string;
  types?: string[];
  sourcePrefix?: string;
}

export interface SearchAdapter {
  name: string;
  search(plan: SourcePlan, maxResults: number): Promise<SearchHit[]>;
}

// ── Gmail Adapter ──

export class GmailAdapter implements SearchAdapter {
  name = 'gmail';

  constructor(
    private gmail: gmail_v1.Gmail,
    private db: DatabaseSync,
  ) {}

  async search(plan: SourcePlan, maxResults: number): Promise<SearchHit[]> {
    const queries = plan.queries ?? (plan.query ? [plan.query] : []);
    if (queries.length === 0) return [];

    const allHits = new Map<string, SearchHit>(); // Dedup by thread ID

    for (const q of queries) {
      try {
        let pageToken: string | undefined;
        let fetched = 0;

        while (fetched < maxResults) {
          const result = await this.gmail.users.threads.list({
            userId: 'me',
            q,
            maxResults: Math.min(maxResults - fetched, 100),
            ...(pageToken ? { pageToken } : {}),
          });

          const threads = result.data.threads ?? [];
          if (threads.length === 0) break;

          for (const t of threads) {
            if (!t.id || allHits.has(t.id)) continue;
            if (allHits.size >= maxResults) break;

            const state = getThreadExtractionState(this.db, t.id);

            allHits.set(t.id, {
              id: t.id,
              source: 'gmail',
              title: '', // Will be populated from snippet
              snippet: t.snippet ?? '',
              date: '',
              participants: [],
              memoryHit: state !== null,
            });
            fetched++;
          }

          pageToken = result.data.nextPageToken ?? undefined;
          if (!pageToken) break;
        }
      } catch (error) {
        logger.debug({ error: error instanceof Error ? error.message : String(error), query: q }, 'Gmail search failed');
      }
    }

    return Array.from(allHits.values());
  }
}

// ── Fireflies Adapter ──

export class FirefliesAdapter implements SearchAdapter {
  name = 'fireflies';

  constructor(private client: FirefliesClient) {}

  async search(plan: SourcePlan, maxResults: number): Promise<SearchHit[]> {
    try {
      const fromDate = plan.daysBack
        ? new Date(Date.now() - plan.daysBack * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

      // One page only to avoid pagination bottleneck
      const transcripts = await this.client.listTranscripts({
        limit: Math.min(maxResults, 50),
        fromDate,
      });

      // Client-side keyword filter if keywords provided
      const keywords = plan.keywords ?? [];
      const filtered = keywords.length > 0
        ? transcripts.filter(t => {
            const text = `${t.title} ${t.participants.join(' ')} ${t.speakers.map(s => s.name).join(' ')}`.toLowerCase();
            return keywords.some(k => text.includes(k.toLowerCase()));
          })
        : transcripts;

      return filtered.slice(0, maxResults).map(t => ({
        id: t.id,
        source: 'fireflies',
        title: t.title,
        snippet: `${t.title} — ${t.speakers.map(s => s.name).join(', ')}`,
        date: new Date(t.date).toISOString(),
        participants: [...t.participants, ...t.speakers.map(s => s.name)],
        memoryHit: false, // Could check DB but not critical for v1
      }));
    } catch (error) {
      logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Fireflies search failed');
      return [];
    }
  }
}

// ── Slack Adapter ──

export class SlackAdapter implements SearchAdapter {
  name = 'slack';

  constructor(
    private botClient: WebClient,
    private userClient?: WebClient,
  ) {}

  async search(plan: SourcePlan, maxResults: number): Promise<SearchHit[]> {
    const client = this.userClient ?? this.botClient;
    const query = plan.query ?? plan.queries?.[0] ?? '';
    if (!query) return [];

    try {
      const result = await client.search.messages({
        query,
        count: Math.min(maxResults, 100),
        sort: 'timestamp',
        sort_dir: 'desc',
      });

      const matches = (result.messages as any)?.matches ?? [];

      return matches.slice(0, maxResults).map((m: any) => ({
        id: m.ts ?? m.iid ?? `slack-${Date.now()}`,
        source: 'slack',
        title: m.channel?.name ? `#${m.channel.name}` : 'DM',
        snippet: (m.text ?? '').slice(0, 300),
        date: m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString() : '',
        participants: m.username ? [m.username] : [],
        memoryHit: false,
      }));
    } catch (error) {
      logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Slack search failed');
      return [];
    }
  }
}

// ── Drive Adapter ──

export class DriveAdapter implements SearchAdapter {
  name = 'drive';

  constructor(private drive: drive_v3.Drive) {}

  async search(plan: SourcePlan, maxResults: number): Promise<SearchHit[]> {
    const queryText = plan.query ?? plan.queries?.[0] ?? '';
    if (!queryText) return [];

    try {
      const safeQuery = queryText.replace(/[^a-zA-Z0-9\s.\-_']/g, '');
      const q = `(name contains '${safeQuery}' or fullText contains '${safeQuery}') and trashed = false`;

      const result = await this.drive.files.list({
        q,
        pageSize: Math.min(maxResults, 50),
        fields: 'files(id, name, mimeType, modifiedTime, owners)',
        orderBy: 'modifiedTime desc',
      });

      const files = result.data.files ?? [];
      return files.map(f => ({
        id: f.id!,
        source: 'drive',
        title: f.name ?? 'Untitled',
        snippet: `${f.name} (${f.mimeType?.split('.').pop() ?? 'file'})`,
        date: f.modifiedTime ?? '',
        participants: f.owners?.map(o => o.displayName ?? '') ?? [],
        memoryHit: false,
      }));
    } catch (error) {
      logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Drive search failed');
      return [];
    }
  }
}

// ── Memory Adapter ──

export class MemoryAdapter implements SearchAdapter {
  name = 'memory';

  constructor(private db: DatabaseSync) {}

  async search(plan: SourcePlan, maxResults: number): Promise<SearchHit[]> {
    const ftsQuery = plan.ftsQuery ?? plan.query ?? '';
    if (!ftsQuery) return [];

    try {
      const results = searchMemories(this.db, ftsQuery, {
        limit: Math.min(maxResults, 50),
        type: plan.types?.[0] as MemoryType | undefined,
        sourcePrefix: plan.sourcePrefix,
      });

      return results.map(m => ({
        id: m.id,
        source: 'memory',
        title: `[${m.type}] from ${m.source.split(':')[0]}`,
        snippet: m.content.slice(0, 300),
        date: m.created_at,
        participants: JSON.parse(m.entities ?? '[]'),
        memoryHit: true,
      }));
    } catch (error) {
      logger.debug({ error: error instanceof Error ? error.message : String(error) }, 'Memory search failed');
      return [];
    }
  }
}
