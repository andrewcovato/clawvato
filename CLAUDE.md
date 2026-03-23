# CLAUDE.md — Clawvato Project Guide

## Project Overview
Clawvato is an always-on personal AI agent deployed on Railway. It acts as a "chief of staff" — managing Slack, email, calendar, Drive, and meetings on behalf of its owner. Uses a **hybrid architecture**: Haiku routes each message to either a fast path (direct API, ~2s) or a deep path (Claude Code SDK subprocess with Opus, ~1-5 min, free on Max plan).

## Quick Reference

```bash
npm install                            # Install dependencies
npm run build                          # TypeScript compile
npm test                               # Run all tests (vitest) — requires DATABASE_URL
npm run lint                           # Type-check without emitting
npx tsx src/cli/index.ts setup         # First-time interactive setup wizard
npx tsx src/cli/index.ts start         # Start agent (Socket Mode)
npx tsx src/cli/index.ts status        # Check system status
```

## Architecture

### Three-Tier Hybrid Agent

```
Slack message arrives
  → EventQueue accumulates (4s debounce)
  → createHybridAgent.processBatch()
    → assembleContext() — memory + working ctx + conversation history
    → routeMessage() — Haiku classifier: FAST, MEDIUM, or DEEP
    ├── FAST: executeFastPath(Sonnet) — direct Anthropic API
    │   Model: Sonnet | 10 turns | 60s timeout | ~$0.01/call
    │   All tools available (memory, calendar, gmail, slack, drive, fireflies, read_file, tasks)
    │
    ├── MEDIUM: executeFastPath(Opus) — direct Anthropic API
    │   Model: Opus | 10 turns | 60s timeout | ~$0.05-0.10/call
    │   Same tools as FAST — better reasoning for multi-step + memory interpretation
    │
    └── DEEP: contextPlanner → executeDeepPath() — claude --print subprocess
        Pre-step: Context planner (Opus API) gathers context + converses with user
        Model: Opus CLI | 200 turns | 20min timeout | $0 on Max plan
        Workspace: context/ (pre-seeded .md files) + findings/ (model writes here)
        MCP: Memory server (stdio)
        Output: stream-json with real-time progress to Slack
        Interrupt: owner can cancel mid-execution

Background: Sweep system (every 6h)
  → 4 parallel collectors (Slack, Gmail, Drive, Fireflies)
  → Opus CLI synthesis → findings.md
  → Haiku extraction → atomic facts → Postgres memory
```

### Directory Structure
```
src/
  agent/           # Hybrid agent orchestration
    hybrid.ts      # Main orchestrator — routes to fast/medium/deep path
    router.ts      # Haiku complexity classifier (FAST/MEDIUM/DEEP)
    fast-path.ts   # Direct API loop, all tools, 60s timeout
    deep-path.ts   # Claude Code SDK subprocess, stream-json parsing
    context.ts     # Shared context assembly (memory + history + working ctx)
    context-planner.ts  # Opus pre-step for deep path (replaces preflight)
    index.ts       # OLD monolithic agent (preserved as fallback, not used)
  cli/             # Commander.js CLI
    start.ts       # Startup — creates hybrid agent, wires Slack handler
    setup.ts       # Interactive setup wizard
    status.ts      # Status reporting
  db/              # Postgres via postgres.js (async Sql type)
    index.ts       # DB init (async), connection pool, schema loading
    schema.pg.sql  # Postgres schema (tsvector, pgvector, GIN/HNSW indexes)
  mcp/             # MCP servers
    memory/        # Memory MCP server for SDK deep path
      server.ts    # Tools: search, retrieve, store, working ctx, tasks
      stdio.ts     # stdio entrypoint (LOG_DESTINATION=stderr for clean protocol)
    slack/server.ts  # Slack tools (search, post, history)
  memory/          # Memory system (crown jewel)
    store.ts       # CRUD for memories table (unified — no people table)
    retriever.ts   # Token-budgeted context retrieval (tsvector + pgvector hybrid)
    extractor.ts   # Haiku fact extraction from conversations
    embeddings.ts  # all-MiniLM-L6-v2 vector embeddings
    reflection.ts  # Synthesized insights from memory accumulation
    consolidation.ts # Duplicate merge, decay, archival
  tasks/           # Autonomous task queue
    store.ts       # CRUD + scheduler operations (async, Postgres)
    tools.ts       # Fast-path tools: list/create/update/delete/sync_tasks
    scheduler.ts   # Polling loop (60s), executes due tasks
    executor.ts    # Task → agent pipeline bridge
    channel-manager.ts  # Dedicated Slack channel: pins, notifications, threads
    approval.ts    # Thumbs-up reaction approval for agent-created tasks
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
  fireflies/       # Fireflies.ai meeting transcripts
    api.ts         # GraphQL client
    tools.ts       # 4 tool definitions
    sync.ts        # Meeting sync + extraction
  sweeps/          # Background data sweep system
    types.ts       # Collector interface, CollectorResult, high-water mark helpers
    slack-collector.ts   # Slack channels (cadence-filtered, user token)
    gmail-collector.ts   # Gmail threads (noise-filtered)
    drive-collector.ts   # Drive files (full paths, content snippets)
    fireflies-collector.ts  # Fireflies meetings (paginated)
    executor.ts    # Orchestrates: parallel collect → synthesis → extraction
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
    deep-path.md  # SDK deep path system prompt
    extraction.md  # Haiku fact extraction prompt
    router.md      # Haiku complexity classifier prompt
    fact-synthesis.md  # Fact dedup/enrichment (shared template with {{SOURCE_TYPE}})
    + 7 more
```

