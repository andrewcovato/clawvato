# Clawvato: Always-On Personal AI Agent

## Vision
An always-on AI agent running locally that acts as a personal chief of staff — handling context-draining tasks like file sharing, meeting scheduling, email coordination, and proactive workflow optimization. Interacted with primarily via Slack, with its own email identity. Designed with security as the foundational principle: zero trust, plan-then-execute, no sensitive data leakage.

## Decided
- **Claude Agent SDK** as the agent runtime (handles agent loop, MCP, tool routing, model calls)
- **Google Workspace** for email/drive/calendar (single OAuth domain)
- **Single user** (just you — no multi-tenancy)
- **Training wheels mode** (confirm everything initially, graduate over time)
- **Model routing** (Opus for planning/reflection, Sonnet for execution, Haiku for classification/extraction)
- **Local-first deployment** (your machine, not cloud)
- **Extensible via MCP plugin system**
- **Plan-Then-Execute** as default agent loop (structural prompt injection defense)
- **SQLite + sqlite-vec + FTS5** as the entire data layer
- **Local embeddings** (all-MiniLM-L6-v2 via @huggingface/transformers in worker thread)

---

## Detailed Specifications

This document is the master overview. Deep-dive specs are in `docs/`:

| Document | Contents |
|----------|----------|
| [SPEC_MEMORY_V2.md](docs/SPEC_MEMORY_V2.md) | Full memory schema, triple-factor retrieval, bi-temporal facts, reflection/consolidation, embedding pipeline, hybrid search SQL |
| [SPEC_INTEGRATIONS.md](docs/SPEC_INTEGRATIONS.md) | Slack app manifest & MCP server, Gmail/Drive/Calendar MCP servers, GitHub/Filesystem/Web Research configs, credential management |
| [RESEARCH_SYNTHESIS.md](docs/RESEARCH_SYNTHESIS.md) | Research findings, architecture adjustments, feature recommendations, anti-patterns |
| [MEMORY_ARCHITECTURE.md](docs/MEMORY_ARCHITECTURE.md) | Original memory deep-dive with three-tier system explanation and cost analysis |
| [BUILD_PLAN.md](docs/BUILD_PLAN.md) | Parallelized multi-session build plan with 8 tracks, dependency graph, file listings |

---

## Core Capabilities

### 1. Slack Interface (Primary interaction layer)
- **@mention activation**: User @'s the agent in any channel or DM
- **Slack message search**: Bot-token for public channels, user-token for private/DMs
- **Thread-aware**: Follows and responds within threads
- **Streaming responses**: Uses `chat.startStream`/`appendStream`/`stopStream` for LLM-style streaming
- **Interactive confirmations**: Block Kit buttons for approve/deny/modify actions
- **Proactive messages**: DMs user with suggestions, reminders, briefings

