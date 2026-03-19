# CLAUDE.md — Clawvato Project Guide

## Project Overview
Clawvato is an always-on personal AI agent deployed on Railway. It acts as a "chief of staff" — managing Slack, email, calendar, Drive, and meetings on behalf of its owner. Uses a **hybrid architecture**: Haiku routes each message to either a fast path (direct API, ~2s) or a heavy path (Claude Code SDK subprocess with Opus, ~1-5 min, free on Max plan).

## Quick Reference

```bash
npm install                            # Install dependencies
npm run build                          # TypeScript compile
npm test                               # Run all tests (vitest) — 24 files, 311 tests
npm run lint                           # Type-check without emitting
npx tsx src/cli/index.ts setup         # First-time interactive setup wizard
npx tsx src/cli/index.ts start         # Start agent (Socket Mode)
npx tsx src/cli/index.ts status        # Check system status
```

## Architecture

### Hybrid Agent — Two-Path Design

```
Slack message arrives
  → EventQueue accumulates (4s debounce)
  → createHybridAgent.processBatch()
    → assembleContext() — memory + working ctx + conversation history
    → routeMessage() — Haiku classifier: FAST or HEAVY?
    ├── FAST: executeFastPath() — direct Anthropic API
    │   Model: Sonnet | 10 turns | 60s timeout | ~$0.01/call
    │   Tools: search_memory, update_working_context,
    │          calendar list/get, gmail_search, slack history/search
    └── HEAVY: executeHeavyPath() — claude --print subprocess
        Model: Opus | 200 turns | 20min timeout | $0 on Max plan
        MCP: Memory server (stdio)
        CLI: gws (Google), tools/fireflies.ts (meetings)
        Output: stream-json with real-time progress to Slack
        Interrupt: owner can cancel mid-execution
```

### Directory Structure
```
src/
  agent/           # Hybrid agent orchestration
    hybrid.ts      # Main orchestrator — routes to fast/heavy path
    router.ts      # Haiku complexity classifier (FAST vs HEAVY)
    fast-path.ts   # Direct API loop, limited tools, 60s timeout
    heavy-path.ts  # Claude Code SDK subprocess, stream-json parsing
    context.ts     # Shared context assembly (memory + history + working ctx)
    index.ts       # OLD monolithic agent (preserved as fallback, not used)
  cli/             # Commander.js CLI
    start.ts       # Startup — creates hybrid agent, wires Slack handler
    setup.ts       # Interactive setup wizard
    status.ts      # Status reporting
  db/              # SQLite via node:sqlite (DatabaseSync) + FTS5
    index.ts       # DB init, schema loading, migrations
    schema.sql     # Tables, triggers, FTS5 virtual table
  mcp/             # MCP servers
    memory/        # Memory MCP server for SDK heavy path
      server.ts    # 6 tools: search, retrieve, store, working ctx, people, commitments
      stdio.ts     # stdio entrypoint (LOG_DESTINATION=stderr for clean protocol)
    slack/server.ts  # Slack tools (5 tools)
  memory/          # Memory system (crown jewel)
    store.ts       # CRUD for memories + people tables
    retriever.ts   # Token-budgeted context retrieval (FTS5 + vector hybrid)
    extractor.ts   # Haiku fact extraction from conversations
    embeddings.ts  # all-MiniLM-L6-v2 vector embeddings
    reflection.ts  # Synthesized insights from memory accumulation
    consolidation.ts # Duplicate merge, decay, archival
  security/        # sender-verify, output-sanitizer, path-validator, rate-limiter
  slack/           # Slack event handling
    handler.ts     # Event routing, reaction lifecycle, interrupt buffer
    event-queue.ts # Message accumulation with debounce + typing awareness
    interrupt-classifier.ts  # Four-way interrupt classification (Haiku)
    socket-mode.ts # @slack/bolt Socket Mode adapter
  training-wheels/ # Trust level enforcement + pattern graduation
    policy-engine.ts  # Trust level policy evaluation
    graduation.ts     # Pattern tracking + graduation criteria
  google/          # Google Workspace tools + OAuth
    tools.ts       # 20 tools (calendar, gmail, drive)
    auth.ts        # OAuth2 setup
    drive-sync.ts  # Drive file extraction + sync
    email-scan.ts  # Email extraction pipeline (legacy, SDK replaces)
  fireflies/       # Fireflies.ai meeting transcripts
    api.ts         # GraphQL client
    tools.ts       # 4 tool definitions
    sync.ts        # Meeting sync + extraction
  search/          # Cross-source search (legacy, SDK replaces)
  hooks/           # PreToolUse / PostToolUse hooks
  config.ts        # Zod-validated config
  credentials.ts   # macOS Keychain via keytar, env fallback
  logger.ts        # Pino logging (stderr mode for MCP)
  prompts.ts       # Prompt loader from config/prompts/*.md
tools/
  fireflies.ts     # Fireflies CLI wrapper for SDK bash access
scripts/
  docker-entrypoint.sh  # Railway startup (auth persistence, gws config)
config/
  default.json     # All tunable defaults
  prompts/         # All prompt templates (*.md files)
    system.md      # Main Slack bot system prompt
    heavy-path.md  # SDK heavy path system prompt
    extraction.md  # Haiku fact extraction prompt
    + 8 more
```