### Four-Model Architecture
- **Haiku** (`claude-haiku-4-5-20251001`): Router + classifier + fact extraction + pin summaries (~$0.0002/call)
- **Sonnet** (`claude-sonnet-4-6`): Fast path — simple lookups, commands, file reads (~$0.01/call)
- **Opus** (`claude-opus-4-6`): Medium path via API — memory reasoning, task management, context planning (~$0.05-0.10/call)
- **Opus** (`claude-opus-4-6`): Deep path via CLI — pure reasoning with pre-loaded context + sweep synthesis ($0 on Max plan)

### Database (Postgres via postgres.js)
Uses `postgres` (porsager/postgres) — tagged template SQL client. Connection via `DATABASE_URL` env var.

Key patterns:
- Tagged template queries: `sql\`SELECT * FROM memories WHERE id = ${id}\`` — automatic parameterization, SQL injection impossible by construction
- All DB operations are **async** — every function that touches the DB returns a Promise
- `Sql` type (from postgres.js) replaces `DatabaseSync` as the DB handle passed through the codebase
- `initDb()` is async — must be awaited before any DB operations
- Schema loaded from `src/db/schema.pg.sql` via `sql.unsafe(schema)`
- Tables: memories, memory_categories, memory_entities, actions, action_patterns, documents, agent_state, scheduled_tasks, schema_version
- NOTE: `people` table was removed (2026-03-20) — all knowledge stored as facts in `memories` with entity tags
- `tsvector` generated column on memories with GIN index (replaces FTS5)
- `vector(384)` column on memories with HNSW index (replaces sqlite-vec)
- Hybrid search: single CTE query combining tsvector + pgvector with RRF scoring

### Security Model — Single-Principal Authority
Only the owner (identified by `OWNER_SLACK_USER_ID`) can issue instructions. Everything else is **untrusted data**.

- **PreToolUse**: sender verification, rate limiting, path validation
- **PostToolUse**: audit logging, output secret scanning

### Training Wheels (Trust Levels 0-3) — CURRENTLY DISABLED
Training wheels were removed in Session 16 because they were blocking internal tools. Pre-tool security checks and output sanitization remain active. The graduation system is implemented but not enforced.

## Engineering Philosophy
- **Always take the pain now — build for durability.** No short-term hacks or workarounds. If something needs doing, do it right the first time.
- Don't create band-aids that will need to be replaced later. If a feature is missing, build it properly in the right layer.

## Bug Fixing Protocol
- **Do NOT jump straight to coding a fix** when the owner mentions a bug or unexpected behavior.
- First, investigate and produce a light plan: consider whether the symptom points to a deeper, more generic root cause rather than the surface-level issue described.
- Present the diagnosis and proposed approach to the owner for confirmation before writing any code.
- Don't make ad-hoc one-off prompt fixes — diagnose with logs first.

## Git Push Protocol
- **Proactively suggest pushing** when you've reached a natural milestone: a feature is complete, a bug fix is verified, a sprint wraps up, or you've accumulated 5+ unpushed commits.
- Ask: "We have N unpushed commits — good time to push?"
- Don't wait until session end — push at logical breakpoints throughout the session.

## Coding Conventions

### Prompts — NEVER hardcode in TypeScript
- **All prompts MUST live in `config/prompts/*.md`** — never hardcode prompt text in TypeScript source files.
- This includes system prompts, classifier prompts, extraction prompts, synthesis prompts — any text sent to an LLM as instructions.
- Tool `description` fields and Slack UI strings are NOT prompts and may stay inline.
- Prompts are loaded at startup via `src/prompts.ts` (`loadPrompts()` / `getPrompts()`).
- Use `{{VARIABLE}}` placeholders for dynamic values. Runtime-only variables (e.g., `{{SOURCE_TYPE}}`) are listed in `RUNTIME_VARIABLES` and resolved at the call site.
- Dynamic context (memory, working context, conversation history) is appended at runtime.
- To add a new prompt: create the `.md` file, add the key to `LoadedPrompts` interface and `files` map in `src/prompts.ts`.

