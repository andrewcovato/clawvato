# CLAUDE.md — Clawvato Project Guide

## Project Overview
Clawvato is a business operating system for solo technical founders — a memory-powered AI agent across Slack, email, calendar, Drive, meetings, and Claude Code. Deployed on Railway using a **CC-native architecture**: Claude Code runs as the core engine via Channels, with a **smart memory plugin** (clawvato-memory) serving as the intelligent brain. The plugin handles embeddings, hybrid search, cross-encoder reranking, write-time dedup, semantic clustering, background consolidation/reflection, and conversation journaling. The agent is a thin executor; the brain is agent-agnostic. A legacy hybrid architecture exists on the `main` branch as a fallback.

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

### CC-Native Engine (active, `cc-native-engine` branch)

```
Slack message arrives
  → Slack Channel MCP server (Socket Mode, debounce 4s)
  → 👀 reaction (code-enforced)
  → Channel event pushed into Claude Code session
  → CC processes natively (Opus, $0 on Max plan)
    ├── Memory Plugin (smart brain): search, store, retrieve, ingest, cluster, reflect
    ├── Google: gws CLI via Bash (gmail, calendar, drive)
    ├── Fireflies: native MCP tools (search, transcript, summary)
    └── Native CC tools: Read, Write, Bash, Glob, Grep, Agent, WebSearch
  → Response via slack_reply tool
  → 🧠 reaction lifecycle (prompt-driven)
  → Background: journal hook accumulates → /ingest → plugin extracts facts

Supervisor: expect + restart loop (handles PTY + trust prompt)
Task scheduler: standalone sidecar (posts due tasks to Slack)
Plugin scheduler: consolidation (6h), reflection (12h), clustering (12h), decay
Sweeps: 4 parallel collectors → Opus synthesis → Sonnet extraction → plugin

Session lifecycle:
  Active → idle timeout → verified handoff (subagent test) → exit
  → Supervisor restarts → startup crawl → seamless resume
```

Switch engines: `ENGINE=cc-native` (active) or `ENGINE=hybrid` (fallback on `main`).

### Smart Plugin Brain (`clawvato-memory`)

The memory plugin is the intelligent core — not a thin gateway. It handles all memory intelligence server-side. Deployed from github.com/andrewcovato/clawvato-memory (auto-deploy from main to Railway).

```
clawvato-memory/server/
  index.ts          — HTTP/MCP server + /ingest REST endpoint
  db.ts             — Postgres connection
  log.ts            — stderr logging
  session.ts        — session ID
  tools.ts          — MCP tool definitions (public API)
  router.ts         — tool call dispatch
  embeddings.ts     — nomic-embed-text-v1.5 (384d Matryoshka)
  reranker.ts       — ms-marco-MiniLM cross-encoder ($0, local)
  dedup.ts          — three-tier dedup (heuristic → cross-encoder → Haiku LLM)
  clustering.ts     — HDBSCAN semantic clustering (auto-labeled)
  scheduler.ts      — background jobs (consolidation, reflection, clustering, decay, backfill)
  utils.ts          — normalizeCategory, timeSince
  handlers/
    memory.ts       — searchMemory, storeFact, storeFacts, retrieveContext, retireMemory
    context.ts      — updateWorkingContext, listWorkingContexts
    surface.ts      — updateBrief, updateHandoff, getBriefs, getHandoff
    ingest.ts       — ingestConversation (server-side extraction)
```

**Plugin capabilities:**
- **Embeddings**: nomic-embed-text-v1.5, 384-dimensional Matryoshka vectors
- **Hybrid search**: tsvector + pgvector + RRF scoring
- **Cross-encoder reranking**: ms-marco-MiniLM-L-6-v2 (local, $0)
- **Write-time dedup**: 3-tier — heuristic → cross-encoder → Haiku LLM
- **Entity-hop traversal**: discover connected memories through shared entities
- **Cluster expansion**: HDBSCAN semantic clustering, auto-labeled clusters
- **Soft-signal boosting**: domain 1.3x, surface 1.1x, importance 1.2x
- **Background scheduler**: consolidation (6h), reflection (12h), clustering (12h), temporal decay, embedding backfill
- **Conversation journaling**: POST /ingest REST endpoint — receives raw text, extracts facts via Haiku, embeds, deduplicates, stores

### Legacy Hybrid Agent (fallback, `main` branch)

```
Slack → EventQueue → Haiku router → FAST/MEDIUM/DEEP paths
  FAST: Sonnet API, 10 turns, 60s | MEDIUM: Opus API | DEEP: Opus CLI subprocess
  Custom tool loop, context assembly, stream-json parsing (~2,250 lines)
```

