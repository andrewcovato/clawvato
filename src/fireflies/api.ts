/**
 * Fireflies.ai GraphQL Client — thin fetch wrapper for the Fireflies API.
 *
 * Fireflies uses a GraphQL endpoint with Bearer token auth.
 * No npm package needed — just native fetch.
 *
 * Three tiers of data (mirroring Drive):
 *   Tier 1 (Index): metadata — title, date, duration, participants
 *   Tier 2 (Summary): Fireflies AI summary + action items
 *   Tier 3 (Deep Read): full transcript with sentences, speakers, timestamps
 */

import { logger } from '../logger.js';

const FIREFLIES_API_URL = 'https://api.fireflies.ai/graphql';

// ── Types ──

export interface TranscriptMeta {
  id: string;
  title: string;
  date: number;              // Unix timestamp (ms)
  duration: number;          // seconds
  organizer_email: string;
  participants: string[];
  speakers: Array<{ name: string }>;
}

export interface TranscriptSummary extends TranscriptMeta {
  summary: {
    overview: string;
    action_items: string;
    outline: string;
    shorthand_bullet: string;
  };
}

export interface Sentence {
  text: string;
  speaker_name: string;
  start_time: number;        // seconds
  end_time: number;
}

export interface TranscriptFull extends TranscriptSummary {
  sentences: Sentence[];
}

// ── GraphQL queries ──

const LIST_TRANSCRIPTS_QUERY = `
  query ListTranscripts($limit: Int, $skip: Int, $fromDate: DateTime, $toDate: DateTime) {
    transcripts(limit: $limit, skip: $skip, fromDate: $fromDate, toDate: $toDate) {
      id
      title
      date
      duration
      organizer_email
      participants
      speakers { name }
    }
  }
`;

const GET_SUMMARY_QUERY = `
  query GetSummary($id: String!) {
    transcript(id: $id) {
      id
      title
      date
      duration
      organizer_email
      participants
      speakers { name }
      summary {
        overview
        action_items
        outline
        shorthand_bullet
      }
    }
  }
`;

const GET_FULL_QUERY = `
  query GetFull($id: String!) {
    transcript(id: $id) {
      id
      title
      date
      duration
      organizer_email
      participants
      speakers { name }
      summary {
        overview
        action_items
        outline
        shorthand_bullet
      }
      sentences {
        text
        speaker_name
        start_time
        end_time
      }
    }
  }
`;

// ── Client ──

export class FirefliesClient {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Execute a GraphQL query against the Fireflies API.
   */
  private async query<T>(graphql: string, variables?: Record<string, unknown>): Promise<T> {
    const response = await fetch(FIREFLIES_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: graphql, variables }),
    });

    if (!response.ok) {
      throw new Error(`Fireflies API error: ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as { data?: T; errors?: Array<{ message: string }> };

    if (json.errors?.length) {
      throw new Error(`Fireflies GraphQL error: ${json.errors.map(e => e.message).join(', ')}`);
    }

    if (!json.data) {
      throw new Error('Fireflies API returned no data');
    }

    return json.data;
  }

  /**
   * Tier 1 — List recent transcripts (metadata only).
   */
  async listTranscripts(opts?: {
    limit?: number;
    skip?: number;
    fromDate?: string;  // ISO 8601
    toDate?: string;
  }): Promise<TranscriptMeta[]> {
    const variables: Record<string, unknown> = {
      limit: opts?.limit ?? 20,
      skip: opts?.skip ?? 0,
    };
    if (opts?.fromDate) variables.fromDate = opts.fromDate;
    if (opts?.toDate) variables.toDate = opts.toDate;

    const data = await this.query<{ transcripts: TranscriptMeta[] }>(
      LIST_TRANSCRIPTS_QUERY,
      variables,
    );

    return data.transcripts ?? [];
  }

  /**
   * Tier 2 — Get transcript summary (overview, action items, participants).
   */
  async getTranscriptSummary(id: string): Promise<TranscriptSummary> {
    const data = await this.query<{ transcript: TranscriptSummary }>(
      GET_SUMMARY_QUERY,
      { id },
    );

    if (!data.transcript) {
      throw new Error(`Transcript not found: ${id}`);
    }

    return data.transcript;
  }

  /**
   * Tier 3 — Get full transcript with sentences, speakers, timestamps.
   */
  async getTranscriptFull(id: string): Promise<TranscriptFull> {
    const data = await this.query<{ transcript: TranscriptFull }>(
      GET_FULL_QUERY,
      { id },
    );

    if (!data.transcript) {
      throw new Error(`Transcript not found: ${id}`);
    }

    return data.transcript;
  }

  /**
   * Search transcripts by keyword in title, participant names, and speaker names.
   * Fireflies API doesn't have server-side search, so we fetch transcripts
   * in pages and filter client-side until we have enough matches.
   */
  async searchTranscripts(
    query: string,
    opts?: { limit?: number; fromDate?: string; toDate?: string },
  ): Promise<TranscriptMeta[]> {
    const targetLimit = opts?.limit ?? 20;
    const q = query.toLowerCase();
    const filtered: TranscriptMeta[] = [];
    let skip = 0;
    const pageSize = 50;
    const maxPages = 5; // Safety cap: don't fetch more than 250 transcripts

    for (let page = 0; page < maxPages && filtered.length < targetLimit; page++) {
      const batch = await this.listTranscripts({
        limit: pageSize,
        skip,
        fromDate: opts?.fromDate,
        toDate: opts?.toDate,
      });

      if (batch.length === 0) break;

      for (const t of batch) {
        if (
          t.title.toLowerCase().includes(q) ||
          t.participants.some(p => p.toLowerCase().includes(q)) ||
          t.speakers.some(s => s.name.toLowerCase().includes(q))
        ) {
          filtered.push(t);
          if (filtered.length >= targetLimit) break;
        }
      }

      skip += pageSize;
      if (batch.length < pageSize) break; // No more pages
    }

    return filtered;
  }
}

/**
 * Format seconds as MM:SS or HH:MM:SS.
 */
export function formatTimestamp(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

/**
 * Format a Unix timestamp (ms) as a human-readable date.
 */
export function formatMeetingDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Format duration in seconds as a human-readable string.
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.round(seconds / 60);
  return m < 60 ? `${m}min` : `${Math.floor(m / 60)}h ${m % 60}min`;
}