### Configuration — NEVER hardcode tunables
- **All operational tunables MUST be in `config/default.json`** with a matching Zod schema in `src/config.ts`.
- This includes: timeouts, turn limits, max_tokens values, model names, thresholds, intervals, batch sizes, confidence cutoffs, and graduation criteria.
- True constants (embedding dimensions, API URLs, security regex patterns, MIME type maps) may stay in code.
- When adding a new tunable: add it to both the Zod schema AND `getDefaultConfig()` in `src/config.ts`, then to `config/default.json`. Keep schema defaults in sync with the JSON file.
- Access via `getConfig()` — never read `process.env` directly for tunables (env vars are mapped in `loadConfig()`).

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
- DB tests use isolated Postgres schemas via `tests/helpers/pg-test.ts` (requires `DATABASE_URL`)
- Security tests are pure functions — no I/O needed
- Config tests use temp directories (`mkdtempSync` + cleanup in `afterEach`)

## Important Patterns

### Hybrid Agent Flow
1. Slack message → EventQueue (4s debounce) → `hybrid.processBatch()`
2. `assembleContext()` builds shared context (memory + conversation + working ctx)
3. `routeMessage()` — Haiku classifies FAST, MEDIUM, or DEEP using full context
4. FAST/MEDIUM: `executeFastPath()` with appropriate model
5. DEEP: `planContext()` (Opus, replaces old preflight — gathers context + converses with user) → `executeDeepPath()` with pre-loaded workspace
6. Post response → background extraction (Haiku extracts facts from conversation)

### Deep Path Stream-JSON
The deep path spawns `claude --print --verbose --output-format stream-json` and parses events line by line:
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

### Config Reference (all in `config/default.json`)

| Setting | Value | Purpose |
|---|---|---|
| `agent.timeoutMs` | 1,200,000 | Deep path timeout (20 min) |
| `agent.maxTurns` | 30 | Generic max turns |
| `agent.fastPathMaxTurns` | 10 | Fast path tool-call turn limit |
| `agent.fastPathTimeoutMs` | 60,000 | Fast path timeout (60s) |
| `agent.fastPathMaxTokens` | 4,096 | Fast path response token limit |
| `agent.deepPathMaxTurns` | 200 | Deep path turn limit |
| `agent.classifierMaxTokens` | 100 | Router/classifier response limit |
| `agent.interruptPollMs` | 2,000 | Interrupt polling interval |
| `context.shortTermTokenBudget` | 8,000 | Slack conversation context |
| `context.longTermTokenBudget` | 1,500 | Memory retrieval budget |
| `context.workingContextTokenBudget` | 1,000 | Scratch pad budget |
| `context.shortTermMessageLimit` | 50 | Max Slack messages fetched |
| `memory.extractionMaxTokens` | 8,000 | Haiku extraction response limit |
| `memory.reflectionMaxTokens` | 1,000 | Haiku reflection response limit |
| `slack.interruptConfidenceThreshold` | 0.7 | Below this, ask user to clarify |
| `trainingWheels.graduationThreshold` | 10 | Approvals needed for graduation (DISABLED) |
| `sweeps.cron` | every 6 hours | Background sweep schedule |
| `sweeps.slack.maxMessagesPerChannel` | 500 | Max msgs per channel per sweep |
| `sweeps.gmail.maxThreads` | 2,000 | Max email threads per sweep |
| `sweeps.drive.maxFiles` | 500 | Max Drive files per sweep |
| `sweeps.fireflies.maxMeetings` | 100 | Max meetings per sweep |

### Three Memory Tiers
- **Working context** = Scratch pad in `agent_state` (1000 tokens, auto-archives after 14 days)
- **Short-term** = Slack message history (last 50 messages, 8000 tokens)
- **Long-term** = Postgres (extracted facts via hybrid tsvector + pgvector search, 1500 tokens)

### Memory Extraction
After each interaction:
- Owner's Slack message → Haiku extraction → store facts
- Deep path response → Haiku extraction → store synthesized facts
- SDK can also call `store_fact` via MCP during execution