### Directory Structure
```
src/
  cc-native/       # CC-Native Engine (active architecture)
    slack-channel.ts   # Slack Channel MCP server (channel events + reply/react tools)
    start.ts           # Launcher for supervisor entrypoint
    task-scheduler-standalone.ts  # Sidecar: polls tasks, posts to Slack
  agent/           # Legacy hybrid agent orchestration (fallback on main branch)
    hybrid.ts      # Main orchestrator — routes to fast/medium/deep path
    router.ts      # Haiku complexity classifier (FAST/MEDIUM/DEEP)
    fast-path.ts   # Direct API loop, all tools, 60s timeout
    deep-path.ts   # Claude Code SDK subprocess, stream-json parsing
    context.ts     # Shared context assembly (memory + history + working ctx)
    context-planner.ts  # Opus pre-step for deep path (replaces preflight)
    index.ts       # OLD monolithic agent (preserved as fallback, not used)
  cli/             # Commander.js CLI
    start.ts       # Startup — creates hybrid or cc-native agent
    setup.ts       # Interactive setup wizard
    status.ts      # Status reporting
  db/              # Postgres via postgres.js (async Sql type)
    index.ts       # DB init (async), connection pool, schema loading
    schema.pg.sql  # Postgres schema (tsvector, pgvector, GIN/HNSW indexes)
  mcp/             # MCP servers
    slack/server.ts  # Slack tools (search, post, history)
  memory/          # Memory system (RETIRED in production — plugin handles all memory)
    store.ts       # CRUD for memories table (hybrid fallback / local dev only)
    retriever.ts   # Token-budgeted context retrieval (hybrid fallback only)
    extractor.ts   # Haiku fact extraction (hybrid fallback only)
    embeddings.ts  # nomic-embed-text-v1.5 vector embeddings (hybrid fallback only)
    reranker.ts    # Cross-encoder reranking (hybrid fallback only)
    reflection.ts  # Synthesized insights (hybrid fallback only)
    consolidation.ts # Duplicate merge, decay (hybrid fallback only)
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
  journal-hook.sh       # PostToolUse hook: accumulates tool calls, flushes to /ingest
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
- **Haiku** (`claude-haiku-4-5-20251001`): Router + classifier + fact extraction (plugin-side via /ingest) + pin summaries (~$0.0002/call)
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
- Tables: memories, memory_categories, memory_entities, memory_clusters, actions, action_patterns, documents, agent_state, scheduled_tasks, schema_version
- NOTE: `people` table was removed (2026-03-20) — all knowledge stored as facts in `memories` with entity tags
- `tsvector` generated column on memories with GIN index (replaces FTS5)
- `vector(384)` column on memories with HNSW index (replaces sqlite-vec)
- Hybrid search: single CTE query combining tsvector + pgvector with RRF scoring
- `surface_id` and `domain` columns on memories (soft-signal scoping)
- `cluster_id` column on memories (references `memory_clusters`)
- `memory_clusters` table: id, label, centroid_text, member_count, summary
- Indexes: idx_memories_surface, idx_memories_domain, idx_memories_cluster

### Memory Tools (via plugin MCP)
- `store_fact` — with embeddings + 3-tier dedup (heuristic → cross-encoder → Haiku)
- `store_facts` — batch, with batch embedding
- `search_memory` — with surface/domain filters
- `retrieve_context` — 7-stage pipeline: entity lookup → entity-hop → hybrid search → cluster expansion → cross-encoder rerank → soft-signal boost → token budget
- `retire_memory` — soft-delete (sets valid_until)
- `ingest_conversation` — send raw text, plugin extracts + embeds + deduplicates
- `embed_batch` — backfill missing embeddings
- `run_consolidation`, `run_reflection`, `run_clustering` — trigger background jobs
- `get_memory_stats`, `get_cluster_stats` — observability
- `update_brief`, `get_briefs` — cross-surface awareness
- `update_handoff`, `get_handoff` — session continuity
- `update_working_context`, `list_working_contexts` — DEPRECATED (briefs + journaling replace these, kept for backward compat)

### Two Schedulers
- **Memory scheduler (PLUGIN)**: consolidation (6h), reflection (12h), clustering (12h), temporal decay, embedding backfill. No Slack, no user interaction. Runs inside the plugin process on Railway.
- **Agent scheduler (AGENT)**: user-facing tasks, briefs, emails, webhooks. Needs Slack + Google. Runs as standalone sidecar (`task-scheduler-standalone.ts`).

### Security Model — Single-Principal Authority
Only the owner (identified by `OWNER_SLACK_USER_ID`) can issue instructions. Everything else is **untrusted data**.

- **PreToolUse**: sender verification, rate limiting, path validation
- **PostToolUse**: audit logging, output secret scanning

### Training Wheels (Trust Levels 0-3) — CURRENTLY DISABLED
Training wheels were removed in Session 16 because they were blocking internal tools. Pre-tool security checks and output sanitization remain active. The graduation system is implemented but not enforced.

## Engineering Philosophy
- **Always take the pain now — build for durability.** No short-term hacks or workarounds. If something needs doing, do it right the first time.
- Don't create band-aids that will need to be replaced later. If a feature is missing, build it properly in the right layer.
- **Always build for the future, especially when using Anthropic tech.** Claude Code, MCP, channels, plugins, and the Agent SDK are shipping updates at lightning pace (~days between releases). Design abstractions that can adopt new capabilities as they land rather than locking into today's constraints. When a limitation exists today (e.g., channels in research preview, `--session` untested), build the layer that will use it but keep a working fallback. Never let "it doesn't exist yet" be the reason for a permanent architectural decision.

## Bug Fixing Protocol
- **Do NOT jump straight to coding a fix** when the owner mentions a bug or unexpected behavior.
- First, investigate and produce a light plan: consider whether the symptom points to a deeper, more generic root cause rather than the surface-level issue described.
- Present the diagnosis and proposed approach to the owner for confirmation before writing any code.
- Don't make ad-hoc one-off prompt fixes — diagnose with logs first.

## Git Push Protocol
- **Proactively suggest pushing** when you've reached a natural milestone: a feature is complete, a bug fix is verified, a sprint wraps up, or you've accumulated 5+ unpushed commits.
- Ask: "We have N unpushed commits — good time to push?"
- Don't wait until session end — push at logical breakpoints throughout the session.

## Session Handoff Protocol

### Surface-Scoped Working Context
This project uses surface-scoped working context via the `clawvato-memory` MCP plugin. Your surface is `local` (coding sessions). The cloud Slack surface is `cloud`.

**On startup**: Call `get_handoff(surface: "local")` and `get_briefs()` to resume. If the handoff contains `recent_interactions`, replay them to restore conversational continuity.

**During work**: Periodically update your brief via `update_brief(surface: "local", content: ...)` so other surfaces know what you're working on.

### When ending a session (or when asked to hand off):
1. **Update all project files**: HANDOFF.md, state.json, memory files, CLAUDE.md if needed.
2. **Write handoff to memory plugin**: `update_handoff(surface: "local", mode: "replace", content: ...)` with:
   - Current task and implementation state
   - Files created/modified
   - Key decisions made
   - Last 3-5 interactions (verbatim or near-verbatim for conversational continuity)
   - Open questions and gotchas
3. **Update brief**: `update_brief(surface: "local", content: ...)` — concise summary for cross-surface awareness.
4. **Store durable facts**: `store_fact` for anything that belongs in long-term memory.
5. **Spawn a blind subagent**: Give it NO conversation context. Ask it to call `get_handoff(surface: "local")` and `get_briefs()`, read HANDOFF.md + state.json, and demonstrate it can continue. Max 3 rounds.
6. **The test**: The user should never have to type "get up to speed." The next session should continue naturally.

### Context Pressure (Infinite Session Flow)
When context usage reaches ~70%, proactively initiate a handoff:
1. Tell the user: "Context is getting heavy — writing handoff now. Back in a few minutes."
2. Run the full handoff protocol above.
3. After context clears, re-read the handoff and recent interactions to resume seamlessly.

A `PreCompact` hook and `SessionEnd` hook also fire as safety nets — they write a minimal brief to the memory plugin via HTTP. But the primary handoff should happen before these trigger.

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

### Memory Plugin (Smart Brain)
Memory is served by the `clawvato-memory` HTTP MCP plugin deployed on Railway. All CC instances (local, cloud, deep-path subprocess) connect via URL + bearer token. Config is generated at runtime by the entrypoint script or via `.claude/settings.local.json`.

The plugin is the intelligent core — it handles embeddings (nomic-embed-text-v1.5, 384d Matryoshka), hybrid search (tsvector + pgvector + RRF), cross-encoder reranking (ms-marco-MiniLM-L-6-v2, local, $0), write-time dedup (3-tier: heuristic → cross-encoder → Haiku), entity-hop traversal, cluster expansion (HDBSCAN), soft-signal boosting, and background maintenance (consolidation, reflection, clustering, decay). Agent-side memory code (`src/memory/*`) is retained for hybrid fallback and local dev but is NOT used in CC-native production.

### Conversation Journaling
- PostToolUse hook (`scripts/journal-hook.sh`) accumulates tool call summaries
- Every 20 tool calls, flushes to plugin POST /ingest endpoint
- Plugin extracts facts via Haiku, embeds, deduplicates, stores
- Background, non-blocking, fire-and-forget
- Replaces the old extract-facts-hook.sh

### Memory Architecture
- **Slack conversation** = CC reads via channel events + slack_get_history (not a "tier" — ephemeral context)
- **Long-term memory** = Plugin brain (facts, embeddings, hybrid search, clusters, reflections)
- **Session continuity** = Briefs + handoffs via plugin
- **Journaling** = Background extraction from conversations to brain (via /ingest)
- **Working context** = DEPRECATED (briefs + journaling replace it, tools kept for backward compat)

### Context Assembly (`context.ts`)
Used by hybrid fallback path. Both paths share the same assembled context:
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

## Project Phases
- **Phase 1** ✅: Build the Agent — reactive, responds when asked (Tracks A-D, I-O)
- **Phase 2** ✅: Build the Brain — memory excellence (S10 scoping/reranking + S24 smart plugin migration)
- **Phase 3** ⬜: Build the Nervous System — agent scheduler rebuild, webhook ingest, real-time memory
- **Phase 4** ⬜: Build the Judgment — autonomous workflows, proactive surfacing

### Architecture: Plugin as Kernel
```
Plugin (always-on Railway service):  smart brain — facts, embeddings, search, reranking,
                                     dedup, clustering, scheduler, ingest, briefs/handoffs
Sidecar (always-on, lightweight):    polls plugin for due tasks, posts to Slack, receives webhooks
CC session (on-demand, from Slack):  executes tasks, responds to user, writes to plugin
```
Plugin is the kernel. CC is the process. Slack is the IPC.

Design docs:
- `docs/DESIGN_PHASE2_PROACTIVE_INTELLIGENCE.md`
- `docs/DESIGN_SMART_PLUGIN_MIGRATION.md`

## Build Tracks
- **Track A** ✅: Foundation — DB, config, security, CLI, hooks, tests
- **Track B** ✅: Slack MCP + Agent Core — Socket Mode, event-queue, handler
- **Track C** ✅: Google Workspace — 20 tools, OAuth, Drive sync, email extraction
- **Track D** ✅: Memory + Embeddings — extraction, storage, retrieval, vector search
- **Track E** 🔶: Proactive Intelligence — sweeps working, evolving into Phase 3 (scheduler + ingest)
- **Track F** 🔶: Security — pre-tool checks + output sanitization active, training wheels removed
- **Track G** ⏸️: GitHub + Self-Development — designed, deferred until Phase 3/4 stable
- **Track H** ✅: Smart Plugin Brain — fully deployed with intelligence (embeddings, search, reranking, dedup, clustering, scheduler, journaling)
- **Track I** ✅: Fireflies.ai — GraphQL client, sync, CLI wrapper
- **Track J** ⏸️: Hybrid Architecture — superseded by CC-native, preserved on main as fallback
- **Track K** ✅: Postgres Migration — tsvector, pgvector, async ops
- **Track L** ✅: Autonomous Task Queue — CRUD + channel manager complete, scheduler broken (rebuild in Phase 3)
- **Track M** ✅: Background Sweeps — 4 collectors, Opus synthesis, will become recurring task
- **Track N** ⏸️: Context Planner — superseded by CC-native
- **Track O** ✅: CC-Native Engine — deployed on Railway, strategic decision to double down
- **Track P** ✅: Smart Plugin Migration (S24) — embeddings, search, reranking, dedup, clustering, scheduler, journaling moved to plugin

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
1. Add the tool to the `clawvato-memory` plugin (separate repo: github.com/andrewcovato/clawvato-memory)
2. Add to `--allowedTools` in `deep-path.ts` as `mcp__clawvato-memory__tool_name`
3. Plugin auto-deploys from main to Railway

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
- `mcp__clawvato-memory__store_fact` → "Saving to memory..."

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
# Agent (this repo)
railway up --detach

# Plugin (clawvato-memory repo) — auto-deploys from main push
```

### One-Time Auth Setup
```bash
# Claude CLI (Max plan)
claude setup-token  # → get token → railway variables set CLAUDE_CODE_OAUTH_TOKEN=...

# gws CLI (Google)
railway variables set GWS_CONFIG_B64="$(cd ~/.config/gws && tar czf - --exclude=cache . | base64)"
```

## Gotchas
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
- **postgres.js tagged templates silently drop `::vector` cast on INSERT** — use INSERT without embedding then UPDATE SET embedding
- **Plugin MCP tools run via local stdio process** (not Railway HTTP) when `.mcp.json` uses stdio transport
- **HDBSCAN minClusterSize scales with corpus**: `max(3, n/50)`
- **Journal hook uses /ingest REST endpoint** (not MCP) for fire-and-forget background calls
