# Integration Specifications

## 1. Slack Integration

### Architecture
- **SDK**: `@slack/bolt` with Socket Mode
- **Tokens Required**:
  - App-Level Token (`xapp-`) — for Socket Mode WebSocket
  - Bot Token (`xoxb-`) — for posting messages, reading channels
  - User Token (`xoxp-`) — for searching messages (private channels, DMs)
- **Transport**: Socket Mode (outbound WebSocket, no public endpoint)

### Slack App Manifest (Required Scopes)

```yaml
display_information:
  name: Clawvato
  description: Personal AI chief of staff
  background_color: "#2c2d30"

features:
  bot_user:
    display_name: clawvato
    always_online: true
  assistant_view:
    assistant_description: "Your AI chief of staff — manages Slack, email, calendar, and tasks"
    suggested_prompts:
      - title: "Summarize recent messages"
        message: "Summarize the important messages I've missed in the last few hours"
      - title: "Check my calendar"
        message: "What does my schedule look like today?"
      - title: "Draft a message"
        message: "Help me draft a message to..."

oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write         # Assistant panel APIs (setStatus, setTitle, setSuggestedPrompts)
      - channels:history
      - channels:read
      - chat:write
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
      - users:read.email
    user:
      - search:read

settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - assistant_thread_started
      - assistant_thread_context_changed
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false
```

### Assistant Framework (AI Apps)

Clawvato registers as a Slack AI app via `app.assistant()`. This provides a dedicated split-view panel alongside regular DMs and @mentions:

- **`threadStarted`**: Shows suggested prompts when the user opens the assistant panel
- **`threadContextChanged`**: Saves channel context when user navigates (for future contextual awareness)
- **`userMessage`**: Routes messages through `SlackHandler.handleAssistantMessage()`, which uses `setStatus()`/`say()` instead of the reaction lifecycle

Both entry points (assistant panel + DMs/@mentions) share the same agent orchestrator.

### Custom Slack MCP Server Tools

We build this custom because we need sender verification baked in.

```typescript
// Tools exposed by our Slack MCP server
tools: [
  {
    name: "slack_search_messages",
    description: "Search Slack message history. Uses user token for full access.",
    input: { query: string, channel?: string, from_user?: string, time_range?: string, limit?: number }
  },
  {
    name: "slack_post_message",
    description: "Post a message to a channel or DM. Subject to training-wheels confirmation.",
    input: { channel: string, text: string, thread_ts?: string, blocks?: Block[] }
  },
  {
    name: "slack_post_confirmation",
    description: "Post an interactive confirmation message with approve/deny buttons.",
    input: { channel: string, thread_ts: string, description: string, action_id: string, details: object }
  },
  {
    name: "slack_get_thread",
    description: "Read all messages in a thread.",
    input: { channel: string, thread_ts: string }
  },
  {
    name: "slack_get_user_info",
    description: "Get user profile info by Slack user ID.",
    input: { user_id: string }
  },
  {
    name: "slack_stream_response",
    description: "Start a streaming response (for long LLM outputs).",
    input: { channel: string, thread_ts: string }
  }
]
```

### Event Handling Flow

```
Slack Event (app_mention / message.im)
    │
    ├── Is sender == AUTHORIZED_USER_ID?
    │     ├── YES → Treat as INSTRUCTION → Agent Orchestrator
    │     └── NO  → Treat as DATA ONLY → Log, do not execute
    │
    ├── Is event from a bot?
    │     └── YES → Ignore completely (prevent bot-to-bot injection)
    │
    └── Acknowledge event within 3 seconds (required by Slack)
```

### Reconnection & Catch-Up

```typescript
// On reconnection, poll for missed @mentions
async function catchUpMissedMentions(lastEventTs: number) {
  const channels = await getChannelsBotIsIn();
  for (const channel of channels) {
    const history = await slack.conversations.history({
      channel: channel.id,
      oldest: String(lastEventTs),
      limit: 50,
    });
    for (const msg of history.messages ?? []) {
      if (msg.text?.includes(`<@${BOT_USER_ID}>`) && msg.user === AUTHORIZED_USER_ID) {
        await processDelayedMention(msg, channel.id);
      }
    }
  }
}
```

### Streaming Responses

