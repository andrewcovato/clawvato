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

export interface GoogleTool {
  definition: Anthropic.Tool;
  handler: (args: Record<string, unknown>) => Promise<ToolHandlerResult>;
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
          const msg = error instanceof Error ? error.message : String(error);
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
          const msg = error instanceof Error ? error.message : String(error);
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
          const msg = error instanceof Error ? error.message : String(error);
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
          const msg = error instanceof Error ? error.message : String(error);
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
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Calendar error: ${msg}`, isError: true };
        }
      },
    },

    // ── Gmail: Search ──
    {
      definition: {
        name: 'google_gmail_search',
        description:
          'Search Gmail for emails matching a query. Uses Gmail search syntax (from:, to:, subject:, has:attachment, etc.).',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Gmail search query (e.g. "from:sarah subject:budget")' },
            max_results: { type: 'number', description: 'Max emails to return (default 10, max 20)' },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = args.query as string;
        const maxResults = Math.min((args.max_results as number) ?? 10, 20);

        try {
          const result = await gmail.users.messages.list({
            userId: 'me',
            q: query,
            maxResults,
          });

          const messageIds = result.data.messages ?? [];
          if (messageIds.length === 0) {
            return { content: `No emails found for "${query}".` };
          }

          // Fetch headers for each message
          const summaries: string[] = [];
          for (const msg of messageIds.slice(0, maxResults)) {
            const detail = await gmail.users.messages.get({
              userId: 'me',
              id: msg.id!,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date'],
            });

            const headers = detail.data.payload?.headers ?? [];
            const from = headers.find(h => h.name === 'From')?.value ?? 'unknown';
            const subject = headers.find(h => h.name === 'Subject')?.value ?? 'no subject';
            const date = headers.find(h => h.name === 'Date')?.value ?? '';
            const snippet = detail.data.snippet ?? '';

            summaries.push(`- **${subject}** | From: ${from} | ${date}\n  ${snippet.slice(0, 150)}`);
          }

          return {
            content: `Found ${result.data.resultSizeEstimate ?? messageIds.length} emails for "${query}":\n\n${summaries.join('\n')}`,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Gmail error: ${msg}`, isError: true };
        }
      },
    },

    // ── Gmail: Read ──
    {
      definition: {
        name: 'google_gmail_read',
        description: 'Read the full content of a specific email by message ID.',
        input_schema: {
          type: 'object' as const,
          properties: {
            message_id: { type: 'string', description: 'Gmail message ID (from search results)' },
          },
          required: ['message_id'],
        },
      },
      handler: async (args) => {
        const messageId = args.message_id as string;

        try {
          const result = await gmail.users.messages.get({
            userId: 'me',
            id: messageId,
            format: 'full',
          });

          const headers = result.data.payload?.headers ?? [];
          const from = headers.find(h => h.name === 'From')?.value ?? 'unknown';
          const to = headers.find(h => h.name === 'To')?.value ?? 'unknown';
          const subject = headers.find(h => h.name === 'Subject')?.value ?? 'no subject';
          const date = headers.find(h => h.name === 'Date')?.value ?? '';

          // Extract body text
          let body = '';
          const payload = result.data.payload;
          if (payload?.body?.data) {
            body = Buffer.from(payload.body.data, 'base64').toString('utf-8');
          } else if (payload?.parts) {
            const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
            if (textPart?.body?.data) {
              body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
            }
          }

          return {
            content: `From: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\n\n${body.slice(0, 3000)}`,
          };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
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
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Gmail error: ${msg}`, isError: true };
        }
      },
    },

    // ── Drive: Search ──
    {
      definition: {
        name: 'google_drive_search',
        description:
          'Search Google Drive for files and folders. Returns names, types, owners, and last modified dates.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search query (file name or content)' },
            max_results: { type: 'number', description: 'Max results (default 10, max 30)' },
            type: { type: 'string', enum: ['document', 'spreadsheet', 'presentation', 'folder', 'any'], description: 'Filter by file type (default: any)' },
          },
          required: ['query'],
        },
      },
      handler: async (args) => {
        const query = args.query as string;
        const maxResults = Math.min((args.max_results as number) ?? 10, 30);
        const fileType = args.type as string | undefined;

        try {
          const mimeFilter: Record<string, string> = {
            document: "mimeType = 'application/vnd.google-apps.document'",
            spreadsheet: "mimeType = 'application/vnd.google-apps.spreadsheet'",
            presentation: "mimeType = 'application/vnd.google-apps.presentation'",
            folder: "mimeType = 'application/vnd.google-apps.folder'",
          };

          let q = `name contains '${query.replace(/'/g, "\\'")}'`;
          if (fileType && mimeFilter[fileType]) {
            q += ` and ${mimeFilter[fileType]}`;
          }
          q += " and trashed = false";

          const result = await drive.files.list({
            q,
            pageSize: maxResults,
            fields: 'files(id, name, mimeType, modifiedTime, owners, webViewLink)',
            orderBy: 'modifiedTime desc',
          });

          const files = result.data.files ?? [];
          if (files.length === 0) {
            return { content: `No files found for "${query}".` };
          }

          const lines = files.map(f => {
            const owner = f.owners?.[0]?.displayName ?? 'unknown';
            const modified = f.modifiedTime ? new Date(f.modifiedTime).toLocaleDateString() : '';
            const type = f.mimeType?.split('.').pop() ?? 'file';
            return `- ${f.name} (${type}) | Modified: ${modified} | Owner: ${owner} | ${f.webViewLink ?? ''}`;
          });

          return { content: `Found ${files.length} files:\n${lines.join('\n')}` };
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
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
          const msg = error instanceof Error ? error.message : String(error);
          return { content: `Drive error: ${msg}`, isError: true };
        }
      },
    },
  ];
}