## Build Tracks
- **Track A** ✅: Foundation — DB, config, security, CLI, hooks, tests
- **Track B** ✅: Slack MCP + Agent Core — Socket Mode, event-queue, handler
- **Track C** ✅: Google Workspace — 20 tools, OAuth, Drive sync, email extraction
- **Track D** ✅: Memory + Embeddings — extraction, storage, retrieval, vector search
- **Track I** ✅: Fireflies.ai — GraphQL client, sync, CLI wrapper
- **Track J** ✅: SDK Pivot — Hybrid architecture (fast + deep path, router, MCP server)
- **Track K** ✅: Postgres Migration — SQLite → Postgres, tsvector, pgvector, async ops
- **Track L** ✅: Autonomous Task Queue — scheduler, executor, dedicated task channel, three-tier routing
- **Track M** 🔶: Background Sweeps — 4 collectors, Opus synthesis working, Haiku extraction blocker
- **Track N** 🔶: Context Planner — built, needs populated memory to test
- **Track E** ⬜: Workflow Engine + Scheduling
- **Track F** 🔶: Security + Training Wheels (undo system remaining)
- **Track G** ⬜: GitHub + Filesystem + Web Research
- **Track H** 🔶: Plugin Adapter + CC Bridge (designed, not built)

## Common Tasks

### Adding a new prompt
1. Create `config/prompts/your-prompt.md`
2. Add key to `LoadedPrompts` interface in `src/prompts.ts`
3. Add filename to `files` map in `loadPrompts()`

### Adding a fast-path tool
1. Add tool definition + handler in `src/agent/fast-path.ts` or existing tool file
2. Register in `createHybridAgent()` in `src/agent/hybrid.ts`
3. Add to `READ_ACTIONS` in policy-engine.ts if it should auto-approve at trust level 1

### Adding deep-path access to a new service
1. Create CLI wrapper in `tools/` (like `tools/fireflies.ts`)
2. Add usage examples to `config/prompts/deep-path.md`
3. Add `Bash(your-cli:*)` to `--allowedTools` in `deep-path.ts`

### Adding a memory MCP tool
1. Add tool definition to `TOOLS` array in `src/mcp/memory/server.ts`
2. Add handler function
3. Add to `--allowedTools` in `deep-path.ts` as `mcp__memory__tool_name`

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

### Deep Path Progress
Stream-json events parsed in real-time → progress updates posted to Slack:
- `Bash(gws gmail...)` → "Searching Gmail..."
- `Bash(npx tsx tools/fireflies.ts...)` → "Searching meeting transcripts..."
- `mcp__memory__store_fact` → "Saving to memory..."

### Interrupt During Deep Path
Owner can cancel by sending "stop", "cancel", "abort", "nvm", etc. Polled every 2s. Kills SDK subprocess immediately.

## Deployment (Railway)

### Environment Variables
```
DATABASE_URL               — Postgres connection string (Railway injects via ${{Postgres.DATABASE_URL}})
ANTHROPIC_API_KEY          — Fast path API access
CLAUDE_CODE_OAUTH_TOKEN    — Deep path Max plan auth (from `claude setup-token`)
GWS_CONFIG_B64             — gws CLI auth (from `cd ~/.config/gws && tar czf - --exclude=cache . | base64`)
SLACK_BOT_TOKEN            — Slack bot token
SLACK_APP_TOKEN            — Slack app-level token (Socket Mode)
OWNER_SLACK_USER_ID        — Owner's Slack user ID
FIREFLIES_API_KEY          — Fireflies API key
GOOGLE_AGENT_EMAIL         — Owner's email for Gmail identification
TASK_CHANNEL_ID            — Slack channel ID for task management (pinned messages, notifications)
TZ=America/New_York        — Timezone for scheduling
DATA_DIR=/data             — Persistent volume (Claude CLI auth + gws config only, NOT for DB)
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
- **MCP stdio server**: ALL logging must go to stderr, not stdout (corrupts JSON-RPC protocol)
- **Docker `node:22-slim`**: Stripped of CA certificates — must `apt-get install ca-certificates` or gws/external HTTPS calls fail with TLS UnknownIssuer
- **Deep path strips `ANTHROPIC_API_KEY`** from subprocess env so Claude CLI uses Max plan OAuth instead of API billing
- **All DB ops are async** — every function touching Postgres returns a Promise. Missing `await` will silently succeed but not persist.
- DB interfaces MUST use snake_case to match Postgres column names
- `keytar` CJS→ESM interop: `imported.default ?? imported`
- Socket Mode startup is slow (~11s) — normal
- Startup crawl skips if offline <5 min (prevents re-processing on quick redeploys)
- Startup crawl always uses fast path (never routed to heavy)
- Policy engine regexes must use `(?:^|_)` to match prefixed tool names
- **Pre-flight must never imply starting without `[PROCEED]`** — saying "kicking it off" without the sentinel makes the user think it's broken
- **Brain reaction goes on user's message**, not the bot's confirmation message