### Three-Model Architecture
- **Haiku** (`claude-haiku-4-5-20251001`): Router + classifier + fact extraction (~$0.0002/call)
- **Sonnet** (`claude-sonnet-4-6`): Fast path executor (~$0.01/call)
- **Opus** (`claude-opus-4-6`): Heavy path via SDK ($0 on Max plan)

### Database (node:sqlite)
Uses Node.js built-in `node:sqlite` (DatabaseSync) — **not** better-sqlite3.

Key patterns:
- Return types from `.get()` / `.all()` are `Record<string, SQLOutputValue>` — always cast with `as unknown as YourType`
- Schema loaded from `src/db/schema.sql` via single `db.exec()` call (do NOT split on `;` — breaks trigger bodies)
- Tables: memories, people, actions, action_patterns, documents, agent_state, schema_version
- FTS5 virtual table `memories_fts` with auto-sync triggers
- Optional: `memories_vec` (sqlite-vec, 384-dim vectors)

### Security Model — Single-Principal Authority
Only the owner (identified by `OWNER_SLACK_USER_ID`) can issue instructions. Everything else is **untrusted data**.

- **PreToolUse**: sender verification, rate limiting, path validation
- **PostToolUse**: audit logging, output secret scanning

### Training Wheels (Trust Levels 0-3)
- **Level 0**: All actions require confirmation
- **Level 1** (current): Read-only + internal memory writes auto-approved
- **Level 2**: Graduated patterns auto-approved
- **Level 3**: Most actions auto-approved (destructive still confirmed)

Memory tools (`update_working_context`, `store_fact`, `mcp__memory__*`) are classified as reads (internal agent state, not external writes).

Graduation: 10+ approvals with <5% rejection rate and zero rejections in last 5.

## Coding Conventions

### Prompts
- **All prompts MUST live in `config/prompts/*.md`** — never hardcode prompt text in TypeScript source files.
- Prompts are loaded at startup via `src/prompts.ts` (`loadPrompts()` / `getPrompts()`).
- Use `{{VARIABLE}}` placeholders for dynamic values.
- Dynamic context (memory, working context, conversation history) is appended at runtime.
- To add a new prompt: create the `.md` file, add the key to `LoadedPrompts` interface and `files` map in `src/prompts.ts`.

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
- **24 test files, 311 tests, all passing**

## Important Patterns

### Hybrid Agent Flow
1. Slack message → EventQueue (4s debounce) → `hybrid.processBatch()`
2. `assembleContext()` builds shared context (memory + conversation + working ctx)
3. `routeMessage()` — Haiku classifies FAST or HEAVY using full context
4. Execute chosen path → post response → background extraction