```typescript
// Use Slack's chat streaming for LLM-style responses
async function streamResponse(channel: string, threadTs: string, content: AsyncIterable<string>) {
  const stream = await slack.chat.startStream({ channel, thread_ts: threadTs });
  let buffer = '';
  for await (const chunk of content) {
    buffer += chunk;
    // Batch updates every 100ms to avoid rate limits
    await slack.chat.appendStream({ stream_id: stream.stream_id, text: buffer });
    buffer = '';
  }
  await slack.chat.stopStream({ stream_id: stream.stream_id });
}
```

---

## 2. Google Workspace Integration

### OAuth2 Setup

- **Type**: Desktop/CLI OAuth2 with PKCE
- **Token Storage**: macOS Keychain (primary) or encrypted JSON (fallback)
- **Refresh**: Automatic via `google-auth-library` — listen for `tokens` event

### Required Google Cloud Setup
1. Create Google Cloud project
2. Enable APIs: Gmail, Drive, Calendar, Drive Activity
3. Create OAuth2 Desktop Client credentials
4. Configure OAuth Consent Screen (Internal if Workspace, External+test-user if personal)
5. First-run: browser-based consent flow → store refresh token

### Required Scopes
```
https://www.googleapis.com/auth/gmail.modify        # Read, send, modify labels
https://www.googleapis.com/auth/gmail.settings.basic # SendAs alias management
https://www.googleapis.com/auth/calendar             # Full calendar access
https://www.googleapis.com/auth/drive                # Full Drive access
https://www.googleapis.com/auth/drive.activity.readonly # Sharing history
```

### Gmail MCP Server Tools

```typescript
tools: [
  {
    name: "gmail_search",
    description: "Search emails using Gmail query syntax.",
    input: { query: string, max_results?: number }
    // Output: Array<{ id, threadId, subject, from, to, date, snippet }>
  },
  {
    name: "gmail_get_message",
    description: "Get full email content by message ID.",
    input: { message_id: string }
  },
  {
    name: "gmail_get_thread",
    description: "Get all messages in an email thread.",
    input: { thread_id: string }
  },
  {
    name: "gmail_send",
    description: "Send an email. Subject to output sanitizer and training-wheels confirmation.",
    input: { to: string, subject: string, body: string, cc?: string, reply_to_message_id?: string, send_as?: string }
  },
  {
    name: "gmail_create_draft",
    description: "Create an email draft (does not send).",
    input: { to: string, subject: string, body: string, cc?: string }
  },
  {
    name: "gmail_check_new",
    description: "Check for new emails since a given history ID.",
    input: { since_history_id: string, label?: string }
  }
]
```

### Gmail Email Monitoring

For a local agent, polling is simplest and most reliable:

```typescript
// Poll every 30 seconds for new emails
let lastHistoryId: string;

async function pollGmail() {
  const history = await gmail.users.history.list({
    userId: 'me',
    startHistoryId: lastHistoryId,
    historyTypes: ['messageAdded'],
    labelId: 'INBOX',
  });
  if (history.data.history) {
    for (const record of history.data.history) {
      for (const added of record.messagesAdded || []) {
        await processIncomingEmail(added.message.id);
      }
    }
  }
  lastHistoryId = history.data.historyId!;
}

setInterval(pollGmail, 30_000);
```

### Agent Email Identity

**Setup** (Google Workspace admin):
1. Create email alias `clawvato@yourdomain.com` in Admin Console > Users
2. Configure SendAs alias via Gmail API
3. Agent sends from this alias; replies come to your main inbox

**Implementation**:
```typescript
// One-time setup: register the SendAs alias
await gmail.users.settings.sendAs.create({
  userId: 'me',
  requestBody: {
    sendAsEmail: 'clawvato@yourdomain.com',
    displayName: 'Clawvato',
    replyToAddress: 'you@yourdomain.com',
  },
});

// Sending from the alias:
const rawEmail = [
  'From: Clawvato <clawvato@yourdomain.com>',
  `To: ${recipient}`,
  `Subject: ${subject}`,
  'Content-Type: text/plain; charset=utf-8',
  '',
  body,
].join('\r\n');
```

### Google Drive MCP Server Tools

