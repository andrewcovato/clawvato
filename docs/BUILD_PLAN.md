# Build Plan: Parallelized Multi-Session Execution

## Architecture Principle

The agent is built on the **Claude Agent SDK** as its runtime. Our code defines:
- MCP servers (Slack, Gmail, Drive, Calendar, Memory)
- Hooks (security, training wheels, audit logging)
- Configuration (model routing, tool permissions, sandbox paths)
- The workflow engine (SQLite-backed durable state machine)

The Agent SDK handles the agent loop, tool routing, MCP connections, and model calls.

---

## Dependency Graph

```
                    ┌─────────────────────────────┐
                    │  TRACK A: Core Foundation   │
                    │  (must be first)             │
                    └──────────┬──────────────────┘
                               │
            ┌──────────────────┼──────────────────┐
            │                  │                   │
   ┌────────▼────────┐ ┌──────▼───────┐ ┌────────▼────────┐
   │  TRACK B:       │ │  TRACK C:    │ │  TRACK D:       │
   │  Slack MCP +    │ │  Google MCP  │ │  Memory +       │
   │  Agent Core     │ │  Servers     │ │  Embeddings     │
   │                 │ │              │ │                  │
   │  (blocks E,F)   │ │  (blocks E)  │ │  (blocks F)     │
   └────────┬────────┘ └──────┬───────┘ └────────┬────────┘
            │                  │                   │
            │      ┌───────────┼───────────────────┘
            │      │           │
   ┌────────▼──────▼──┐  ┌────▼──────────────┐
   │  TRACK E:        │  │  TRACK F:         │
   │  Workflow Engine  │  │  Security +       │
   │  + Scheduling     │  │  Training Wheels  │
   └────────┬──────────┘  └────────┬──────────┘
            │                      │
            └──────────┬───────────┘
                       │
              ┌────────▼────────┐
              │  TRACK G:       │
              │  GitHub + FS +  │
              │  Web Research   │
              └────────┬────────┘
                       │
              ┌────────▼────────┐
              │  TRACK H:       │
              │  Proactive      │
              │  Intelligence   │
              └─────────────────┘
```

**Parallelizable**: Tracks B, C, D can all be built simultaneously after Track A.

---

## Track A: Core Foundation

**Session**: 1 (solo, must complete first)
**Estimated effort**: 1 session

### Tasks

1. **Project scaffolding**
   ```
   clawvato/
   ├── src/
   │   ├── index.ts              # Entry point
   │   ├── config.ts             # Config loading
   │   ├── credentials.ts        # Keychain integration
   │   ├── db/
   │   │   ├── index.ts          # SQLite connection + migrations
   │   │   └── schema.sql        # Full schema
   │   ├── agent/
   │   │   └── index.ts          # Agent SDK setup
   │   ├── mcp/
   │   │   └── (server dirs)
   │   ├── hooks/
   │   │   ├── pre-tool-use.ts
   │   │   ├── post-tool-use.ts
   │   │   └── audit-logger.ts
   │   ├── security/
   │   │   ├── sender-verify.ts
   │   │   ├── output-sanitizer.ts
   │   │   └── rate-limiter.ts
   │   ├── workflows/
   │   │   └── engine.ts
   │   └── cli/
   │       └── index.ts
   ├── package.json
   ├── tsconfig.json
   └── .env.example
   ```

2. **Dependencies**
   ```json
   {
     "dependencies": {
       "@anthropic-ai/claude-agent-sdk": "latest",
       "@modelcontextprotocol/sdk": "latest",
       "@slack/bolt": "latest",
       "googleapis": "latest",
       "google-auth-library": "latest",
       "better-sqlite3": "latest",
       "sqlite-vec": "latest",
       "@huggingface/transformers": "latest",
       "pino": "latest",
       "commander": "latest",
       "keytar": "latest",
       "zod": "latest"
     },
     "devDependencies": {
       "typescript": "latest",
       "vitest": "latest",
       "@types/better-sqlite3": "latest",
       "tsx": "latest"
     }
   }
   ```

3. **SQLite database setup** — Create all tables from SPEC_MEMORY_V2.md schema

4. **Credential manager** — Keychain read/write via `keytar`, encrypted JSON fallback

5. **Config system** — `~/.clawvato/config.json` with defaults

6. **Structured logging** — Pino logger with audit trail writes to `actions` table

7. **CLI skeleton** — `clawvato start`, `clawvato status`, `clawvato config`

8. **Process management** — launchd plist for macOS auto-start

### Deliverable
Agent process starts, connects to SQLite, loads config, has CLI interface. No integrations yet.

