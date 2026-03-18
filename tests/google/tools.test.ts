/**
 * Tests for Google Workspace tools.
 *
 * Mocks the googleapis client to test tool input/output without real API calls.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGoogleTools, type GoogleTool } from '../../src/google/tools.js';

// Mock googleapis
vi.mock('googleapis', () => {
  const mockCalendar = {
    events: {
      list: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
      get: vi.fn(),
      patch: vi.fn(),
    },
    freebusy: {
      query: vi.fn(),
    },
  };
  const mockGmail = {
    users: {
      messages: {
        list: vi.fn(),
        get: vi.fn(),
        modify: vi.fn(),
      },
      threads: {
        list: vi.fn(),
        get: vi.fn(),
      },
      drafts: {
        create: vi.fn(),
        send: vi.fn(),
      },
    },
  };
  const mockDrive = {
    files: {
      list: vi.fn(),
      get: vi.fn(),
    },
  };

  return {
    google: {
      calendar: () => mockCalendar,
      gmail: () => mockGmail,
      drive: () => mockDrive,
      auth: { OAuth2: vi.fn() },
      // Expose mocks for test access
      _mocks: { calendar: mockCalendar, gmail: mockGmail, drive: mockDrive },
    },
  };
});

// Access mocks
import { google } from 'googleapis';
const mocks = (google as any)._mocks;

describe('Google Workspace Tools', () => {
  let tools: GoogleTool[];

  beforeEach(() => {
    vi.clearAllMocks();
    tools = createGoogleTools({} as any);
  });

  function findTool(name: string) {
    const tool = tools.find(t => t.definition.name === name);
    if (!tool) throw new Error(`Tool ${name} not found`);
    return tool;
  }

  describe('tool registration', () => {
    it('registers all 16 Google tools', () => {
      expect(tools).toHaveLength(16);
      const names = tools.map(t => t.definition.name);
      // Calendar (8)
      expect(names).toContain('google_calendar_list_events');
      expect(names).toContain('google_calendar_create_event');
      expect(names).toContain('google_calendar_delete_event');
      expect(names).toContain('google_calendar_update_event');
      expect(names).toContain('google_calendar_find_free');
      expect(names).toContain('google_calendar_rsvp');
      expect(names).toContain('google_calendar_freebusy');
      expect(names).toContain('google_calendar_get_event');
      // Gmail (6)
      expect(names).toContain('google_gmail_search');
      expect(names).toContain('google_gmail_read');
      expect(names).toContain('google_gmail_draft');
      expect(names).toContain('google_gmail_send_draft');
      expect(names).toContain('google_gmail_reply');
      expect(names).toContain('google_gmail_label');
      // Drive (2) — but also add share later
      expect(names).toContain('google_drive_search');
      expect(names).toContain('google_drive_get_file');
    });
  });

  describe('google_calendar_list_events', () => {
    it('returns formatted events', async () => {
      mocks.calendar.events.list.mockResolvedValue({
        data: {
          items: [
            {
              summary: 'Team Standup',
              start: { dateTime: '2026-03-18T09:00:00-07:00' },
              end: { dateTime: '2026-03-18T09:30:00-07:00' },
              attendees: [{ email: 'sarah@acme.com' }],
            },
            {
              summary: 'Client Call',
              start: { dateTime: '2026-03-18T14:00:00-07:00' },
              end: { dateTime: '2026-03-18T15:00:00-07:00' },
              location: 'Zoom',
            },
          ],
        },
      });

      const tool = findTool('google_calendar_list_events');
      const result = await tool.handler({ days_ahead: 7 });

      expect(result.content).toContain('Team Standup');
      expect(result.content).toContain('Client Call');
      expect(result.content).toContain('sarah@acme.com');
      expect(result.content).toContain('Zoom');
    });

    it('handles no events', async () => {
      mocks.calendar.events.list.mockResolvedValue({ data: { items: [] } });

      const tool = findTool('google_calendar_list_events');
      const result = await tool.handler({});

      expect(result.content).toContain('No events');
    });

    it('handles API error', async () => {
      mocks.calendar.events.list.mockRejectedValue(new Error('auth failed'));

      const tool = findTool('google_calendar_list_events');
      const result = await tool.handler({});

      expect(result.isError).toBe(true);
      expect(result.content).toContain('auth failed');
    });
  });

  describe('google_calendar_create_event', () => {
    it('creates an event and returns confirmation', async () => {
      mocks.calendar.events.insert.mockResolvedValue({
        data: { id: 'evt_123' },
      });

      const tool = findTool('google_calendar_create_event');
      const result = await tool.handler({
        summary: 'Lunch with Sarah',
        start_time: '2026-03-18T12:00:00-07:00',
        end_time: '2026-03-18T13:00:00-07:00',
        attendees: ['sarah@acme.com'],
      });

      expect(result.content).toContain('Lunch with Sarah');
      expect(result.content).toContain('evt_123');
    });
  });

  describe('google_gmail_search', () => {
    it('returns thread IDs and snippets', async () => {
      // threads.list returns thread IDs + snippets (lightweight, no per-thread fetch)
      mocks.gmail.users.threads.list.mockResolvedValue({
        data: {
          threads: [
            { id: 'thread_1', snippet: 'Please review the attached budget for Q2' },
            { id: 'thread_2', snippet: 'Updated the timeline as discussed in our meeting' },
          ],
        },
      });

      const tool = findTool('google_gmail_search');
      const result = await tool.handler({ query: 'budget' });

      expect(result.content).toContain('thread_1');
      expect(result.content).toContain('thread_2');
      expect(result.content).toContain('review the attached budget');
      expect(result.content).toContain('Updated the timeline');
      expect(result.content).toContain('Found 2 threads');
    });

    it('handles no results', async () => {
      mocks.gmail.users.threads.list.mockResolvedValue({ data: { threads: [] } });

      const tool = findTool('google_gmail_search');
      const result = await tool.handler({ query: 'nonexistent' });

      expect(result.content).toContain('No email threads found');
    });
  });

  describe('google_gmail_read', () => {
    it('returns full thread content', async () => {
      // threads.get returns the full thread directly when using thread_id
      mocks.gmail.users.threads.get.mockResolvedValue({
        data: {
          messages: [
            {
              payload: {
                headers: [
                  { name: 'From', value: 'sarah@acme.com' },
                  { name: 'To', value: 'andrew@acme.com' },
                  { name: 'Subject', value: 'Meeting Notes' },
                  { name: 'Date', value: 'Mon, 17 Mar 2026' },
                ],
                body: {
                  data: Buffer.from('Here are the meeting notes from today.').toString('base64'),
                },
              },
            },
            {
              payload: {
                headers: [
                  { name: 'From', value: 'andrew@acme.com' },
                  { name: 'To', value: 'sarah@acme.com' },
                  { name: 'Date', value: 'Tue, 18 Mar 2026' },
                ],
                body: {
                  data: Buffer.from('Thanks, I have reviewed these.').toString('base64'),
                },
              },
            },
          ],
        },
      });

      const tool = findTool('google_gmail_read');
      const result = await tool.handler({ thread_id: 'thread_1' });

      expect(result.content).toContain('sarah@acme.com');
      expect(result.content).toContain('Meeting Notes');
      expect(result.content).toContain('meeting notes from today');
      // Should include the reply
      expect(result.content).toContain('andrew@acme.com');
      expect(result.content).toContain('I have reviewed these');
      expect(result.content).toContain('2 messages');
    });
  });

  describe('google_gmail_draft', () => {
    it('creates a draft and returns confirmation', async () => {
      mocks.gmail.users.drafts.create.mockResolvedValue({
        data: { id: 'draft_123' },
      });

      const tool = findTool('google_gmail_draft');
      const result = await tool.handler({
        to: 'sarah@acme.com',
        subject: 'Follow-up',
        body: 'Thanks for the meeting today.',
      });

      expect(result.content).toContain('Draft created');
      expect(result.content).toContain('Follow-up');
      expect(result.content).toContain('draft_123');
    });
  });

  describe('google_drive_search', () => {
    it('returns file results', async () => {
      mocks.drive.files.list.mockResolvedValue({
        data: {
          files: [
            {
              name: 'Q2 Budget.xlsx',
              mimeType: 'application/vnd.google-apps.spreadsheet',
              modifiedTime: '2026-03-15T10:00:00Z',
              owners: [{ displayName: 'Sarah Chen' }],
              webViewLink: 'https://docs.google.com/spreadsheets/d/abc123',
            },
          ],
        },
      });

      const tool = findTool('google_drive_search');
      const result = await tool.handler({ query: 'budget' });

      expect(result.content).toContain('Q2 Budget');
      expect(result.content).toContain('Sarah Chen');
    });

    it('handles no results', async () => {
      mocks.drive.files.list.mockResolvedValue({ data: { files: [] } });

      const tool = findTool('google_drive_search');
      const result = await tool.handler({ query: 'nonexistent' });

      expect(result.content).toContain('No files found');
    });
  });

  describe('google_drive_get_file', () => {
    it('returns file metadata', async () => {
      mocks.drive.files.get.mockResolvedValue({
        data: {
          name: 'Project Plan.docx',
          mimeType: 'application/vnd.google-apps.document',
          modifiedTime: '2026-03-17T10:00:00Z',
          createdTime: '2026-03-01T10:00:00Z',
          owners: [{ displayName: 'Andrew Covato' }],
          permissions: [{ emailAddress: 'sarah@acme.com', role: 'writer' }],
          webViewLink: 'https://docs.google.com/document/d/xyz789',
        },
      });

      const tool = findTool('google_drive_get_file');
      const result = await tool.handler({ file_id: 'xyz789' });

      expect(result.content).toContain('Project Plan');
      expect(result.content).toContain('Andrew Covato');
      expect(result.content).toContain('sarah@acme.com');
    });
  });

  describe('google_calendar_rsvp', () => {
    it('RSVPs to an event', async () => {
      mocks.calendar.events.get.mockResolvedValue({
        data: { summary: 'Team Standup', attendees: [{ email: 'me@acme.com', self: true, responseStatus: 'needsAction' }] },
      });
      mocks.calendar.events.patch.mockResolvedValue({ data: {} });

      const tool = findTool('google_calendar_rsvp');
      const result = await tool.handler({ event_id: 'evt_1', response: 'accepted' });

      expect(result.content).toContain('accepted');
      expect(result.content).toContain('Team Standup');
    });
  });

  describe('google_calendar_freebusy', () => {
    it('returns free/busy info for multiple people', async () => {
      mocks.calendar.freebusy.query.mockResolvedValue({
        data: {
          calendars: {
            'sarah@acme.com': { busy: [{ start: '2026-03-18T09:00:00Z', end: '2026-03-18T10:00:00Z' }] },
            'jake@acme.com': { busy: [] },
          },
        },
      });

      const tool = findTool('google_calendar_freebusy');
      const result = await tool.handler({ emails: ['sarah@acme.com', 'jake@acme.com'] });

      expect(result.content).toContain('sarah@acme.com');
      expect(result.content).toContain('Busy');
      expect(result.content).toContain('jake@acme.com');
      expect(result.content).toContain('Free');
    });
  });

  describe('google_calendar_get_event', () => {
    it('returns full event details', async () => {
      mocks.calendar.events.get.mockResolvedValue({
        data: {
          summary: 'Strategy Meeting',
          start: { dateTime: '2026-03-18T14:00:00Z' },
          end: { dateTime: '2026-03-18T15:00:00Z' },
          location: 'Conference Room B',
          attendees: [{ email: 'sarah@acme.com', responseStatus: 'accepted' }],
          status: 'confirmed',
          id: 'evt_123',
        },
      });

      const tool = findTool('google_calendar_get_event');
      const result = await tool.handler({ event_id: 'evt_123' });

      expect(result.content).toContain('Strategy Meeting');
      expect(result.content).toContain('Conference Room B');
      expect(result.content).toContain('sarah@acme.com');
      expect(result.content).toContain('accepted');
    });
  });

  describe('google_gmail_send_draft', () => {
    it('sends a draft', async () => {
      mocks.gmail.users.drafts.send.mockResolvedValue({
        data: { id: 'sent_msg_1' },
      });

      const tool = findTool('google_gmail_send_draft');
      const result = await tool.handler({ draft_id: 'draft_123' });

      expect(result.content).toContain('Email sent');
      expect(result.content).toContain('sent_msg_1');
    });
  });

  describe('google_gmail_reply', () => {
    it('creates a reply draft', async () => {
      mocks.gmail.users.messages.get.mockResolvedValue({
        data: {
          threadId: 'thread_1',
          payload: {
            headers: [
              { name: 'From', value: 'sarah@acme.com' },
              { name: 'To', value: 'me@acme.com' },
              { name: 'Subject', value: 'Budget Review' },
              { name: 'Message-ID', value: '<msg123@acme.com>' },
            ],
          },
        },
      });
      mocks.gmail.users.drafts.create.mockResolvedValue({
        data: { id: 'draft_reply_1' },
      });

      const tool = findTool('google_gmail_reply');
      const result = await tool.handler({ message_id: 'msg_1', body: 'Thanks, looks good!' });

      expect(result.content).toContain('Reply draft created');
      expect(result.content).toContain('sarah@acme.com');
      expect(result.content).toContain('draft_reply_1');
    });
  });

  describe('google_gmail_label', () => {
    it('adds and removes labels', async () => {
      mocks.gmail.users.messages.modify.mockResolvedValue({ data: {} });

      const tool = findTool('google_gmail_label');
      const result = await tool.handler({
        message_id: 'msg_1',
        add_labels: ['STARRED'],
        remove_labels: ['UNREAD'],
      });

      expect(result.content).toContain('Labels updated');
      expect(result.content).toContain('STARRED');
      expect(result.content).toContain('UNREAD');
    });
  });
});
