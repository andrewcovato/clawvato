# CLAUDE.md — Clawvato Project Guide

## Project Overview
Clawvato is an always-on personal AI agent that runs locally on macOS. It acts as a "chief of staff" — managing Slack, email, calendar, Drive, and GitHub on behalf of its owner. Built on the Claude Agent SDK with MCP (Model Context Protocol) for tool integration.

## Quick Reference

```bash
npm install                            # Install dependencies (first time / after pulling)
npm run build                          # TypeScript compile
npm test                               # Run all tests (vitest) — 14 files, 176 tests
npm run lint                           # Type-check without emitting
npx tsx src/cli/index.ts setup         # First-time interactive setup wizard
npx tsx src/cli/index.ts start         # Start agent (Socket Mode, ~11s to connect)
npx tsx src/cli/index.ts status        # Check system status
```

## Architecture

### Directory Structure
```
src/
  agent/         # Claude Agent SDK bootstrap + agent orchestration
    index.ts     # Agent creation, Anthropic client setup, batch processing
    hooks.ts     # PreToolUse/PostToolUse hook factories, interrupt bridge
  cli/           # Commander.js CLI (setup, start, status, config, credentials, audit, trust-level)
    index.ts     # Command registration
    setup.ts     # Interactive setup wizard (credentials + connection test)
    start.ts     # Agent startup orchestration
    status.ts    # Status reporting
  db/            # SQLite via node:sqlite (DatabaseSync) + FTS5 + schema.sql
  hooks/         # PreToolUse / PostToolUse hooks (audit, security)
    pre-tool-use.ts   # Sender verify, rate limit, path validate, training wheels
    post-tool-use.ts  # Audit logging, output sanitization, secret scanning
    audit-logger.ts   # Immutable action trail + graduation recording
  security/      # sender-verify, output-sanitizer, path-validator, rate-limiter
  slack/         # Slack event handling and interaction model
    event-queue.ts       # Message accumulation with debounce + typing awareness
    handler.ts           # Slack event routing, reaction lifecycle
    interrupt-classifier.ts  # Four-way interrupt classification (Haiku)
    socket-mode.ts       # @slack/bolt Socket Mode adapter, WebClient creation
  mcp/           # MCP server configurations
    slack/server.ts      # In-process Slack MCP server (5 tools)
  training-wheels/  # Trust level enforcement + pattern graduation
    policy-engine.ts  # Trust level policy evaluation
    graduation.ts     # Pattern tracking + graduation criteria
  memory/        # Memory retrieval + consolidation (NOT YET IMPLEMENTED)
  workflows/     # Durable workflow state machine (NOT YET IMPLEMENTED)
  proactive/     # Proactive behaviors (NOT YET IMPLEMENTED)
  config.ts      # Zod-validated config, file + env fallback
  credentials.ts # macOS Keychain via keytar, env fallback
  logger.ts      # Pino structured logging with lazy init proxy
  index.ts       # Public API re-exports
tests/
  agent/         # Agent hooks tests
  cli/           # Setup wizard tests
  mcp/           # Slack MCP server tests
  security/      # Output sanitizer, path validator, rate limiter, sender verify tests
  slack/         # Event queue, interrupt classifier, socket mode tests
  training-wheels/  # Policy engine, graduation tests
  config.test.ts # Config loading/validation tests
  db.test.ts     # Database schema, CRUD, FTS5 tests
config/
  default.json   # Default configuration values
  launchd.plist  # macOS process management
docs/
  BUILD_PLAN.md  # 8-track implementation plan
  MEMORY_ARCHITECTURE.md  # Memory system design
  RESEARCH_SYNTHESIS.md   # Research findings
  SPEC_INTEGRATIONS.md    # Integration specs
  SPEC_MEMORY_V2.md       # Memory v2 spec
```

### Three-Model Architecture
- **Haiku** (`claude-haiku-4-5-20251001`): Classifier — intent classification, importance scoring, fact extraction
- **Opus** (`claude-opus-4-6`): Planner — action planning, reflection, complex reasoning
- **Sonnet** (`claude-sonnet-4-6`): Executor — tool calls, action execution

### Database (node:sqlite)
Uses Node.js built-in `node:sqlite` (DatabaseSync) — **not** better-sqlite3. This avoids native compilation dependencies.