```typescript
tools: [
  {
    name: "drive_search",
    description: "Search Google Drive for files by name, content, or metadata.",
    input: { query: string, mime_type?: string, modified_after?: string, owner?: string, max_results?: number }
  },
  {
    name: "drive_get_file",
    description: "Get file metadata and sharing info by file ID.",
    input: { file_id: string }
  },
  {
    name: "drive_get_file_id_from_url",
    description: "Extract and validate a Google Drive file ID from a URL.",
    input: { url: string }
  },
  {
    name: "drive_update_permissions",
    description: "Grant or revoke file permissions. Subject to training-wheels confirmation.",
    input: { file_id: string, email: string, role: 'reader' | 'commenter' | 'writer', action: 'grant' | 'revoke' }
  },
  {
    name: "drive_list_permissions",
    description: "List current permissions on a file.",
    input: { file_id: string }
  },
  {
    name: "drive_get_sharing_history",
    description: "Get permission change history for a file using Drive Activity API.",
    input: { file_id: string, since?: string }
  }
]
```

### Google Calendar MCP Server Tools

```typescript
tools: [
  {
    name: "calendar_get_availability",
    description: "Check free/busy status for one or more people in a time range.",
    input: { emails: string[], time_min: string, time_max: string, timezone?: string }
  },
  {
    name: "calendar_find_slots",
    description: "Find available meeting slots given constraints.",
    input: { duration_minutes: number, time_min: string, time_max: string, attendee_emails?: string[], preferences?: { no_before?: string, no_after?: string, prefer_days?: string[] } }
  },
  {
    name: "calendar_list_events",
    description: "List upcoming events.",
    input: { time_min?: string, time_max?: string, max_results?: number }
  },
  {
    name: "calendar_create_event",
    description: "Create a calendar event with attendees. Subject to training-wheels confirmation.",
    input: { summary: string, start: string, end: string, attendees?: string[], description?: string, location?: string, add_meet?: boolean }
  },
  {
    name: "calendar_update_event",
    description: "Update an existing calendar event.",
    input: { event_id: string, updates: object }
  }
]
```

---

## 3. GitHub Integration

### Approach: Use Official GitHub MCP Server

The official GitHub MCP server is maintained by GitHub, written in Go, and connects via stdio.

```typescript
// Agent SDK MCP config
mcpServers: {
  github: {
    command: "github-mcp-server",
    args: ["--toolsets", "repos,issues,pull_requests,code_search"],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: "{{ from_keychain }}",
    },
  },
}
```

### Fine-Grained PAT Scopes (Minimum Required)

```
Repository permissions:
  - Contents: Read
  - Issues: Read and Write
  - Pull requests: Read and Write
  - Metadata: Read (always included)

Account permissions:
  - (none needed for a personal agent)
```

### Security: Lockdown Mode

The GitHub MCP server supports lockdown mode for public repos (prevents prompt injection via issues/PRs):

```
GITHUB_MCP_TOOL_ADD_ISSUE_COMMENT=disabled  # Prevent agent from commenting on public issues
```

### Tools Available (from official server)

- `get_file_contents` — Read file content from a repo
- `search_code` — Search code across repos
- `list_issues` — List/filter issues
- `create_issue` — Create new issues
- `get_issue` — Get issue details
- `add_issue_comment` — Comment on issues
- `list_pull_requests` — List PRs
- `get_pull_request` — Get PR details, diff, review status
- `create_pull_request` — Create PRs
- `search_repositories` — Search repos
- `push_files` — Create/update files in a repo
- `create_branch` — Create branches

---

## 4. Filesystem Integration

### Approach: Use Official Filesystem MCP Server with Hardened Config

```typescript
mcpServers: {
  filesystem: {
    command: "npx",
    args: [
      "-y", "@modelcontextprotocol/server-filesystem",
      // Explicitly list allowed directories
      "/Users/you/Documents",
      "/Users/you/Projects",
      "/Users/you/Downloads",
    ],
  },
}
```

### Additional Sandboxing (PreToolUse Hook)

The MCP server handles basic sandboxing, but we add a PreToolUse hook for defense-in-depth:

```typescript
// PreToolUse hook for filesystem operations
async function validateFilesystemAccess(toolCall: ToolCall): Promise<HookResult> {
  if (!toolCall.name.startsWith('mcp__filesystem__')) return {};

  const path = toolCall.input?.path || toolCall.input?.file_path || '';

  // Hard deny patterns (NEVER accessible)
  const FORBIDDEN = [
    /\/\.ssh\//,
    /\/\.gnupg\//,
    /\/\.aws\//,
    /\/\.config\//,
    /\/\.[^/]+$/,     // Any dotfile at root
    /\.env($|\.)/,    // .env files
    /credentials/i,
    /secrets/i,
    /\.pem$/,
    /\.key$/,
    /\/etc\//,
    /\/System\//,
  ];

  for (const pattern of FORBIDDEN) {
    if (pattern.test(path)) {
      return { blocked: true, message: `Access denied: ${path} matches forbidden pattern` };
    }
  }

  return {};
}
```