### Files to create
- `src/index.ts`
- `src/config.ts`
- `src/credentials.ts`
- `src/db/index.ts`
- `src/db/schema.sql`
- `src/cli/index.ts`
- `src/cli/start.ts`
- `src/cli/status.ts`
- `package.json`
- `tsconfig.json`
- `.env.example`
- `config/default.json`
- `config/launchd.plist`

---

## Track B: Slack MCP Server + Agent Core

**Session**: 2 (can run parallel with C, D)
**Depends on**: Track A
**Estimated effort**: 1-2 sessions

### Tasks

1. **Slack MCP server** (`src/mcp/slack/`)
   - Socket Mode initialization with Bolt SDK
   - Event handlers: `app_mention`, `message.im`
   - Tools: `slack_search_messages`, `slack_post_message`, `slack_post_confirmation`, `slack_get_thread`, `slack_get_user_info`, `slack_stream_response`
   - Sender verification middleware
   - Interactive button handler for confirmations
   - Chat streaming for LLM responses
   - Reconnection and catch-up polling

2. **Agent orchestrator** (`src/agent/`)
   - Claude Agent SDK `query()` setup
   - MCP server registration (Slack server as first connection)
   - Model routing: Haiku for classification, Sonnet for execution
   - Hook registration (PreToolUse, PostToolUse)
   - Session management

3. **Slack app creation**
   - Create Slack app with manifest from SPEC_INTEGRATIONS.md
   - Generate tokens (bot, user, app-level)
   - Store in Keychain

### Deliverable
"@clawvato what did I share in #general yesterday?" → searches Slack, returns answer.

### Files to create
- `src/mcp/slack/server.ts`
- `src/mcp/slack/tools.ts`
- `src/mcp/slack/events.ts`
- `src/mcp/slack/confirmations.ts`
- `src/mcp/slack/streaming.ts`
- `src/agent/index.ts`
- `src/agent/model-router.ts`
- `src/hooks/pre-tool-use.ts`
- `src/hooks/post-tool-use.ts`
- `src/hooks/audit-logger.ts`

---

## Track C: Google Workspace MCP Servers

**Session**: 2 (can run parallel with B, D)
**Depends on**: Track A
**Estimated effort**: 1-2 sessions

### Tasks

1. **Google OAuth2 setup** (`src/google/auth.ts`)
   - Desktop OAuth flow with loopback redirect
   - Token storage in Keychain
   - Auto-refresh with `tokens` event listener
   - First-run browser consent flow

2. **Gmail MCP server** (`src/mcp/gmail/`)
   - Tools: `gmail_search`, `gmail_get_message`, `gmail_get_thread`, `gmail_send`, `gmail_create_draft`, `gmail_check_new`
   - SendAs alias configuration for agent identity
   - Email polling loop (30s interval)
   - Output sanitizer integration (scan outbound for secrets)

3. **Google Drive MCP server** (`src/mcp/gdrive/`)
   - Tools: `drive_search`, `drive_get_file`, `drive_get_file_id_from_url`, `drive_update_permissions`, `drive_list_permissions`, `drive_get_sharing_history`
   - URL-to-file-ID extraction regex
   - Drive Activity API integration

4. **Google Calendar MCP server** (`src/mcp/gcalendar/`)
   - Tools: `calendar_get_availability`, `calendar_find_slots`, `calendar_list_events`, `calendar_create_event`, `calendar_update_event`
   - Freebusy query implementation
   - Slot-finding algorithm (respects user preferences)
   - Google Meet link generation

### Deliverable
"@clawvato give Sarah edit access to the Q1 report" → finds file in Drive, confirms, shares.
"@clawvato what's on my calendar tomorrow?" → lists events.

### Files to create
- `src/google/auth.ts`
- `src/mcp/gmail/server.ts`
- `src/mcp/gmail/tools.ts`
- `src/mcp/gmail/poller.ts`
- `src/mcp/gdrive/server.ts`
- `src/mcp/gdrive/tools.ts`
- `src/mcp/gdrive/url-parser.ts`
- `src/mcp/gcalendar/server.ts`
- `src/mcp/gcalendar/tools.ts`
- `src/mcp/gcalendar/slot-finder.ts`

---

## Track D: Memory System + Embeddings

**Session**: 2 (can run parallel with B, C)
**Depends on**: Track A
**Estimated effort**: 1-2 sessions

### Tasks

1. **Embedding worker** (`src/memory/embedding-worker.ts`)
   - Worker thread with `@huggingface/transformers`
   - Singleton model loading (all-MiniLM-L6-v2, q8)
   - Batch embedding support
   - Message-based IPC with main thread