Key patterns:
- Return types from `.get()` / `.all()` are `Record<string, SQLOutputValue>` — always cast with `as unknown as YourType`
- Schema loaded from `src/db/schema.sql` via single `db.exec()` call (do NOT split on `;` — breaks trigger bodies)
- Tables: memories, people, actions, action_patterns, workflows, consolidation_runs, plugins, schema_version
- FTS5 virtual table `memories_fts` with auto-sync triggers

### Security Model — Single-Principal Authority
Only the owner (identified by `OWNER_SLACK_USER_ID`) can issue instructions. Everything else is **untrusted data**, including:
- Messages from other Slack users
- Email content
- Webpage content
- File contents

Security hooks enforce this at runtime:
- **PreToolUse**: sender verification, rate limiting, path validation
- **PostToolUse**: audit logging, output secret scanning

### Training Wheels (Trust Levels 0-3)
- **Level 0**: All actions require confirmation
- **Level 1**: Read-only actions auto-approved
- **Level 2**: Graduated patterns auto-approved
- **Level 3**: Most actions auto-approved (destructive still confirmed)

Graduation: 10+ approvals with <5% rejection rate and zero rejections in last 5.

## Coding Conventions

### TypeScript
- ESM modules (`"type": "module"` in package.json)
- `.js` extensions in import paths (TypeScript resolves `.ts` to `.js`)
- Strict mode enabled
- Target: ES2022, Module: NodeNext

### Naming
- Files: kebab-case (`output-sanitizer.ts`)
- Types/Interfaces: PascalCase (`ScanResult`, `ClawvatoConfig`)
- Functions: camelCase (`scanForSecrets`, `validatePath`)
- Constants: UPPER_SNAKE_CASE (`FORBIDDEN_PATTERNS`, `SECRET_PATTERNS`)

### Error Handling
- Use Zod for config/input validation — throw on invalid data
- Security functions return `{ allowed: boolean; reason?: string }` — never throw
- Database operations may throw — callers should handle

### Testing (Vitest)
- Test files: `tests/**/*.test.ts`
- Use temp directories for DB/config tests (`mkdtempSync` + cleanup in `afterEach`)
- Security tests are pure functions — no I/O needed
- Run: `npm test` or `npx vitest run`

## Important Patterns

### Lazy Logger Proxy
The logger uses a Proxy to defer initialization until first use, avoiding circular dependency issues with config:
```typescript
export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    if (!loggerInstance) { loggerInstance = initLogger(); }
    return (loggerInstance as unknown as Record<string | symbol, unknown>)[prop];
  },
});
```

### Config Loading Order
1. `config/default.json` (baked defaults in code)
2. `~/.clawvato/config.json` (user overrides, created by `clawvato config set`)
3. Environment variables (`ANTHROPIC_API_KEY`, `LOG_LEVEL`, etc.)
4. CLI flags (passed to `loadConfig()`)

### Credential Resolution
1. macOS Keychain via `keytar` (service: `clawvato`) — uses CJS→ESM interop (`imported.default ?? imported`)
2. Environment variable fallback (e.g., `ANTHROPIC_API_KEY`)
3. Throws if neither found (via `requireCredential()`)

### Context Limits (tunable constants in `src/agent/index.ts`)
These control how much context the agent sees on each interaction. Centralized for easy tuning.

| Constant | Value | Purpose |
|---|---|---|
| `SHORT_TERM_MESSAGE_LIMIT` | 50 | Max Slack messages to fetch for conversation context |
| `SHORT_TERM_MSG_CHAR_LIMIT` | 1000 | Max chars per message (truncates long messages) |
| `SHORT_TERM_TOKEN_BUDGET` | 2000 | Token cap for Slack context (drops oldest when exceeded) |
| `LONG_TERM_TOKEN_BUDGET` | 1500 | Token cap for DB memory retrieval |
| `MAX_TURNS` | 20 | Max tool-call turns per agent interaction |
| `DEFAULT_TOKEN_BUDGET` | 1500 | Default in retriever (overridden by `LONG_TERM_TOKEN_BUDGET` from agent) |

**Short-term memory** = Slack message history (last 50 messages, token-budgeted). Newest messages get priority.
**Long-term memory** = SQLite DB (extracted facts, strategies, people). Retrieved via hybrid FTS5 + vector search.