### Heavy Path Stream-JSON
The heavy path spawns `claude --print --verbose --output-format stream-json` and parses events line by line:
- `{"type":"assistant","message":{content:[{type:"tool_use",name:"Bash",...}]}}` → progress update
- `{"type":"result","result":"..."}` → final response
- Tool names mapped to descriptions: "Searching Gmail...", "Reading meeting transcript..."

### MCP Server stdio Protocol
The Memory MCP server MUST NOT write to stdout (JSON-RPC channel). Set `LOG_DESTINATION=stderr` before any imports in `stdio.ts`. The logger checks this env var and redirects pino to fd 2.

### Context Assembly (`context.ts`)
Both paths share the same assembled context:
- Working context from `agent_state` table (1000 token budget)
- Long-term memory via `retrieveContext()` (1500 token budget)
- Conversation history from Slack API (8000 token budget)
- New message

### Lazy Logger Proxy
```typescript
export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop) {
    if (!loggerInstance) { loggerInstance = initLogger(); }
    return (loggerInstance as unknown as Record<string | symbol, unknown>)[prop];
  },
});
```
Supports `LOG_DESTINATION=stderr` for MCP server mode.

### Config Loading Order
1. `config/default.json` (baked defaults)
2. `~/.clawvato/config.json` (user overrides)
3. Environment variables
4. CLI flags

### Context Limits (all in `config/default.json`)

| Setting | Value | Purpose |
|---|---|---|
| `agent.timeoutMs` | 1,200,000 | Heavy path timeout (20 min) |
| `agent.maxTurns` | 30 | Fast path max tool-call turns |
| `context.shortTermTokenBudget` | 8,000 | Slack conversation context |
| `context.longTermTokenBudget` | 1,500 | Memory retrieval budget |
| `context.workingContextTokenBudget` | 1,000 | Scratch pad budget |
| `context.shortTermMessageLimit` | 50 | Max Slack messages fetched |

### Three Memory Tiers
- **Working context** = Scratch pad in `agent_state` (1000 tokens, auto-archives after 14 days)
- **Short-term** = Slack message history (last 50 messages, 8000 tokens)
- **Long-term** = SQLite DB (extracted facts via hybrid FTS5 + vector search, 1500 tokens)

### Memory Extraction
After each interaction:
- Owner's Slack message → Haiku extraction → store facts
- Heavy path response → Haiku extraction → store synthesized facts
- SDK can also call `store_fact` via MCP during execution

## Build Tracks
- **Track A** ✅: Foundation — DB, config, security, CLI, hooks, tests
- **Track B** ✅: Slack MCP + Agent Core — Socket Mode, event-queue, handler
- **Track C** ✅: Google Workspace — 20 tools, OAuth, Drive sync, email extraction
- **Track D** ✅: Memory + Embeddings — extraction, storage, retrieval, vector search
- **Track I** ✅: Fireflies.ai — GraphQL client, sync, CLI wrapper
- **Track J** ✅: SDK Pivot — Hybrid architecture (fast + heavy path, router, MCP server)
- **Track E** ⬜: Workflow Engine + Scheduling
- **Track F** 🔶: Security + Training Wheels (undo system remaining)
- **Track G** ⬜: GitHub + Filesystem + Web Research
- **Track H** ⬜: Proactive Intelligence

## Common Tasks

### Adding a new prompt
1. Create `config/prompts/your-prompt.md`
2. Add key to `LoadedPrompts` interface in `src/prompts.ts`
3. Add filename to `files` map in `loadPrompts()`

### Adding a fast-path tool
1. Add tool definition + handler in `src/agent/fast-path.ts` or existing tool file
2. Register in `createHybridAgent()` in `src/agent/hybrid.ts`
3. Add to `READ_ACTIONS` in policy-engine.ts if it should auto-approve at trust level 1

### Adding heavy-path access to a new service
1. Create CLI wrapper in `tools/` (like `tools/fireflies.ts`)
2. Add usage examples to `config/prompts/heavy-path.md`
3. Add `Bash(your-cli:*)` to `--allowedTools` in `heavy-path.ts`