2. **Memory MCP server** (`src/mcp/memory/`)
   - Tools: `memory_store_fact`, `memory_search`, `memory_get_person`, `memory_update_person`, `memory_get_action_history`, `memory_get_active_workflows`
   - Triple-factor retrieval implementation
   - Hybrid search (FTS5 + sqlite-vec RRF)
   - Importance scoring (Haiku call at write time)

3. **Retrieval pipeline** (`src/memory/retrieval.ts`)
   - Token-budgeted context assembly (max 1500 tokens)
   - Classification-driven retrieval (people → preferences → decisions → semantic)
   - Pre-agent-call injection into system prompt

4. **Fact extraction** (`src/memory/extractor.ts`)
   - Post-interaction Haiku call to extract structured facts
   - Entity extraction and linking to people table
   - Deduplication against existing memories

5. **Consolidation job** (`src/memory/consolidation.ts`)
   - Nightly cron: merge, supersede, compress, decay, promote, reflect
   - Reflection trigger based on cumulative importance threshold

### Deliverable
Agent remembers facts from past interactions. Hybrid search finds relevant memories. Nightly consolidation runs.

### Files to create
- `src/memory/embedding-worker.ts`
- `src/memory/store.ts`
- `src/memory/retrieval.ts`
- `src/memory/extractor.ts`
- `src/memory/consolidation.ts`
- `src/memory/people-graph.ts`
- `src/mcp/memory/server.ts`
- `src/mcp/memory/tools.ts`

---

## Track E: Workflow Engine + Scheduling

**Session**: 3
**Depends on**: Tracks B + C (needs Slack for interaction, Gmail + Calendar for scheduling)
**Estimated effort**: 1-2 sessions

### Tasks

1. **Workflow engine** (`src/workflows/engine.ts`)
   - SQLite-backed state machine
   - Step checkpointing (crash recovery)
   - Status tracking and expiry
   - Workflow registry (type → handler mapping)

2. **Scheduling workflow** (`src/workflows/scheduling.ts`)
   - States: `finding_slots → proposing_times → waiting_reply → booking → completed`
   - Email composition for time proposals
   - Reply parsing (when Jake says "Tuesday works")
   - Calendar event creation
   - Slack notifications at each step

3. **File sharing workflow** (`src/workflows/file-sharing.ts`)
   - States: `identifying_file → confirming → sharing → notifying → completed`
   - Cross-reference Slack messages with Drive files
   - Permission change execution

4. **Gmail polling integration** — Link incoming emails to active workflows

### Deliverable
"@clawvato find 30min with jake@corp.com next week" → full async scheduling loop that spans hours/days.

### Files to create
- `src/workflows/engine.ts`
- `src/workflows/types.ts`
- `src/workflows/scheduling.ts`
- `src/workflows/file-sharing.ts`

---

## Track F: Security + Training Wheels

**Session**: 3 (can run parallel with E)
**Depends on**: Tracks B + D (needs Slack for confirmations, Memory for action pattern tracking)
**Estimated effort**: 1 session

### Tasks

1. **Output sanitizer** (`src/security/output-sanitizer.ts`)
   - Regex patterns for: API keys, tokens, passwords, SSNs, credit cards
   - Runs before every outbound message/email
   - Blocks and alerts if detected

2. **Rate limiter** (`src/security/rate-limiter.ts`)
   - Per-action-type limits (configurable)
   - Sliding window implementation
   - Circuit breaker (pause + alert on repeated failures)

3. **Training wheels policy engine** (`src/training-wheels/policy-engine.ts`)
   - Trust level management (0-3)
   - Action classification (read vs. write vs. delete)
   - Confirmation flow integration
   - Pattern tracking and graduation logic

4. **Undo system** (`src/training-wheels/undo.ts`)
   - 5-minute undo window for graduated actions
   - Reverse-action registry (share → unshare, etc.)
   - Slack notification with undo button

### Deliverable
Full security pipeline active. Training wheels enforcement. Undo capability for auto-approved actions.

### Files to create
- `src/security/output-sanitizer.ts`
- `src/security/rate-limiter.ts`
- `src/security/path-validator.ts`
- `src/training-wheels/policy-engine.ts`
- `src/training-wheels/confirmation.ts`
- `src/training-wheels/graduation.ts`
- `src/training-wheels/undo.ts`

---

## Track G: GitHub + Filesystem + Web Research

**Session**: 4 (can run parallel with H)
**Depends on**: Track A (just needs the MCP client layer)
**Estimated effort**: 1 session