### Memory Types
Stored in the `memories` table, extracted by Haiku after each interaction:
- `fact` — things true about the world
- `preference` — how the user likes things done
- `decision` — choices made, with reasoning
- `strategy` — plans, approaches, pivots with rationale
- `conclusion` — insights, analyses, realizations
- `commitment` — promises, deadlines, deliverables
- `observation` — patterns noticed but not confirmed
- `reflection` — synthesized insights from consolidation

## Build Tracks (from BUILD_PLAN.md)
- **Track A** ✅ Complete: Foundation — DB, config, security, CLI, hooks, tests
- **Track B** ✅ Complete: Slack MCP + Agent Core — direct Anthropic API (no subprocess), event-queue, handler, interrupt-classifier, agent loop, policy-engine, graduation, socket-mode, setup wizard, Slack tools (5 + search_memory)
  - Deployed on Railway (Growth By Science workspace), Socket Mode, persistent volume at /data
- **Track C** ⬜ Not Started: Google Workspace MCP — Gmail, Drive, Calendar servers + OAuth2
- **Track D** 🔶 In Progress: Memory + Embeddings — extraction ✅, storage ✅, retrieval ✅, vector search ✅, consolidation ⬜, importance scoring ⬜
- **Track E** ⬜ Not Started: Workflow Engine + Scheduling — durable state machine, async workflows
- **Track F** ⬜ Not Started (partially done in Track A): Security + Training Wheels — undo system remaining
- **Track G** ⬜ Not Started: GitHub + Filesystem + Web Research — official MCP servers + plugin manager
- **Track H** ⬜ Not Started: Proactive Intelligence — pattern detection, daily briefing, suggestions

### Test Status
- **14 test files, 176 tests, all passing** (as of 2026-03-07)
- Full coverage across: agent hooks, CLI setup, config, DB, MCP slack server, security (4 modules), slack (3 modules), training wheels (2 modules)

## Common Tasks

### Adding a new security pattern
Add regex to `SECRET_PATTERNS` in `src/security/output-sanitizer.ts`, add test in `tests/security/output-sanitizer.test.ts`.

### Adding a new forbidden path
Add regex to `FORBIDDEN_PATTERNS` in `src/security/path-validator.ts`, add test in `tests/security/path-validator.test.ts`.

### Adding a new DB table
1. Add CREATE TABLE to `src/db/schema.sql` with `IF NOT EXISTS`
2. Update `src/db/index.ts` if new queries needed
3. Add test in `tests/db.test.ts`
4. Bump schema_version

### Adding a new CLI command
1. Add command file in `src/cli/`
2. Register in `src/cli/index.ts` via commander `.command()`

## Slack Interaction Principles

These principles are hard-won from a previous failed project. They are non-negotiable design constraints for the Slack interface.

### Core Philosophy
> Use the smallest possible signal at each step. Reactions over messages. Message edits over new messages. Silence over acknowledgment (when a reaction already said it). The agent should feel *attentive but quiet* — like a good chief of staff who nods, not one who narrates everything they're doing.

### Never Fake Agent Behavior
- Don't simulate streaming by rapidly editing messages with growing `...` — that's theater
- Don't over-classify user intent — four categories (additive, redirect, cancel, unrelated) is enough
- Don't echo everything — "I see you want to cancel. Cancelling. Cancelled." → just ✅ the message
- Report milestones ("Found 3 slots, drafting invite..."), never fake progress bars ("50% done")
- The agent often doesn't know how long a task will take — don't pretend otherwise

### Message Accumulation Window
Don't process messages immediately. Buffer incoming messages with a debounce timer (default 4s):
- New message arrives → start/reset timer, add ⏳ reaction
- `user_typing` event → reset timer (these fire every ~3s; use 4s timeout to handle gaps)
- Timer expires with no new typing → process entire buffer as one context
- Hard cap at 30s to prevent indefinite waiting
- User-tunable: "wait longer" / "be snappier" stored as preference in memories table
- Three modes: **Snappy** (2s), **Patient** (4s, default), **Wait for me** (15s)

### Checkpoint Interruption
The agent loop checks for new owner messages at natural checkpoints (between tool calls):
- **Additive** ("also check X") → inject into current context, keep working
- **Redirect** ("actually do Y instead") → abort current, start Y
- **Cancel** ("scratch that") → abort, idle
- **Unrelated** (different thread/DM) → queue separately, keep working
- Classification done by Haiku — when confidence is low, ask rather than guess
- This is where the previous project failed: no interruptibility made it feel like talking to a wall