### Tools Available (from official server)

- `read_file` — Read file contents
- `write_file` — Create or overwrite a file
- `edit_file` — Make line-based edits
- `create_directory` — Create directories
- `list_directory` — List directory contents
- `move_file` — Move/rename files
- `search_files` — Recursive search by name pattern
- `get_file_info` — Get file metadata (size, dates, permissions)
- `list_allowed_directories` — Show sandbox boundaries

---

## 5. Web Research Integration

### Approach: Playwright MCP Server

```typescript
mcpServers: {
  browser: {
    command: "npx",
    args: ["-y", "@playwright/mcp@latest"],
  },
}
```

### Use Cases
- Pre-meeting research ("Look up Jake Martinez on LinkedIn")
- Price checking ("What's the current pricing for Notion Business?")
- Documentation lookup ("Find the API docs for X")
- News/competitive intelligence

### Security Controls
- All web research results are DATA, never INSTRUCTIONS
- Output sanitizer scans results before presenting to user
- No form submission or authentication flows (read-only browsing)
- Rate limited to prevent abuse

### Agent SDK also provides built-in tools
- `WebSearch` — Search the web
- `WebFetch` — Fetch and parse a specific URL

These are available without MCP and may be sufficient for basic research without needing full Playwright browser automation.

---

## 6. Memory MCP Server (Custom)

### Tools

```typescript
tools: [
  // Explicit memory management (MemGPT-inspired)
  {
    name: "memory_store_fact",
    description: "Store a new fact, preference, or observation in memory.",
    input: { content: string, type: 'fact' | 'preference' | 'decision' | 'observation', entities?: string[], importance?: number, valid_from?: string }
  },
  {
    name: "memory_search",
    description: "Semantic search over memory. Use when current context is insufficient.",
    input: { query: string, type?: string, time_range?: string, limit?: number, min_score?: number }
  },
  {
    name: "memory_get_person",
    description: "Get stored information about a person by name, email, or Slack ID.",
    input: { identifier: string }
  },
  {
    name: "memory_update_person",
    description: "Update or create a person record.",
    input: { identifier: string, updates: { name?: string, email?: string, role?: string, org?: string, notes?: string } }
  },
  {
    name: "memory_get_action_history",
    description: "Get past actions of a given type.",
    input: { action_type?: string, person?: string, time_range?: string, limit?: number }
  },
  {
    name: "memory_get_active_workflows",
    description: "List currently active async workflows.",
    input: {}
  }
]
```

### Retrieval Pipeline (Runs Before Every Agent Call)

```typescript
async function buildRetrievedContext(message: string, classification: Classification): Promise<string> {
  const parts: string[] = [];
  let tokens = 0;
  const BUDGET = 1500;

  // 1. People lookup (structured, O(1))
  for (const name of classification.entities) {
    const person = db.people.findByName(name);
    if (person && tokens < BUDGET) {
      const summary = formatPerson(person); // ~30-50 tokens
      parts.push(summary);
      tokens += estimateTokens(summary);
    }
  }

  // 2. Preferences for this action type (structured, O(1))
  if (classification.action_type) {
    const prefs = db.memories.findPreferences(classification.action_type);
    for (const pref of prefs.slice(0, 5)) {
      if (tokens < BUDGET) {
        parts.push(`Preference: ${pref.content}`);
        tokens += estimateTokens(pref.content);
      }
    }
  }

  // 3. Recent relevant decisions (structured, O(log n))
  const decisions = db.memories.findDecisions(classification.action_type, 3);
  for (const dec of decisions) {
    if (tokens < BUDGET) {
      parts.push(`Past decision: ${dec.content}`);
      tokens += estimateTokens(dec.content);
    }
  }

  // 4. Semantic search (vector, only if budget remaining)
  if (tokens < BUDGET - 300) {
    const results = await vectorSearch(message, {
      limit: 5,
      minScore: 0.7,
      excludeTypes: ['preference', 'decision'], // Already retrieved above
    });
    for (const r of results) {
      if (tokens < BUDGET) {
        parts.push(r.content);
        tokens += estimateTokens(r.content);
      }
    }
  }

  return parts.join('\n');
}
```