### Adding a memory MCP tool
1. Add tool definition to `TOOLS` array in `src/mcp/memory/server.ts`
2. Add handler function
3. Add to `--allowedTools` in `heavy-path.ts` as `mcp__memory__tool_name`

## Slack Interaction Principles

### Core Philosophy
> Use the smallest possible signal. Reactions over messages. Silence over acknowledgment.

### Reaction Lifecycle
```
Message arrives              → 👀 (accumulating)
Accumulation window closes   → remove 👀, add 🧠, post progress after 20s delay
Tool-call boundaries         → update progress ("Searching Gmail...")
Task complete                → remove 🧠, delete progress, post response
Cancel                       → remove 🧠, ✅ on cancel message
```

### Heavy Path Progress
Stream-json events parsed in real-time → progress updates posted to Slack:
- `Bash(gws gmail...)` → "Searching Gmail..."
- `Bash(npx tsx tools/fireflies.ts...)` → "Searching meeting transcripts..."
- `mcp__memory__store_fact` → "Saving to memory..."

### Interrupt During Heavy Path
Owner can cancel by sending "stop", "cancel", "abort", "nvm", etc. Polled every 2s. Kills SDK subprocess immediately.

## Deployment (Railway)

### Environment Variables
```
ANTHROPIC_API_KEY          — Fast path API access
CLAUDE_CODE_OAUTH_TOKEN    — Heavy path Max plan auth (from `claude setup-token`)
GWS_CONFIG_B64             — gws CLI auth (from `cd ~/.config/gws && tar czf - --exclude=cache . | base64`)
SLACK_BOT_TOKEN            — Slack bot token
SLACK_APP_TOKEN            — Slack app-level token (Socket Mode)
OWNER_SLACK_USER_ID        — Owner's Slack user ID
FIREFLIES_API_KEY          — Fireflies API key
GOOGLE_AGENT_EMAIL         — Owner's email for Gmail identification
DATA_DIR=/data             — Persistent volume mount
```

### Docker Entrypoint (`scripts/docker-entrypoint.sh`)
1. Symlink `~/.claude` → `/data/claude-config` (persist Claude CLI auth)
2. Create `.claude.json` with `hasCompletedOnboarding: true`
3. Unpack `GWS_CONFIG_B64` to `/root/.config/gws/` (gws auth)
4. Start agent

### Deploying
```bash
railway up --detach
```

### One-Time Auth Setup
```bash
# Claude CLI (Max plan)
claude setup-token  # → get token → railway variables set CLAUDE_CODE_OAUTH_TOKEN=...

# gws CLI (Google)
railway variables set GWS_CONFIG_B64="$(cd ~/.config/gws && tar czf - --exclude=cache . | base64)"
```

## Gotchas
- `node:sqlite` is experimental — `ExperimentalWarning` in test output is expected
- Schema SQL uses triggers with `;` inside bodies — never split schema on semicolons
- **MCP stdio server**: ALL logging must go to stderr, not stdout (corrupts JSON-RPC protocol)
- **Docker `node:22-slim`**: Stripped of CA certificates — must `apt-get install ca-certificates` or gws/external HTTPS calls fail with TLS UnknownIssuer
- **Heavy path strips `ANTHROPIC_API_KEY`** from subprocess env so Claude CLI uses Max plan OAuth instead of API billing
- **One-time migrations are dangerous**: Guard keys in `agent_state` may not persist across schema recreations. The v5 reset migration was wiping all memories on every deploy — it was removed.
- DB interfaces MUST use snake_case to match SQLite column names
- `keytar` CJS→ESM interop: `imported.default ?? imported`
- Socket Mode startup is slow (~11s) — normal
- Startup crawl skips if offline <5 min (prevents re-processing on quick redeploys)
- Startup crawl always uses fast path (never routed to heavy)
- Policy engine regexes must use `(?:^|_)` to match prefixed tool names
