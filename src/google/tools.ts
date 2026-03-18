/**
 * Google Workspace Tools — Calendar, Gmail, Drive.
 *
 * Same pattern as Slack tools: Anthropic tool definitions + handler functions.
 * Called directly in the agent loop, no MCP overhead.
 *
 * Tools:
 *   google_calendar_list_events  — list upcoming events
 *   google_calendar_create_event — create a calendar event
 *   google_calendar_find_free    — find free time slots
 *   google_gmail_search          — search emails
 *   google_gmail_read            — read a specific email
 *   google_gmail_send_draft      — create a draft email
 *   google_drive_search          — search files in Drive
 *   google_drive_get_file        — get file metadata/content
 */

import { google } from 'googleapis';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolHandlerResult } from '../mcp/slack/server.js';
import { logger } from '../logger.js';
import { scanForSecrets } from '../security/output-sanitizer.js';

/** Free/busy period from the Calendar API */
interface BusyPeriod { start: string; end: string; }

/** Calendar free/busy entry from the freebusy API */
interface CalendarBusy { busy: BusyPeriod[]; }

/** Sanitize error messages to avoid leaking secrets from Google API responses */
function sanitizeErrorMessage(msg: string): string {
  const scan = scanForSecrets(msg);
  return scan.hasSecrets ? scan.redacted : msg;
}

export interface GoogleTool {
  definition: Anthropic.Tool;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
}

/**
 * Recursively extract text/plain body from a Gmail message payload.
 * Handles nested multipart structures (multipart/mixed → multipart/alternative → text/plain).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractTextFromPayload(payload: any): string {
  if (!payload) return '';

  // Direct body (simple messages)
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    if (payload.mimeType === 'text/plain' || !payload.parts) {
      return decoded;
    }
  }

  // Recurse into parts
  if (payload.parts && Array.isArray(payload.parts)) {
    // Prefer text/plain over text/html
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
      }
    }
    // Recurse into multipart containers
    for (const part of payload.parts) {
      if (part.mimeType?.startsWith('multipart/') || part.parts) {
        const found = extractTextFromPayload(part);
        if (found) return found;
      }
    }
    // Last resort: try text/html and strip tags
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) {
        const html = Buffer.from(part.body.data, 'base64').toString('utf-8');
        return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    // Recurse into any nested part that might have text
    for (const part of payload.parts) {
      const found = extractTextFromPayload(part);
      if (found) return found;
    }
  }

  return '';
}

/**
 * Create Google Workspace tools backed by an authenticated OAuth2 client.
 */