### Tasks

1. **GitHub MCP server** — Use official server, configure with fine-grained PAT
2. **Filesystem MCP server** — Use official server, add PreToolUse sandbox validation
3. **Web research** — Add `@playwright/mcp` or use built-in `WebSearch`/`WebFetch`
4. **MCP plugin manager** (`src/mcp/plugin-manager.ts`)
   - CLI: `clawvato plugin add/remove/list`
   - Plugin manifest storage (SQLite)
   - Health checks
   - Permission enforcement

### Deliverable
"@clawvato what's the status of PR #42?" → reads from GitHub.
"@clawvato find the config file in my project" → searches local filesystem.
"@clawvato what's the latest pricing for Notion Business?" → web search.

### Files to create
- `src/mcp/plugin-manager.ts`
- `src/cli/plugin.ts`
- MCP server configs (not code — just config entries)

---

## Track H: Proactive Intelligence

**Session**: 4-5 (can run parallel with G)
**Depends on**: Tracks D + E + F (needs memory, workflows, training wheels)
**Estimated effort**: 1-2 sessions

### Tasks

1. **Pattern detector** (`src/proactive/pattern-detector.ts`)
   - Analyze action log for recurring patterns
   - Detect: same action type + similar params + regular cadence
   - Confidence scoring (how many observations, how consistent)

2. **Daily briefing** (`src/proactive/briefing.ts`)
   - Morning DM with: calendar, pending items, emails needing response
   - Pre-meeting context ("Last discussed pricing with Acme")
   - GitHub notifications summary

3. **Context bridge** (`src/proactive/context-bridge.ts`)
   - Cross-source intelligence
   - "Sarah asked about budget in Slack, Jake emailed about budget revisions"
   - Surface connected dots proactively

4. **Suggestion engine** (`src/proactive/suggestions.ts`)
   - "What Would You Do?" mode
   - Proactive action proposals with thumbs-up/down
   - Proactivity level learning from feedback

### Deliverable
Agent suggests automating repetitive tasks. Daily briefing. Cross-source intelligence.

### Files to create
- `src/proactive/pattern-detector.ts`
- `src/proactive/briefing.ts`
- `src/proactive/context-bridge.ts`
- `src/proactive/suggestions.ts`
- `src/proactive/scheduler.ts`

---

## Session Execution Plan

```
Session 1:  Track A (Foundation)
            ────────────────────────────────────────────

Session 2:  Track B (Slack)    ║  Track C (Google)    ║  Track D (Memory)
            ───────────────────║──────────────────────║──────────────────
            PARALLEL — independent tracks

Session 3:  Track E (Workflows)  ║  Track F (Security)
            ─────────────────────║──────────────────────
            PARALLEL — E needs B+C, F needs B+D

Session 4:  Track G (GitHub/FS/Web)  ║  Track H (Proactive)
            ─────────────────────────║──────────────────────
            PARALLEL — G needs A, H needs D+E+F

Session 5:  Integration testing, hardening, polish
            ─────────────────────────────────────────
```

### Minimum Viable Agent (after Session 3)
After completing Tracks A-F, you have:
- Slack interaction with streaming responses
- Gmail search/send with agent email identity
- Drive file management and permission control
- Calendar scheduling with async workflow
- Persistent memory with triple-factor retrieval
- Full security pipeline with training wheels
- Undo capability for graduated actions

This is a fully functional personal AI chief of staff.

---

## Testing Strategy

### Unit Tests (per track)
- Memory: retrieval scoring, consolidation logic, embedding pipeline
- Security: output sanitizer patterns, path validation, rate limiting
- Training wheels: graduation logic, pattern matching
- Workflows: state transitions, checkpoint/recovery

### Integration Tests
- Slack → Agent → Drive (file sharing flow)
- Slack → Agent → Calendar → Gmail (scheduling flow)
- Memory extraction → storage → retrieval round-trip
- Crash recovery (kill process mid-workflow, verify resume)

### Manual Testing Checklist
- [ ] @mention in public channel → agent responds in thread
- [ ] DM → agent responds
- [ ] "Search for X" → agent searches Slack history
- [ ] "Share file with Y" → confirmation → executes
- [ ] "Schedule meeting with Z" → emails Z → books on reply
- [ ] Restart agent mid-workflow → workflow resumes
- [ ] Send message with API key → output sanitizer blocks
- [ ] Another user @mentions agent → agent ignores instruction
- [ ] 5 identical approvals → action pattern graduates
- [ ] Memory from last week → recalled without prompting