### 2. Email (Own identity via Google Workspace)
- **Dedicated email**: `clawvato@yourdomain.com` (configured as SendAs alias on user's Workspace account)
- **Send/receive emails**: Meeting requests, follow-ups, file shares
- **Multi-turn coordination**: Handle async scheduling conversations autonomously
- **Ghost Draft mode**: Shows drafts in Slack for approval before sending
- **Polling-based monitoring**: Gmail `history.list()` polling for incoming messages

### 3. Google Drive & File Management
- **Search files**: By name, content, recency, sharing history
- **Modify permissions**: Grant/revoke edit/view access
- **Share files**: Generate sharing links, send via email or Slack
- **Track sharing history**: Remember who was sent what and when

### 4. Google Calendar
- **Read availability**: Check user's calendar for free slots
- **Preference-aware scheduling**: Learns and applies scheduling preferences
- **Create events**: Schedule meetings with proper invites
- **Cross-reference**: Find mutual availability via email-based coordination

### 5. Local Filesystem Access
- **Sandboxed access**: Read/write within explicitly allowed directories only
- **Official MCP server**: `@modelcontextprotocol/server-filesystem` with defense-in-depth path validation
- **Forbidden paths**: Hard-deny for `.ssh`, `.gnupg`, `.aws`, `.env`, credentials, keys

### 6. GitHub Integration
- **Official MCP server**: Go-based GitHub MCP server
- **Fine-grained PAT**: Minimal scopes, short expiry
- **Repository access**: Issues, PRs, commits, file contents, notifications
- **Lockdown mode**: Read-only for public repos by default

### 7. Persistent Memory (Research-Hardened)
- **Three-tier retrieval**: Identity (always present) → Active Context (per request) → Retrieved Context (targeted search) → Deep Storage (on-demand via tool)
- **Triple-factor scoring**: `recency × importance × relevance` (from Stanford Generative Agents paper)
- **Bi-temporal facts**: Every fact tracks `valid_from` and `valid_until` (from Zep/Graphiti)
- **Agent-managed memory**: Explicit tools to store/search (from MemGPT), not just auto-injection
- **Local embeddings**: `all-MiniLM-L6-v2` (q8 quantized, ~5-15ms/sentence on Apple Silicon)
- **Hybrid search**: sqlite-vec + FTS5 combined via Reciprocal Rank Fusion
- **Reflection/consolidation**: Triggered when cumulative importance ≥ 50 points
- **Nightly consolidation**: Merge duplicates, supersede contradictions, decay stale facts, promote observations
- **Cost**: ~$1.23/mo for all memory operations

### 8. Proactive Intelligence
- **Context Bridge**: Cross-source intelligence linking Slack, email, calendar, files, GitHub
- **Daily Briefing**: Morning DM with calendar prep, pending items, draft suggestions
- **Pattern detection**: Spot recurring tasks and suggest automation
- **"What Would You Do?" mode**: Proactively suggest actions, trainable via thumbs-up/down
- **Teach Me mode**: User explicitly stores high-confidence preferences

### 9. MCP Plugin System (Extensibility)
- **Agent SDK native**: Agent runs as MCP client, connects to local MCP servers
- **Built-in MCP servers**: Slack, Gmail, Drive, Calendar, GitHub, Filesystem, Memory (7 total)
- **Official MCP servers**: Filesystem (`@modelcontextprotocol/server-filesystem`), GitHub (official Go server)
- **Custom servers**: Slack, Google Workspace, Memory (built custom for our requirements)
- **Extend freely**: Add any MCP-compatible server (databases, Notion, internal tools)
- **Plugin registration**: Requires explicit user approval with capability manifest

---

## Architecture

### Why Local-First

| Concern | Local | Cloud |
|---------|-------|-------|
| Filesystem access | Native, fast, unrestricted within sandbox | Requires sync or remote mount |
| Security | Data never leaves your machine (except API calls) | Data at rest on someone else's server |
| Latency | Local file ops are instant | Network round-trip for everything |
| Cost | No hosting fees | $5-50/mo for compute + DB |
| Availability | Only when machine is on | 24/7 |
| Slack connectivity | Socket Mode (no public endpoint needed) | Standard webhook |

**Mitigations for offline periods**: Mac Mini / NUC that stays on, Socket Mode (no ngrok needed), Gmail polling queue, optional tiny cloud relay later.

### System Architecture (Research-Hardened)

```
+──────────────────────────────────────────────────────────────────+
│                    YOUR LOCAL MACHINE                             │
│                                                                  │
│  ┌────────────────────────── SECURITY BOUNDARY ────────────────┐ │
│  │                                                             │ │
│  │  ┌────────────────────────────────────────────────────────┐ │ │
│  │  │              CLAUDE AGENT SDK (Runtime)                │ │ │
│  │  │                                                        │ │ │
│  │  │  ┌──────────────┐ ┌──────────────┐ ┌───────────────┐  │ │ │
│  │  │  │ Haiku        │ │ Opus         │ │ Sonnet        │  │ │ │
│  │  │  │ CLASSIFIER   │ │ PLANNER      │ │ EXECUTOR      │  │ │ │
│  │  │  │ • intent     │ │ • action     │ │ • tool calls  │  │ │ │
│  │  │  │ • importance │ │ • reflection │ │ • MCP routing │  │ │ │
│  │  │  │ • extraction │ │ • reasoning  │ │ • responses   │  │ │ │
│  │  │  └──────────────┘ └──────────────┘ └───────────────┘  │ │ │
│  │  │                                                        │ │ │
│  │  │  Plan-Then-Execute Loop:                               │ │ │
│  │  │  1. Classify intent (Haiku)                            │ │ │
│  │  │  2. Generate plan (Opus)                               │ │ │
│  │  │  3. Validate via PreToolUse hooks                      │ │ │
│  │  │  4. Execute each step (Sonnet)                         │ │ │
│  │  │  5. Log via PostToolUse hooks                          │ │ │
│  │  └──────────────────────┬─────────────────────────────────┘ │ │
│  │                         │ MCP Client Layer                   │ │
│  │  ┌──────┬──────┬──────┬┴─────┬──────┬──────┬──────────────┐ │ │
│  │  │Slack │Gmail │Drive │Cal   │GitHub│FS    │ Memory │Plug.│ │ │
│  │  │MCP   │MCP   │MCP   │MCP   │MCP   │MCP   │ MCP    │ N  │ │ │
│  │  │(cust)│(cust)│(cust)│(cust)│(offl)│(offl)│ (cust) │    │ │ │
│  │  └──┬───┴──┬───┴──┬───┴──┬───┴──┬───┴──┬───┴──┬─────┘    │ │ │
│  │     │      │      │      │      │      │      │           │ │
│  │  ┌──────────────── SECURITY HOOKS ──────────────────────┐ │ │
│  │  │ PreToolUse: sender verify, path validate, rate limit │ │ │
│  │  │ PostToolUse: audit log, output sanitizer             │ │ │
│  │  │ Training Wheels: trust levels, confirmation, graduate│ │ │
│  │  └──────────────────────────────────────────────────────┘ │ │
│  └──────────────────────────────────────────────────────────── │ │
│                                                                  │
│  ┌──────────────────── DATA LAYER ────────────────────────────┐ │
│  │ ┌──────────┐ ┌───────────┐ ┌───────┐ ┌──────────────────┐ │ │
│  │ │ SQLite   │ │sqlite-vec │ │ FTS5  │ │ macOS Keychain   │ │ │
│  │ │ people   │ │ 384-dim   │ │keyword│ │ tokens & creds   │ │ │
│  │ │ actions  │ │ vectors   │ │search │ │ never in LLM ctx │ │ │
│  │ │ workflows│ │           │ │       │ │                  │ │ │
│  │ │ patterns │ │           │ │       │ │                  │ │ │
│  │ └──────────┘ └───────────┘ └───────┘ └──────────────────┘ │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│  ┌──────────────────── MEMORY TIERS ──────────────────────────┐ │
│  │ T0: Identity       (~200 tok)  Always in system prompt     │ │
│  │ T1: Active Context (~500 tok)  Per-request, auto-injected  │ │
│  │ T2: Retrieved      (~1500 tok) Triple-factor scored search │ │
│  │ T3: Deep Storage   (on-demand) Explicit tool call          │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                  │
│         Outbound connections only:                               │
│         → Slack API (WebSocket)     → Google APIs (HTTPS)        │
│         → GitHub API (HTTPS)        → Anthropic API (HTTPS)      │
+──────────────────────────────────────────────────────────────────+
```

### Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript (ESM, strict) | Strong typing, best MCP/Slack/Google SDK ecosystem |
| Runtime | Node.js 22+ | Required for Slack Bolt, good for long-running process |
| Agent Framework | `@anthropic-ai/claude-agent-sdk` | Native MCP, tool routing, hooks, subagents, sessions |
| Slack | `@slack/bolt` (Socket Mode) | No public endpoint, event-driven, streaming support |
| Google APIs | `googleapis` npm | Gmail, Drive, Calendar all in one package |
| GitHub | Official GitHub MCP Server (Go) | Production-quality, maintained by GitHub |
| Database | SQLite via `better-sqlite3` | Zero config, single file, WAL mode for concurrency |
| Vector Store | `sqlite-vec` extension | Local, embedded, handles 100K vectors at 4-57ms query |
| Full-Text Search | SQLite FTS5 | Free hybrid search when combined with sqlite-vec via RRF |
| Embeddings | `@huggingface/transformers` + `all-MiniLM-L6-v2` (q8) | ~5-15ms/sentence, 384 dims, runs in worker thread |
| Credentials | macOS Keychain | Hardware-backed on Apple Silicon, never in LLM context |
| Process Manager | `launchd` (macOS) | Auto-restart, start-on-boot, native |
| Testing | `vitest` | Fast, TypeScript-native, compatible with ESM |

### Key Architecture Decisions (from Research)

| Decision | Source | Why |
|----------|--------|-----|
| Claude Agent SDK as runtime | SDK analysis | Handles agent loop, MCP, tools, model routing — no need to reinvent |
| Plan-Then-Execute | Reversec 2025, Meta "Rule of Two" | Structural prompt injection defense — untrusted data can't alter the plan |
| Triple-factor retrieval | Stanford Generative Agents | Single-factor fails: recency misses old important facts, importance misses relevance, relevance misses temporal context |
| Bi-temporal facts | Zep/Graphiti | Solves stale-fact problem: `valid_from` / `valid_until` for temporal supersession |
| SQLite over Postgres | Single-user analysis | No server process, single-file backup, WAL mode sufficient, eliminates ops burden |
| Local embeddings over API | Performance testing | $0/mo, 5-15ms/sentence, no network dependency, privacy |
| SQLite workflow engine over Temporal | Operational analysis | Temporal is overkill for single-user; SQLite state machine with checkpointing provides same guarantees |
| Custom Slack/Google/Memory MCP | Requirements gap | Official servers don't support sender-verification, user-token search, or our memory system |

---

## Security Architecture

### Threat Model

| Threat | Attack Vector | Mitigation |
|--------|--------------|------------|
| **Prompt injection via Slack** | Crafted message tricks agent | Single-Principal Authority: ONLY your Slack UID triggers actions |
| **Prompt injection via email** | Malicious email with embedded instructions | Plan-Then-Execute: email is DATA, never instructions; can't alter plan during execution |
| **Prompt injection via files** | Shared doc contains instructions | File content is NEVER treated as instructions; sandboxed context |
| **Credential theft** | Stolen tokens | macOS Keychain (hardware-backed), never in LLM context, injected at tool execution |
| **Scope creep** | Agent takes unintended actions | Training wheels + action allowlist + rate limits + circuit breakers |
| **Data exfiltration** | Agent leaks secrets in outbound messages | Output sanitizer: regex scan for API keys, tokens, passwords, SSNs, credit cards |
| **Filesystem escape** | Agent reads outside sandbox | PreToolUse hook: chroot-style path validation, FORBIDDEN_PATHS regex |
| **Supply chain** | Malicious MCP plugin | Plugin sandboxing, capability manifest, approval required, audit log |

### Security Principles

#### 1. Single-Principal Authority
```
ONLY messages from Slack User ID U_YOUR_ID are treated as instructions.
Everything else (Slack messages from others, emails, file contents,
MCP tool outputs, GitHub comments) is UNTRUSTED DATA.

No exceptions. Verified by Slack user ID on every event.
```

#### 2. Plan-Then-Execute (Structural Defense)
```
1. PLANNER (Opus) receives user's message + retrieved context → produces structured plan
2. EXECUTOR (Sonnet) executes plan step-by-step, each validated by PreToolUse hooks
3. Untrusted data (email content, file content, Slack messages from others)
   can INFORM the plan but CANNOT ADD NEW STEPS during execution
4. If executor encounters unexpected instructions in data → flag, don't follow
```

#### 3. Defense in Depth: Hook Pipeline
```
Every tool call passes through:

PreToolUse:
  [ ] Sender verified (single-principal check)
  [ ] Action type in allowlist for current trust level
  [ ] Rate limit not exceeded
  [ ] Path validation (filesystem ops)
  [ ] Recipient validation (outbound comms)

PostToolUse:
  [ ] Output scanned for secrets (API keys, tokens, passwords, SSNs)
  [ ] Action logged to immutable audit trail
  [ ] Result sanitized before returning to LLM context
```

#### 4. Credential Security
```
Storage: macOS Keychain (hardware-backed on Apple Silicon)
Fallback: age-encrypted JSON file

Credentials stored:
  - Slack Bot Token, App-Level Token, User Token
  - Google OAuth2 refresh token
  - GitHub Fine-Grained PAT
  - Anthropic API Key

Rules:
  - Minimum required scopes for every token
  - Never logged, never in LLM context
  - Injected at tool execution time only
  - Rotatable from a single CLI command
```

#### 5. Filesystem Sandboxing
```typescript
// PreToolUse hook for filesystem MCP server
const FORBIDDEN_PATTERNS = [
  /\.ssh/i, /\.gnupg/i, /\.aws/i, /\.config/i, /\/\..+/,  // dotfiles
  /\.env(\..+)?$/i,                                          // env files
  /credentials|secrets/i,                                    // credential files
  /\.(pem|key|p12|pfx|jks)$/i,                              // key files
  /\/etc\//i, /\/System\//i,                                 // system paths
  /node_modules/i,                                           // node_modules
];
```

#### 6. MCP Plugin Security
```
Each MCP server gets:
  - Declared capability manifest
  - Permission level: READ_ONLY | READ_WRITE | ADMIN
  - Rate limits independent of other plugins
  - Its own audit log entries
  - NO access to other plugins' tools or data
  - NO access to credentials

Plugin registration: explicit user approval required
```

---

## Training Wheels System

### Trust Levels

```
Level 0: FULL SUPERVISION (first 30 days)
  - Every outbound action requires Slack confirmation
  - Agent shows full action plan before executing
  - All tool calls logged with inputs and outputs

Level 1: TRUSTED READS (after ~30 days)
  - Reads (search, calendar check, file lookup) auto-execute
  - Writes still require confirmation
  - Agent composes drafts without approval, sending needs approval

Level 2: TRUSTED ROUTINE (after ~90 days)
  - Previously-approved action patterns auto-execute
  - Pattern must be confirmed 5+ times, zero rejections in last 10
  - Novel actions still require confirmation
  - Weekly digest of auto-approved actions
  - 5-minute undo window on graduated actions

Level 3: FULL AUTONOMY (opt-in, per action type)
  - Specific action types fully autonomous
  - Each autonomy grant logged and revocable
  - Circuit breakers still active
```

### Graduation Criteria
```
An action pattern graduates from Level N to N+1 when:
  - Confirmed successfully 5+ times
  - Zero rejections in last 10 occurrences
  - User hasn't modified proposed action in last 5 occurrences
  - Action type is in the "graduatable" list

Non-graduatable actions (ALWAYS require confirmation):
  - Deleting anything
  - Sending to new/unknown recipients
  - Sharing files with external domains
  - Any action involving money or contracts
  - Modifying GitHub repo settings or branch protections
```

---

## Data Model

### Core Schema (SQLite)

Full schema with all tables is in [SPEC_MEMORY_V2.md](docs/SPEC_MEMORY_V2.md). Key tables:

```sql
-- Core memory store with triple-factor scoring + bi-temporal tracking
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('fact','preference','decision','observation','reflection')),
  content TEXT NOT NULL,
  source TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,              -- NULL = still valid
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,
  entities TEXT DEFAULT '[]',
  superseded_by TEXT REFERENCES memories(id),
  reflection_source INTEGER DEFAULT 0
);

-- FTS5 + sqlite-vec for hybrid search (see SPEC_MEMORY_V2.md for RRF query)
CREATE VIRTUAL TABLE memories_fts USING fts5(content, content='memories', content_rowid='rowid');
CREATE VIRTUAL TABLE memories_vec USING vec0(memory_id TEXT PRIMARY KEY, embedding float[384]);

-- People (structured, not embedded)
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT, slack_id TEXT, github_username TEXT,
  relationship TEXT CHECK(relationship IN ('colleague','client','vendor','friend','unknown')),
  organization TEXT, role TEXT, timezone TEXT,
  notes TEXT, communication_preferences TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_interaction_at TEXT,
  interaction_count INTEGER NOT NULL DEFAULT 0
);

-- Immutable action audit trail
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','pending_confirmation','confirmed','executing','completed','failed','rejected','undone')),
  trust_level INTEGER NOT NULL,
  request_source TEXT NOT NULL,
  planned_action TEXT NOT NULL,
  actual_result TEXT,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  undo_available_until TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

-- Training wheels pattern tracking
CREATE TABLE action_patterns (
  id TEXT PRIMARY KEY,
  pattern_hash TEXT NOT NULL UNIQUE,
  action_type TEXT NOT NULL,
  description TEXT NOT NULL,
  total_occurrences INTEGER NOT NULL DEFAULT 0,
  total_approvals INTEGER NOT NULL DEFAULT 0,
  total_rejections INTEGER NOT NULL DEFAULT 0,
  current_trust_level INTEGER NOT NULL DEFAULT 0,
  graduated_at TEXT,
  non_graduatable INTEGER NOT NULL DEFAULT 0
);

-- Durable workflow state machine
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','waiting_reply','waiting_confirmation','completed','cancelled','failed')),
  state TEXT NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 0,
  slack_channel TEXT, slack_thread_ts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  last_checkpoint TEXT
);
```

### Retrieval Score

```typescript
function retrievalScore(memory: Memory, queryEmbedding: Float32Array): number {
  const hoursSinceAccess = hoursBetween(
    new Date(memory.last_accessed_at ?? memory.created_at), new Date()
  );
  const recency = Math.exp(-0.01 * hoursSinceAccess);  // ~0.78 after 24h, ~0.50 after 72h
  const importance = memory.importance / 10;             // normalized 0-1
  const relevance = cosineSimilarity(queryEmbedding, memory.embedding); // 0-1

  return recency * importance * relevance;
}
```

---

## MCP Server Inventory

### Built-in Servers

| Server | Type | Tools | Details |
|--------|------|-------|---------|
| **Slack** | Custom | `search_messages`, `post_message`, `get_thread`, `get_user_info`, `list_channels`, `add_reaction` | Socket Mode, sender verification, streaming |
| **Gmail** | Custom | `search_emails`, `send_email`, `get_thread`, `create_draft`, `list_labels`, `get_attachment` | OAuth2, SendAs alias, output sanitizer |
| **Drive** | Custom | `search_files`, `get_metadata`, `update_permissions`, `create_sharing_link`, `list_recent`, `get_file_content` | OAuth2, permission tracking |
| **Calendar** | Custom | `list_events`, `find_free_time`, `create_event`, `update_event`, `get_event` | OAuth2, preference-aware |
| **GitHub** | Official | *Full GitHub API surface* | Go-based, fine-grained PAT |
| **Filesystem** | Official | `read_file`, `write_file`, `list_directory`, `search_files`, `get_file_info` | Sandboxed, PreToolUse path validation |
| **Memory** | Custom | `store_memory`, `search_memory`, `get_person`, `update_person`, `store_person`, `get_context` | Triple-factor retrieval, hybrid search |

### Plugin System

```bash
# Register a new MCP server
clawvato plugin add --name "notion" --command "npx @notion-mcp/server" --permission read_write

# List, remove, test
clawvato plugin list
clawvato plugin remove notion
clawvato plugin test notion
```

---

## Example Workflows

### "Can you give edit access to that file I sent yesterday?"

```
1. CLASSIFY (Haiku): intent=file_permission_change, confidence=0.95
2. PLAN (Opus):
   - Search Slack for files sent by user in last 48h
   - Identify most likely file from conversation context
   - Determine recipient from thread context
   - Propose permission change
3. VALIDATE: PreToolUse hooks check each planned step
4. EXECUTE (Sonnet):
   a. slack.search_messages("from:me has:link", last_48h) → 3 results
   b. Rank by relevance to current conversation context
   c. gdrive.get_metadata(file_id) → "Q1 Report.docx"
   d. Identify @sarah from thread context
   e. memory.get_person(slack_id="sarah") → sarah@company.com
5. CONFIRM (Slack Block Kit):
   "I'll give Sarah (sarah@company.com) edit access to
    'Q1 Report.docx'. [✅ Yes] [❌ No] [✏️ Modify]"
6. ON APPROVE:
   a. gdrive.update_permissions(file_id, sarah@company.com, "writer")
   b. PostToolUse: log action, scan output for secrets
   c. slack.reply("Done — Sarah now has edit access to Q1 Report.docx")
   d. memory.store_memory("Shared Q1 Report with Sarah on {date}")
```

### "Find 30 minutes with Jake next week"

```
1. CLASSIFY (Haiku): intent=schedule_meeting, confidence=0.92
2. PLAN (Opus):
   - Resolve "Jake" → person
   - Check calendar for next week
   - Determine internal vs external
   - Compose scheduling email
3. EXECUTE (Sonnet):
   a. memory.get_person("Jake") → Jake Martinez, jake@othercorp.com (external)
   b. calendar.find_free_time(next_week, 30min) → 8 slots
   c. Filter by user preferences (no before 10am, no Fridays)
   d. Select top 4 slots
4. CONFIRM:
   "I'll email Jake Martinez (jake@othercorp.com) proposing:
    • Tue Mar 10, 10:30–11:00am
    • Tue Mar 10, 2:00–2:30pm
    • Wed Mar 11, 11:00–11:30am
    • Thu Mar 12, 3:00–3:30pm
    [✅ Send] [✏️ Edit] [❌ Cancel]"
5. ON APPROVE:
   a. gmail.send(to: jake@othercorp.com, from: clawvato@yourdomain.com)
   b. workflows.create(type="scheduling", status="waiting_reply")
6. ON REPLY (async, hours/days later):
   a. gmail.poll() → Jake replies "Tuesday 2pm works!"
   b. calendar.create_event(Tue 2pm, 30min, [user, jake])
   c. gmail.reply("Great, calendar invite sent!")
   d. slack.dm("Jake confirmed Tuesday 2:00-2:30pm. Calendar invite sent.")
   e. workflows.update(status="completed")
```

---

## Feature Roadmap (from Research)

| Feature | Description | Phase |
|---------|-------------|-------|
| **Context Bridge** | Cross-source intelligence — connect dots across Slack, email, calendar, files, GitHub | Proactive Intelligence |
| **Ghost Draft Mode** | Prepare everything, execute nothing — show in Slack with one-click send | Core (default for outbound) |
| **Relationship Intelligence** | Rich profiles: communication frequency, preferred channels, response patterns, relationship graph | Memory + Proactive |
| **Undo Window** | 5-minute undo for graduated (auto-approved) actions | Training Wheels L2+ |
| **Daily Briefing** | Morning DM: calendar prep, pending items, draft responses, PR/issue triage | Proactive Intelligence |
| **Teach Me Mode** | Explicit user-taught preferences: high-confidence, non-decaying | Memory (always available) |
| **Web Research** | Playwright MCP for lightweight research: pricing, LinkedIn lookups, pre-meeting prep | Plugin (Track G) |
| **Suggestion Mode** | Proactive action suggestions with trainable thumbs-up/down | Proactive Intelligence |

---

## Build Plan Summary

Full plan in [BUILD_PLAN.md](docs/BUILD_PLAN.md). 8 tracks across 5 sessions:

```
Session 1: Track A (Core Foundation)
Session 2: Tracks B + C + D (parallel: Slack, Google, Memory)
Session 3: Tracks E + F (parallel: Workflows, Security)
Session 4: Tracks G + H (parallel: GitHub/FS/Web, Proactive)
Session 5: Integration Testing + Polish

Minimum Viable Agent: After Session 3
  → Slack interaction, Google Workspace, memory, security, basic workflows
```

---

## File Structure

```
clawvato/
├── src/
│   ├── agent/
│   │   ├── index.ts               # Agent SDK configuration + bootstrap
│   │   ├── hooks.ts               # PreToolUse / PostToolUse hook definitions
│   │   ├── model-router.ts        # Haiku/Opus/Sonnet routing logic
│   │   └── planner.ts             # Plan-Then-Execute orchestration
│   ├── security/
│   │   ├── sender-verify.ts       # Single-principal authority check
│   │   ├── output-sanitizer.ts    # Scan outbound for secrets/PII
│   │   ├── path-validator.ts      # Filesystem sandboxing (PreToolUse)
│   │   ├── rate-limiter.ts        # Per-action-type rate limits
│   │   └── credentials.ts        # macOS Keychain integration
│   ├── training-wheels/
│   │   ├── policy-engine.ts       # Trust level enforcement
│   │   ├── confirmation.ts        # Slack confirmation flows (Block Kit)
│   │   └── graduation.ts         # Pattern tracking & level upgrades
│   ├── mcp-servers/
│   │   ├── slack/
│   │   │   ├── index.ts           # Slack MCP server entry
│   │   │   ├── tools.ts           # Tool definitions
│   │   │   └── socket-mode.ts     # Socket Mode connection + streaming
│   │   ├── gmail/
│   │   │   ├── index.ts           # Gmail MCP server entry
│   │   │   ├── tools.ts           # Tool definitions
│   │   │   └── polling.ts         # History-based email monitoring
│   │   ├── gdrive/
│   │   │   ├── index.ts           # Drive MCP server entry
│   │   │   └── tools.ts           # Tool definitions
│   │   ├── gcalendar/
│   │   │   ├── index.ts           # Calendar MCP server entry
│   │   │   └── tools.ts           # Tool definitions
│   │   ├── memory/
│   │   │   ├── index.ts           # Memory MCP server entry
│   │   │   ├── tools.ts           # Store, search, get_context tools
│   │   │   ├── retrieval.ts       # Triple-factor scoring + RRF hybrid search
│   │   │   ├── extraction.ts      # Fact extraction pipeline (Haiku)
│   │   │   └── consolidation.ts   # Nightly consolidation job
│   │   └── google-auth.ts         # Shared OAuth2 for Gmail/Drive/Calendar
│   ├── embeddings/
│   │   ├── worker.ts              # Worker thread: all-MiniLM-L6-v2
│   │   └── index.ts              # Main thread API for embedding requests
│   ├── workflows/
│   │   ├── engine.ts              # SQLite-backed durable state machine
│   │   ├── scheduling.ts          # Multi-turn scheduling workflow
│   │   └── file-sharing.ts        # File permission workflow
│   ├── proactive/
│   │   ├── briefing.ts            # Daily briefing generator
│   │   ├── patterns.ts            # Behavior pattern detection
│   │   └── suggestions.ts         # Proactive action suggestions
│   ├── db/
│   │   ├── schema.ts              # Full SQLite schema + migrations
│   │   └── index.ts               # DB connection (better-sqlite3 + WAL)
│   ├── cli/
│   │   ├── index.ts               # CLI entry point
│   │   ├── start.ts               # Start agent process
│   │   ├── status.ts              # Health check + status
│   │   ├── plugin.ts              # Plugin management
│   │   └── memory.ts              # Memory search/export/forget
│   └── index.ts                   # Main entry point
├── config/
│   ├── default.json               # Default configuration
│   └── launchd.plist              # macOS auto-start config
├── docs/
│   ├── BUILD_PLAN.md              # Parallelized multi-session build plan
│   ├── SPEC_MEMORY_V2.md          # Research-hardened memory architecture
│   ├── SPEC_INTEGRATIONS.md       # Detailed integration specifications
│   ├── RESEARCH_SYNTHESIS.md      # Research findings & feature recommendations
│   └── MEMORY_ARCHITECTURE.md     # Original memory deep-dive
├── tests/
├── package.json
├── tsconfig.json
└── AGENT_SPEC.md                  # This file
```

---

## Cost Estimate (Monthly)

| Component | Cost |
|-----------|------|
| Claude API (Sonnet primary, Opus planning, Haiku classification) | $20-80 |
| Memory operations (Haiku extraction + importance + reflection + consolidation) | ~$1.23 |
| Google Workspace (agent's email identity) | $7.20 |
| Local embeddings | $0 |
| Local SQLite + sqlite-vec | $0 |
| Electricity (Mac Mini 24/7) | ~$3 |
| **Total** | **~$30-90/mo** |

No hosting, no managed database, no Redis, no vector DB service, no embedding API fees.

---

## CLI Reference

```bash
# Lifecycle
clawvato start                    # Start the agent
clawvato stop                     # Stop gracefully
clawvato restart                  # Restart
clawvato status                   # Health, uptime, pending workflows

# Plugins
clawvato plugin add <name> <cmd>  # Register an MCP server
clawvato plugin list              # List registered plugins
clawvato plugin remove <name>     # Unregister a plugin
clawvato plugin test <name>       # Health-check a plugin

# Memory
clawvato memory search <query>    # Hybrid search (keyword + semantic)
clawvato memory people            # List known people
clawvato memory export            # Full data export (JSON)
clawvato memory forget <id>       # Delete a specific memory
clawvato memory consolidate       # Run consolidation manually

# Security
clawvato audit                    # Recent action log
clawvato audit --type send_email  # Filter by action type
clawvato trust-level              # Current training-wheels level
clawvato trust-level set <N>      # Override (with confirmation)
clawvato credentials rotate       # Rotate all stored credentials
clawvato credentials check        # Verify all credentials are valid

# Config
clawvato config show              # Show current config
clawvato config set <key> <val>   # Update config
```

---

## Anti-Patterns to Avoid

| Anti-Pattern | Our Mitigation |
|---|---|
| Dumping all memory into every prompt | Token-budgeted tiered retrieval (max ~2200 tokens/request) |
| No step limits or cost budgets | Per-request token budget, per-action rate limits, circuit breakers |
| Vector DB before you need it | Start with structured queries + FTS5, vector for semantic gap only |
| Relying on prompting for security | Architectural: Plan-Then-Execute + sender verify + PreToolUse hooks |
| No crash recovery | SQLite-backed workflow checkpointing, replay from last checkpoint |
| Static API keys in prompts | Keychain storage, injected at tool execution time, never in LLM context |
| Implicit agent communication | Typed tool calls, structured plans, no free-form inter-agent messages |