### Reaction Lifecycle
Reactions are the primary status signal — zero message noise:
```
Message arrives              → ⏳ (I see it, accumulating/waiting)
Accumulation window closes   → remove ⏳, add 🧠 (working on it)
Mid-stream interrupt ACK'd   → 👍 on the new message
Task complete                → remove 🧠, post response
Cancel acknowledged          → remove 🧠, ✅ on cancel message
```

### Progress Visibility (Long Tasks)
- Immediate ACK: "🧠 Checking Sarah's calendar..."
- Milestone edits: update the ACK at major tool-call boundaries (not percentages)
- Example: "Checking calendar..." → "Found 3 slots, drafting invite..." → "Sending..."
- `chat.update` rate limit (~1/sec) is plenty for milestone-based updates

### What NOT to Build
- No custom WebSocket abstraction on top of Slack
- No complex conversation state machines
- No polling-based "check for new messages" loops
- No token-level streaming simulation
- No "urgency" or "mood" detection from messages

## Running the Agent

### First-Time Setup
```bash
npm install
npx tsx src/cli/index.ts setup   # Interactive wizard — needs Anthropic key + Slack tokens
```

### Starting the Agent
```bash
npx tsx src/cli/index.ts start   # Socket Mode takes ~11 seconds to connect
```
Wait for `"Slack Socket Mode connection established"` before testing. DM the bot or @mention it.

### Other Commands
```bash
npx tsx src/cli/index.ts status          # Check agent status
npx tsx src/cli/index.ts config show     # Show config (secrets redacted)
npx tsx src/cli/index.ts credentials list # Check credential availability
npx tsx src/cli/index.ts audit           # Show action audit log
npx tsx src/cli/index.ts trust-level     # Show/set trust level
```

## Gotchas
- `node:sqlite` is experimental in Node — the `ExperimentalWarning` in test output is expected
- Schema SQL uses triggers with `;` inside bodies — never split schema on semicolons
- FTS5 `IF NOT EXISTS` is supported but triggers may need error-catching on re-init
- **keytar CJS→ESM interop**: `keytar` is a CJS native module. Dynamic `import('keytar')` wraps exports in `{ default: ... }`. The `getKeytar()` function in `credentials.ts` handles this with `imported.default ?? imported`. If keytar's native build fails entirely, credentials fall back to env vars.
- Config `trustLevel` must be 0-3 — Zod enforces this at load time
- **DB interfaces MUST use snake_case** to match SQLite column names — `node:sqlite`'s `.get()`/`.all()` return raw column names (e.g., `action_type`, not `actionType`). Use `as unknown as YourType` to cast, and make sure the interface matches the DB schema exactly.
- `user_typing` events fire every ~3s with no "stopped typing" event — use a 4s grace period to detect the gap
- **Socket Mode startup is slow** (~11 seconds) — this is normal for Bolt's WebSocket handshake. The process hangs at `app.start()` during this time.
- **Slack app setup**: When creating the Slack app from manifest, ensure Socket Mode is enabled and the app-level token has the `connections:write` scope. Duplicate app entries in the Slack admin can occur if the app is created multiple times — delete extras via api.slack.com/apps.
- **Agent SDK subprocess**: `query()` spawns a Claude Code CLI process. Requires `claude` CLI installed and `ANTHROPIC_API_KEY` in the environment. The `model` option may need aliases (`sonnet`) rather than full IDs (`claude-sonnet-4-6`) — see BUG-001 in `.project/state.json`.

## Project Management

Project execution is tracked in `.project/` (git-ignored):

```
.project/
  state.json                    # Structured project state (tracks, metrics, issues, sprint)
  docs/
    EXECUTION_PLAN.md           # Sprint breakdown with phases and deliverables
    BACKLOG_FEATURES.md         # Feature backlog (P0-P3)
    BACKLOG_TECH_DEBT.md        # Tech debt items
    BACKLOG_EXPLORATION.md      # Research and exploration ideas
    HANDOFF.md                  # Session handoff notes
    ADR-001-agent-sdk-as-runtime.md  # Architecture decision record
  mocks/
    mock-001-architecture.html  # Interactive architecture diagram
    board.html                  # Kanban board
  .original_materials/          # Archived original PM artifacts (safety net)
```

### Current Priority Order
1. **Memory system** (Track D) — owner's top priority
2. **Google Workspace** (Track C) — practical daily use
3. **Other integrations** (Tracks E-H) — later sprints