export function createGoogleTools(
  auth: InstanceType<typeof google.auth.OAuth2>,
): GoogleTool[] {
  const calendar = google.calendar({ version: 'v3', auth });
  const gmail = google.gmail({ version: 'v1', auth });
  const drive = google.drive({ version: 'v3', auth });

  return [
    // ── Calendar: List Events ──
    {
      definition: {
        name: 'google_calendar_list_events',
        description:
          'List upcoming calendar events. Returns event titles, times, attendees, and locations.',
        input_schema: {
          type: 'object' as const,
          properties: {
            days_ahead: { type: 'number', description: 'Number of days ahead to look (default 7, max 30)' },
            max_results: { type: 'number', description: 'Max events to return (default 10, max 50)' },
            query: { type: 'string', description: 'Optional search query to filter events' },
          },
          required: [],
        },
      },
      handler: async (args) => {
        const daysAhead = Math.min((args.days_ahead as number) ?? 7, 30);
        const maxResults = Math.min((args.max_results as number) ?? 10, 50);
        const query = args.query as string | undefined;

        try {
          const now = new Date();
          const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

          const result = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now.toISOString(),
            timeMax: future.toISOString(),
            maxResults,
            singleEvents: true,
            orderBy: 'startTime',
            q: query,
          });

          const events = result.data.items ?? [];
          if (events.length === 0) {
            return { content: `No events found in the next ${daysAhead} days.` };
          }

          const lines = events.map(e => {
            const start = e.start?.dateTime ?? e.start?.date ?? 'unknown';
            const end = e.end?.dateTime ?? e.end?.date ?? '';
            const attendees = (e.attendees ?? []).map(a => a.email).filter(Boolean).join(', ');
            const location = e.location ? ` | Location: ${e.location}` : '';
            const attendeeStr = attendees ? ` | Attendees: ${attendees}` : '';
            return `- ${e.summary ?? 'Untitled'} | ${start} → ${end}${location}${attendeeStr} | ID: ${e.id}`;
          });

          return { content: `${events.length} events in the next ${daysAhead} days:\n${lines.join('\n')}` };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Calendar error: ${msg}`, isError: true };
        }
      },
    },

    // ── Calendar: Create Event ──
    {
      definition: {
        name: 'google_calendar_create_event',
        description:
          'Create a new calendar event. Specify title, start/end times, and optionally attendees and location.',
        input_schema: {
          type: 'object' as const,
          properties: {
            summary: { type: 'string', description: 'Event title' },
            start_time: { type: 'string', description: 'Start time (ISO 8601, e.g. 2026-03-20T10:00:00-07:00)' },
            end_time: { type: 'string', description: 'End time (ISO 8601)' },
            attendees: { type: 'array', items: { type: 'string' }, description: 'List of attendee email addresses' },
            location: { type: 'string', description: 'Event location' },
            description: { type: 'string', description: 'Event description/notes' },
          },
          required: ['summary', 'start_time', 'end_time'],
        },
      },
      handler: async (args) => {
        const summary = args.summary as string;
        const startTime = args.start_time as string;
        const endTime = args.end_time as string;
        const attendees = (args.attendees as string[] | undefined)?.map(email => ({ email }));
        const location = args.location as string | undefined;
        const description = args.description as string | undefined;

        try {
          const result = await calendar.events.insert({
            calendarId: 'primary',
            requestBody: {
              summary,
              start: { dateTime: startTime },
              end: { dateTime: endTime },
              attendees,
              location,
              description,
            },
          });

          return {
            content: `Event created: "${summary}" on ${startTime} (ID: ${result.data.id})`,
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to create event: ${msg}`, isError: true };
        }
      },
    },

    // ── Calendar: Delete/Cancel Event ──
    {
      definition: {
        name: 'google_calendar_delete_event',
        description:
          'Delete or cancel a calendar event by its event ID. Always confirm with the owner before deleting.',
        input_schema: {
          type: 'object' as const,
          properties: {
            event_id: { type: 'string', description: 'Google Calendar event ID (from list_events results)' },
            send_updates: { type: 'string', enum: ['all', 'externalOnly', 'none'], description: 'Who to notify about the cancellation (default: all)' },
          },
          required: ['event_id'],
        },
      },
      handler: async (args) => {
        const eventId = args.event_id as string;
        const sendUpdates = (args.send_updates as string) ?? 'all';

        try {
          // Get event details first for confirmation message
          const event = await calendar.events.get({
            calendarId: 'primary',
            eventId,
          });

          await calendar.events.delete({
            calendarId: 'primary',
            eventId,
            sendUpdates: sendUpdates as 'all' | 'externalOnly' | 'none',
          });

          return {
            content: `Event cancelled: "${event.data.summary ?? 'Untitled'}" (${event.data.start?.dateTime ?? event.data.start?.date ?? 'unknown time'}). Notifications sent: ${sendUpdates}.`,
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to cancel event: ${msg}`, isError: true };
        }
      },
    },

    // ── Calendar: Update Event ──
    {
      definition: {
        name: 'google_calendar_update_event',
        description:
          'Update an existing calendar event — change title, time, attendees, or location.',
        input_schema: {
          type: 'object' as const,
          properties: {
            event_id: { type: 'string', description: 'Google Calendar event ID' },
            summary: { type: 'string', description: 'New event title (optional)' },
            start_time: { type: 'string', description: 'New start time ISO 8601 (optional)' },
            end_time: { type: 'string', description: 'New end time ISO 8601 (optional)' },
            location: { type: 'string', description: 'New location (optional)' },
            description: { type: 'string', description: 'New description (optional)' },
            add_attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to add (optional)' },
          },
          required: ['event_id'],
        },
      },
      handler: async (args) => {
        const eventId = args.event_id as string;

        try {
          // Get current event
          const current = await calendar.events.get({
            calendarId: 'primary',
            eventId,
          });

          const patch: Record<string, unknown> = {};
          if (args.summary) patch.summary = args.summary;
          if (args.start_time) patch.start = { dateTime: args.start_time as string };
          if (args.end_time) patch.end = { dateTime: args.end_time as string };
          if (args.location) patch.location = args.location;
          if (args.description) patch.description = args.description;
          if (args.add_attendees) {
            const existing = current.data.attendees ?? [];
            const newAttendees = (args.add_attendees as string[]).map(email => ({ email }));
            patch.attendees = [...existing, ...newAttendees];
          }

          const result = await calendar.events.patch({
            calendarId: 'primary',
            eventId,
            requestBody: patch,
          });

          return {
            content: `Event updated: "${result.data.summary}" (ID: ${eventId})`,
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to update event: ${msg}`, isError: true };
        }
      },
    },

    // ── Calendar: Find Free Time ──
    {
      definition: {
        name: 'google_calendar_find_free',
        description:
          'Find free time slots in the calendar. Returns available blocks between events.',
        input_schema: {
          type: 'object' as const,
          properties: {
            days_ahead: { type: 'number', description: 'Days to look ahead (default 3, max 14)' },
            min_duration_minutes: { type: 'number', description: 'Minimum slot duration in minutes (default 30)' },
            start_hour: { type: 'number', description: 'Earliest hour to consider (default 9, 24h format)' },
            end_hour: { type: 'number', description: 'Latest hour to consider (default 17, 24h format)' },
          },
          required: [],
        },
      },
      handler: async (args) => {
        const daysAhead = Math.min((args.days_ahead as number) ?? 3, 14);
        const minMinutes = (args.min_duration_minutes as number) ?? 30;
        const startHour = (args.start_hour as number) ?? 9;
        const endHour = (args.end_hour as number) ?? 17;

        try {
          const now = new Date();
          const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

          const result = await calendar.events.list({
            calendarId: 'primary',
            timeMin: now.toISOString(),
            timeMax: future.toISOString(),
            singleEvents: true,
            orderBy: 'startTime',
            maxResults: 100,
          });

          const events = (result.data.items ?? []).map(e => ({
            start: new Date(e.start?.dateTime ?? e.start?.date ?? ''),
            end: new Date(e.end?.dateTime ?? e.end?.date ?? ''),
          }));

          // Find gaps between events within working hours
          const slots: string[] = [];
          for (let d = 0; d < daysAhead; d++) {
            const day = new Date(now);
            day.setDate(day.getDate() + d);
            day.setHours(startHour, 0, 0, 0);
            const dayEnd = new Date(day);
            dayEnd.setHours(endHour, 0, 0, 0);

            if (dayEnd <= now) continue;

            const dayStart = d === 0 ? new Date(Math.max(now.getTime(), day.getTime())) : day;

            // Get events on this day
            const dayEvents = events
              .filter(e => e.start < dayEnd && e.end > dayStart)
              .sort((a, b) => a.start.getTime() - b.start.getTime());

            let cursor = dayStart;
            for (const event of dayEvents) {
              if (event.start > cursor) {
                const gapMinutes = (event.start.getTime() - cursor.getTime()) / 60000;
                if (gapMinutes >= minMinutes) {
                  slots.push(`${cursor.toLocaleString()} → ${event.start.toLocaleString()} (${Math.round(gapMinutes)} min)`);
                }
              }
              cursor = new Date(Math.max(cursor.getTime(), event.end.getTime()));
            }
            // Gap after last event
            if (cursor < dayEnd) {
              const gapMinutes = (dayEnd.getTime() - cursor.getTime()) / 60000;
              if (gapMinutes >= minMinutes) {
                slots.push(`${cursor.toLocaleString()} → ${dayEnd.toLocaleString()} (${Math.round(gapMinutes)} min)`);
              }
            }
          }

          if (slots.length === 0) {
            return { content: `No free slots of ${minMinutes}+ minutes found in the next ${daysAhead} days (${startHour}:00-${endHour}:00).` };
          }

          return { content: `Free slots (${minMinutes}+ min, ${startHour}:00-${endHour}:00):\n${slots.join('\n')}` };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Calendar error: ${msg}`, isError: true };
        }
      },
    },

    // ── Gmail: Search ──
    // Searches by THREAD (not message) so each result is a unique conversation.
    // This prevents long threads from consuming multiple result slots and ensures
    // outbound-only emails (sent with no reply) are not crowded out.
    {
      definition: {
        name: 'google_gmail_search',
        description:
          'Search Gmail for email threads matching a query. Uses Gmail search syntax (from:, to:, subject:, after:, before:, has:attachment, label:, is:, in:sent, etc.). ' +
          'Each result is a unique conversation thread (not individual messages). ' +
          'Returns up to max_results threads (default 25, max 75). For comprehensive sweeps, use multiple searches with different queries or date ranges. ' +
          'To find emails you sent, include "in:sent" or "from:me" in the query.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Gmail search query (e.g. "from:sarah subject:budget after:2026/02/15", "in:sent after:2026/02/15")' },
            max_results: { type: 'number', description: 'Max threads to return (default 25, max 75). Use high values for comprehensive sweeps.' },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = args.query as string;
        const maxResults = Math.min((args.max_results as number) ?? 25, 75);

        try {
          // Paginate through THREADS (not messages) — each result is a unique conversation
          const allThreads: Array<{ id: string; snippet?: string }> = [];
          let pageToken: string | undefined;

          while (allThreads.length < maxResults) {
            const result = await gmail.users.threads.list({
              userId: 'me',
              q: query,
              maxResults: Math.min(maxResults - allThreads.length, 100),
              ...(pageToken ? { pageToken } : {}),
            });

            const threads = result.data.threads ?? [];
            if (threads.length === 0) break;

            for (const t of threads) {
              if (allThreads.length >= maxResults) break;
              allThreads.push({ id: t.id!, snippet: t.snippet ?? undefined });
            }

            pageToken = result.data.nextPageToken ?? undefined;
            if (!pageToken) break;
          }

          if (allThreads.length === 0) {
            return { content: `No emails found for "${query}".` };
          }

          // Fetch metadata for the first message of each thread in parallel
          // (threads.list only gives snippet — we need From/Subject/Date)
          const details = await Promise.all(
            allThreads.map(t =>
              gmail.users.threads.get({
                userId: 'me',
                id: t.id,
                format: 'metadata',
                metadataHeaders: ['From', 'To', 'Subject', 'Date'],
              })
            )
          );

          const summaries = details.map((detail, i) => {
            const messages = detail.data.messages ?? [];
            const msgCount = messages.length;
            // Use first message for subject, last message for most recent date/sender
            const firstMsg = messages[0];
            const lastMsg = messages[messages.length - 1] ?? firstMsg;

            const firstHeaders = firstMsg?.payload?.headers ?? [];
            const lastHeaders = lastMsg?.payload?.headers ?? [];

            const subject = firstHeaders.find(h => h.name === 'Subject')?.value ?? 'no subject';
            const from = lastHeaders.find(h => h.name === 'From')?.value ?? 'unknown';
            const date = lastHeaders.find(h => h.name === 'Date')?.value ?? '';
            const snippet = detail.data.messages?.[messages.length - 1]?.snippet ?? allThreads[i].snippet ?? '';
            const threadLabel = msgCount > 1 ? ` (${msgCount} messages)` : '';

            return `- **${subject}**${threadLabel} | Last: ${from} | ${date} | Thread ID: ${allThreads[i].id}\n  ${snippet.slice(0, 300)}`;
          });

          const moreAvailable = pageToken ? ` (more results available — refine query or increase max_results)` : '';

          return {
            content: `Found ${allThreads.length} threads for "${query}"${moreAvailable}:\n\n${summaries.join('\n')}`,
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Gmail error: ${msg}`, isError: true };
        }
      },
    },

    // ── Gmail: Read ──
    // Accepts thread IDs directly (from search results) or message IDs (legacy).
    // Thread IDs skip the message→thread lookup hop, saving an API call per thread.
    {
      definition: {
        name: 'google_gmail_read',
        description:
          'Read one or more email threads with all replies. ' +
          'Accepts thread_id/thread_ids (from search results — preferred, faster) or message_id/message_ids (legacy). ' +
          'Use to check multiple conversations at once (e.g., scanning for outstanding items). ' +
          'For comprehensive sweeps, read ALL threads from search results — don\'t rely on snippets.',
        input_schema: {
          type: 'object' as const,
          properties: {
            thread_id: { type: 'string', description: 'Gmail thread ID (from search results — preferred)' },
            thread_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Multiple Gmail thread IDs to read in parallel (max 15)',
            },
            message_id: { type: 'string', description: 'Gmail message ID (legacy — will look up thread)' },
            message_ids: {
              type: 'array',
              items: { type: 'string' },
              description: 'Multiple Gmail message IDs to read in parallel (max 15, legacy)',
            },
          },
          required: [],
        },
      },
      handler: async (args) => {
        // Collect thread IDs directly if provided
        let threadIds: string[] = args.thread_ids
          ? (args.thread_ids as string[]).slice(0, 15)
          : args.thread_id
            ? [args.thread_id as string]
            : [];

        // Fall back to message IDs (legacy path — needs extra API call per ID)
        if (threadIds.length === 0) {
          const msgIds: string[] = args.message_ids
            ? (args.message_ids as string[]).slice(0, 15)
            : args.message_id
              ? [args.message_id as string]
              : [];

          if (msgIds.length === 0) {
            return { content: 'No thread or message ID provided. Use thread_id, thread_ids, message_id, or message_ids.', isError: true };
          }

          // Look up thread IDs from message IDs
          const lookups = await Promise.all(msgIds.map(async (id) => {
            try {
              const msg = await gmail.users.messages.get({
                userId: 'me', id, format: 'metadata', metadataHeaders: ['Subject'],
              });
              return msg.data.threadId ?? null;
            } catch { return null; }
          }));

          // Deduplicate thread IDs (multiple messages may be in the same thread)
          const seen = new Set<string>();
          for (const tid of lookups) {
            if (tid && !seen.has(tid)) {
              seen.add(tid);
              threadIds.push(tid);
            }
          }
        }

        if (threadIds.length === 0) {
          return { content: 'Could not resolve any thread IDs.', isError: true };
        }

        try {
          // Fetch all threads in parallel (direct — no intermediate lookup)
          const threadResults = await Promise.all(threadIds.map(async (threadId) => {
            try {
              const thread = await gmail.users.threads.get({
                userId: 'me',
                id: threadId,
                format: 'full',
              });
              return thread.data.messages ?? [];
            } catch {
              return null;
            }
          }));

          // Format results
          const allFormattedThreads: string[] = [];

          for (const messages of threadResults) {
            if (!messages) {
              allFormattedThreads.push('--- Thread not found ---');
              continue;
            }

            const parts: string[] = [];
            for (const message of messages) {
              const headers = message.payload?.headers ?? [];
              const from = headers.find(h => h.name === 'From')?.value ?? 'unknown';
              const to = headers.find(h => h.name === 'To')?.value ?? '';
              const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
              const date = headers.find(h => h.name === 'Date')?.value ?? '';

              const body = extractTextFromPayload(message.payload);

              const truncated = body.length > 4000;
              parts.push(
                `--- Message (${date}) ---\n` +
                `From: ${from}\nTo: ${to}\n` +
                (subject ? `Subject: ${subject}\n` : '') +
                `\n[EXTERNAL CONTENT]\n${body.slice(0, 4000)}${truncated ? '\n[...truncated]' : ''}\n[/EXTERNAL CONTENT]`
              );
            }

            const threadLabel = messages.length > 1
              ? `Thread with ${messages.length} messages:`
              : 'Single message (no replies):';
            allFormattedThreads.push(`${threadLabel}\n\n${parts.join('\n\n')}`);
          }

          return {
            content: allFormattedThreads.join('\n\n=== Next Thread ===\n\n'),
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Gmail error: ${msg}`, isError: true };
        }
      },
    },

    // ── Gmail: Create Draft ──
    {
      definition: {
        name: 'google_gmail_draft',
        description:
          'Create a draft email. Does NOT send it — creates a draft for review. ' +
          'Always use this instead of sending directly.',
        input_schema: {
          type: 'object' as const,
          properties: {
            to: { type: 'string', description: 'Recipient email address' },
            subject: { type: 'string', description: 'Email subject' },
            body: { type: 'string', description: 'Email body (plain text)' },
            cc: { type: 'string', description: 'CC email addresses (comma-separated)' },
          },
          required: ['to', 'subject', 'body'],
        },
      },
      handler: async (args) => {
        const to = args.to as string;
        const subject = args.subject as string;
        const body = args.body as string;
        const cc = args.cc as string | undefined;

        try {
          const headers = [
            `To: ${to}`,
            `Subject: ${subject}`,
            cc ? `Cc: ${cc}` : null,
            'Content-Type: text/plain; charset=utf-8',
            '',
            body,
          ].filter(Boolean).join('\r\n');

          const encoded = Buffer.from(headers).toString('base64url');

          const result = await gmail.users.drafts.create({
            userId: 'me',
            requestBody: {
              message: { raw: encoded },
            },
          });

          return {
            content: `Draft created: "${subject}" to ${to} (Draft ID: ${result.data.id}). Review and send from Gmail.`,
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Gmail error: ${msg}`, isError: true };
        }
      },
    },

    // ── Calendar: RSVP to Event ──
    {
      definition: {
        name: 'google_calendar_rsvp',
        description: 'Respond to a calendar invite — accept, decline, or tentative.',
        input_schema: {
          type: 'object' as const,
          properties: {
            event_id: { type: 'string', description: 'Google Calendar event ID' },
            response: { type: 'string', enum: ['accepted', 'declined', 'tentative'], description: 'Your response' },
          },
          required: ['event_id', 'response'],
        },
      },
      handler: async (args) => {
        const eventId = args.event_id as string;
        const response = args.response as string;

        try {
          // Get event to find our attendee entry
          const event = await calendar.events.get({ calendarId: 'primary', eventId });
          const attendees = event.data.attendees ?? [];

          // Find self in attendees and update response
          const selfAttendee = attendees.find(a => a.self);
          if (selfAttendee) {
            selfAttendee.responseStatus = response;
          } else {
            // We're the organizer or not in attendees — still update
            attendees.push({ self: true, responseStatus: response });
          }

          await calendar.events.patch({
            calendarId: 'primary',
            eventId,
            requestBody: { attendees },
          });

          return {
            content: `RSVP'd "${response}" to "${event.data.summary ?? 'event'}"`,
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to RSVP: ${msg}`, isError: true };
        }
      },
    },

    // ── Calendar: Check Free/Busy for Others ──
    {
      definition: {
        name: 'google_calendar_freebusy',
        description:
          'Check free/busy status for one or more people. Useful for finding mutual availability.',
        input_schema: {
          type: 'object' as const,
          properties: {
            emails: { type: 'array', items: { type: 'string' }, description: 'Email addresses to check' },
            days_ahead: { type: 'number', description: 'Days to look ahead (default 3, max 14)' },
          },
          required: ['emails'],
        },
      },
      handler: async (args) => {
        const emails = args.emails as string[];
        const daysAhead = Math.min((args.days_ahead as number) ?? 3, 14);

        try {
          const now = new Date();
          const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

          const result = await calendar.freebusy.query({
            requestBody: {
              timeMin: now.toISOString(),
              timeMax: future.toISOString(),
              items: emails.map(id => ({ id })),
            },
          });

          const calendars = result.data.calendars ?? {};
          const lines: string[] = [];

          for (const [email, cal] of Object.entries(calendars)) {
            const busy = (cal as CalendarBusy).busy ?? [];
            if (busy.length === 0) {
              lines.push(`${email}: Free for the next ${daysAhead} days`);
            } else {
              const blocks = busy.map((b: BusyPeriod) =>
                `  - Busy: ${new Date(b.start).toLocaleString()} → ${new Date(b.end).toLocaleString()}`
              ).join('\n');
              lines.push(`${email}:\n${blocks}`);
            }
          }

          return { content: `Free/busy for next ${daysAhead} days:\n\n${lines.join('\n\n')}` };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Free/busy check failed: ${msg}`, isError: true };
        }
      },
    },

    // ── Calendar: Get Event Details ──
    {
      definition: {
        name: 'google_calendar_get_event',
        description: 'Get full details of a specific calendar event by ID.',
        input_schema: {
          type: 'object' as const,
          properties: {
            event_id: { type: 'string', description: 'Google Calendar event ID' },
          },
          required: ['event_id'],
        },
      },
      handler: async (args) => {
        const eventId = args.event_id as string;

        try {
          const result = await calendar.events.get({ calendarId: 'primary', eventId });
          const e = result.data;
          const attendees = (e.attendees ?? []).map(a =>
            `${a.email} (${a.responseStatus ?? 'unknown'}${a.organizer ? ', organizer' : ''})`
          ).join(', ');

          const lines = [
            `Title: ${e.summary ?? 'Untitled'}`,
            `Start: ${e.start?.dateTime ?? e.start?.date ?? 'unknown'}`,
            `End: ${e.end?.dateTime ?? e.end?.date ?? 'unknown'}`,
            e.location ? `Location: ${e.location}` : null,
            e.description ? `Description: ${e.description}` : null,
            attendees ? `Attendees: ${attendees}` : null,
            `Status: ${e.status}`,
            e.hangoutLink ? `Meet link: ${e.hangoutLink}` : null,
            `ID: ${e.id}`,
          ].filter(Boolean);

          return { content: lines.join('\n') };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to get event: ${msg}`, isError: true };
        }
      },
    },

    // ── Gmail: Send Draft ──
    {
      definition: {
        name: 'google_gmail_send_draft',
        description:
          'Send a previously created draft email. Use google_gmail_draft first to create it, ' +
          'confirm with the owner, then send with this tool.',
        input_schema: {
          type: 'object' as const,
          properties: {
            draft_id: { type: 'string', description: 'Draft ID (from google_gmail_draft result)' },
          },
          required: ['draft_id'],
        },
      },
      handler: async (args) => {
        const draftId = args.draft_id as string;

        try {
          const result = await gmail.users.drafts.send({
            userId: 'me',
            requestBody: { id: draftId },
          });

          return {
            content: `Email sent (Message ID: ${result.data.id}). Draft has been removed.`,
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to send draft: ${msg}`, isError: true };
        }
      },
    },

    // ── Gmail: Reply ──
    {
      definition: {
        name: 'google_gmail_reply',
        description:
          'Reply to an email thread. Creates a draft reply — confirm with owner before sending.',
        input_schema: {
          type: 'object' as const,
          properties: {
            message_id: { type: 'string', description: 'Message ID to reply to' },
            body: { type: 'string', description: 'Reply body text' },
            reply_all: { type: 'boolean', description: 'Reply to all recipients (default: false)' },
          },
          required: ['message_id', 'body'],
        },
      },
      handler: async (args) => {
        const messageId = args.message_id as string;
        const body = args.body as string;
        const replyAll = (args.reply_all as boolean) ?? false;

        try {
          // Get original message for headers
          const original = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'metadata',
            metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID'],
          });

          const headers = original.data.payload?.headers ?? [];
          const from = headers.find(h => h.name === 'From')?.value ?? '';
          const to = headers.find(h => h.name === 'To')?.value ?? '';
          const cc = headers.find(h => h.name === 'Cc')?.value;
          const subject = headers.find(h => h.name === 'Subject')?.value ?? '';
          const messageIdHeader = headers.find(h => h.name === 'Message-ID')?.value ?? '';
          const threadId = original.data.threadId;

          const replyTo = replyAll ? `${from}, ${to}` : from;
          const replyCc = replyAll && cc ? cc : undefined;
          const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;

          const rawHeaders = [
            `To: ${replyTo}`,
            `Subject: ${replySubject}`,
            replyCc ? `Cc: ${replyCc}` : null,
            `In-Reply-To: ${messageIdHeader}`,
            `References: ${messageIdHeader}`,
            'Content-Type: text/plain; charset=utf-8',
            '',
            body,
          ].filter(Boolean).join('\r\n');

          const encoded = Buffer.from(rawHeaders).toString('base64url');

          const result = await gmail.users.drafts.create({
            userId: 'me',
            requestBody: {
              message: { raw: encoded, threadId: threadId ?? undefined },
            },
          });

          return {
            content: `Reply draft created to ${from} | Subject: "${replySubject}" (Draft ID: ${result.data.id}). Review and send with google_gmail_send_draft.`,
          };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to create reply: ${msg}`, isError: true };
        }
      },
    },

    // ── Gmail: Manage Labels ──
    {
      definition: {
        name: 'google_gmail_label',
        description:
          'Add or remove labels on an email. Common labels: STARRED, IMPORTANT, INBOX, TRASH, SPAM, UNREAD.',
        input_schema: {
          type: 'object' as const,
          properties: {
            message_id: { type: 'string', description: 'Gmail message ID' },
            add_labels: { type: 'array', items: { type: 'string' }, description: 'Labels to add (e.g. ["STARRED", "IMPORTANT"])' },
            remove_labels: { type: 'array', items: { type: 'string' }, description: 'Labels to remove (e.g. ["UNREAD", "INBOX"] to archive+mark read)' },
          },
          required: ['message_id'],
        },
      },
      handler: async (args) => {
        const messageId = args.message_id as string;
        const addLabels = (args.add_labels as string[]) ?? [];
        const removeLabels = (args.remove_labels as string[]) ?? [];

        try {
          await gmail.users.messages.modify({
            userId: 'me',
            id: messageId,
            requestBody: {
              addLabelIds: addLabels,
              removeLabelIds: removeLabels,
            },
          });

          const actions: string[] = [];
          if (addLabels.length) actions.push(`Added: ${addLabels.join(', ')}`);
          if (removeLabels.length) actions.push(`Removed: ${removeLabels.join(', ')}`);

          return { content: `Labels updated on message ${messageId}. ${actions.join('. ')}` };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Failed to update labels: ${msg}`, isError: true };
        }
      },
    },

    // ── Drive: Search ──
    {
      definition: {
        name: 'google_drive_search',
        description:
          'Search Google Drive for files and folders by name and content. Returns names, types, owners, and last modified dates. ' +
          'Searches both file names and document content by default. For comprehensive sweeps, set max_results high.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query — searches both file names and content by default' },
            max_results: { type: 'number', description: 'Max results (default 20, max 50). Use high values for comprehensive sweeps.' },
            type: { type: 'string', enum: ['document', 'spreadsheet', 'presentation', 'folder', 'any'], description: 'Filter by file type (default: any)' },
            search_content: { type: 'boolean', description: 'If true, search only file content (fullText). Default: searches both name and content.' },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = args.query as string;
        const maxResults = Math.min((args.max_results as number) ?? 20, 50);
        const fileType = args.type as string | undefined;
        const searchContent = (args.search_content as boolean) ?? false;

        try {
          const mimeFilter: Record<string, string> = {
            document: "mimeType = 'application/vnd.google-apps.document'",
            spreadsheet: "mimeType = 'application/vnd.google-apps.spreadsheet'",
            presentation: "mimeType = 'application/vnd.google-apps.presentation'",
            folder: "mimeType = 'application/vnd.google-apps.folder'",
          };

          // Sanitize: only allow alphanumeric, spaces, dots, dashes, underscores, apostrophes
          const safeQuery = query.replace(/[^a-zA-Z0-9\s.\-_']/g, '');
          // Search both name and content for thoroughness
          let q = searchContent
            ? `fullText contains '${safeQuery}'`
            : `(name contains '${safeQuery}' or fullText contains '${safeQuery}')`;
          if (fileType && mimeFilter[fileType]) {
            q += ` and ${mimeFilter[fileType]}`;
          }
          q += " and trashed = false";

          // Paginate through results
          const allFiles: Array<{
            id: string; name: string; mimeType: string;
            modifiedTime?: string; owners?: Array<{ displayName: string }>;
            parents?: string[]; webViewLink?: string;
          }> = [];
          let pageToken: string | undefined;

          while (allFiles.length < maxResults) {
            const result = await drive.files.list({
              q,
              pageSize: Math.min(maxResults - allFiles.length, 100),
              fields: 'nextPageToken, files(id, name, mimeType, modifiedTime, owners, parents, webViewLink)',
              orderBy: 'modifiedTime desc',
              ...(pageToken ? { pageToken } : {}),
            });

            const files = result.data.files ?? [];
            if (files.length === 0) break;

            for (const f of files) {
              if (allFiles.length >= maxResults) break;
              allFiles.push(f as typeof allFiles[0]);
            }

            pageToken = result.data.nextPageToken ?? undefined;
            if (!pageToken) break;
          }

          if (allFiles.length === 0) {
            return { content: `No files found for "${query}".` };
          }

          const files = allFiles;

          // Resolve parent folder names for context
          const parentIds = new Set<string>();
          for (const f of files) {
            if (f.parents?.[0]) parentIds.add(f.parents[0]);
          }
          const parentNames = new Map<string, string>();
          for (const pid of parentIds) {
            try {
              const parent = await drive.files.get({ fileId: pid, fields: 'name' });
              if (parent.data.name) parentNames.set(pid, parent.data.name);
            } catch { /* non-critical */ }
          }

          const lines = files.map(f => {
            const owner = f.owners?.[0]?.displayName ?? 'unknown';
            const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '';
            const type = f.mimeType?.split('.').pop() ?? 'file';
            const folder = f.parents?.[0] ? (parentNames.get(f.parents[0]) ?? '') : '';
            const folderLabel = folder ? ` | Folder: ${folder}` : '';
            return `- ${f.name} (${type}) | Modified: ${modified} | Owner: ${owner}${folderLabel} | ID: ${f.id}`;
          });

          const moreAvailable = pageToken ? ' (more results available — increase max_results or refine query)' : '';
          return { content: `Found ${files.length} files${moreAvailable}:\n${lines.join('\n')}` };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Drive error: ${msg}`, isError: true };
        }
      },
    },

    // ── Drive: Get File Info ──
    {
      definition: {
        name: 'google_drive_get_file',
        description: 'Get metadata and sharing info for a specific Drive file by ID.',
        input_schema: {
          type: 'object' as const,
          properties: {
            file_id: { type: 'string', description: 'Google Drive file ID' },
          },
          required: ['file_id'],
        },
      },
      handler: async (args) => {
        const fileId = args.file_id as string;

        try {
          const result = await drive.files.get({
            fileId,
            fields: 'id, name, mimeType, modifiedTime, createdTime, owners, permissions, webViewLink, size',
          });

          const f = result.data;
          const owner = f.owners?.[0]?.displayName ?? 'unknown';
          const perms = (f.permissions ?? []).map(p => `${p.emailAddress ?? p.type} (${p.role})`).join(', ');

          const lines = [
            `Name: ${f.name}`,
            `Type: ${f.mimeType}`,
            `Owner: ${owner}`,
            `Modified: ${f.modifiedTime}`,
            `Created: ${f.createdTime}`,
            f.size ? `Size: ${f.size} bytes` : null,
            `Link: ${f.webViewLink}`,
            perms ? `Sharing: ${perms}` : 'Sharing: private',
          ].filter(Boolean);

          return { content: lines.join('\n') };
        } catch (error) {
          const msg = sanitizeErrorMessage(error instanceof Error ? error.message : String(error));
          return { content: `Drive error: ${msg}`, isError: true };
        }
      },
    },
  ];
}
