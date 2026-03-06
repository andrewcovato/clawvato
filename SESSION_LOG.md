# Session Log

## Session 1 — Spec & Research (2026-03-05)

### Accomplished
- **Concept design**: Defined Clawvato as an always-on personal AI agent running locally on macOS, interacted with via Slack, with its own email identity via Google Workspace
- **Deep research**: Ran 5 parallel research agents covering Claude Agent SDK, MCP ecosystem, memory architectures (Stanford Generative Agents, MemGPT), security models, and similar projects
- **Specification documents created**:
  - `AGENT_SPEC.md` — Master specification (later rewritten with research-hardened changes)
  - `docs/MEMORY_ARCHITECTURE.md` — Tiered memory system design
  - `docs/RESEARCH_SYNTHESIS.md` — Research findings across all domains
  - `docs/SPEC_INTEGRATIONS.md` — Slack, Gmail, Drive, Calendar, GitHub integration specs
  - `docs/SPEC_MEMORY_V2.md` — Memory v2 with triple-factor retrieval and bi-temporal facts
  - `docs/BUILD_PLAN.md` — 5-track implementation plan with dependency graph
- **Architecture visualization**: Generated interactive HTML architecture diagram

---

## Session 2 — Track A Build (2026-03-06)

### Accomplished — Track A: Core Foundation (Complete)

**Project Scaffolding**
- `package.json` with ESM, Node >=22.12.0, all dependencies
- `tsconfig.json` (strict, ES2022, NodeNext)
- `.gitignore`, `.env.example`
- Full directory structure for all 5 tracks

**Database Layer** (`src/db/`)
- SQLite schema with 8 tables + FTS5 virtual table + 3 sync triggers + indexes
- Tables: memories, people, actions, action_patterns, workflows, consolidation_runs, plugins, schema_version
- Triple-factor scoring (importance, confidence, access tracking) and bi-temporal tracking (valid_from/valid_until) on memories
- Used `node:sqlite` (DatabaseSync) — Node.js built-in, no native dependencies
- WAL mode, foreign keys, busy timeout configured

**Config & Credentials** (`src/config.ts`, `src/credentials.ts`)
- Zod-validated configuration with defaults, file persistence, env var overrides
- macOS Keychain credential storage via keytar with env var fallback
- Trust levels 0-3 enforced via schema validation

**Structured Logging** (`src/logger.ts`)
- Pino with lazy Proxy initialization (avoids circular deps with config)
- TTY detection for pretty-printing vs JSON

**Security Modules** (`src/security/`)
- `sender-verify.ts` — Single-principal authority (owner Slack ID only)
- `output-sanitizer.ts` — 14 regex patterns detecting API keys, tokens, SSNs, credit cards, private keys
- `path-validator.ts` — Filesystem sandboxing with forbidden patterns + sandbox root enforcement
- `rate-limiter.ts` — Sliding window rate limiter with per-tool-type limits

**Hooks** (`src/hooks/`)
- `pre-tool-use.ts` — Sender verification, rate limiting, path validation
- `post-tool-use.ts` — Audit logging, output secret scanning, slow tool warnings
- `audit-logger.ts` — Immutable action audit trail in SQLite

**CLI** (`src/cli/`)
- Commander.js with commands: start, status, config (show/set), credentials (list/set/delete), audit, trust-level
- Status command shows trust level, DB stats, active workflows, recent actions, graduated patterns

**Agent Bootstrap** (`src/agent/index.ts`)
- Skeleton with Anthropic client initialization and processMessage() stub

**Process Management** (`config/launchd.plist`)
- macOS launchd plist for auto-start, crash restart, 10s throttle

**Tests** (50 tests, all passing)
- `tests/security/output-sanitizer.test.ts` — 11 tests
- `tests/security/path-validator.test.ts` — 13 tests
- `tests/security/sender-verify.test.ts` — 8 tests
- `tests/security/rate-limiter.test.ts` — 5 tests
- `tests/db.test.ts` — 7 tests (schema, CRUD, FTS5, constraints, idempotency)
- `tests/config.test.ts` — 6 tests (loading, validation, persistence)

**Documentation**
- `CLAUDE.md` — Project guide with architecture, conventions, gotchas
- `AGENT_SPEC.md` — Rewritten with all research-hardened changes

### Key Technical Decisions
1. **node:sqlite over better-sqlite3**: Node 25's built-in SQLite avoids native compilation issues (no Xcode CLT needed)
2. **Single db.exec() for schema**: Splitting on `;` breaks trigger bodies — load full schema in one call
3. **Double-cast pattern**: `node:sqlite` returns `Record<string, SQLOutputValue>` — use `as unknown as Type`
4. **Lazy logger proxy**: Defers pino initialization to avoid circular dependency with config module

---

## Session 3 — Slack Interaction Model + Track B Start (2026-03-06)

### Accomplished

**Slack Interaction Architecture** (Design + Spec)
- Designed fluid, interruptible Slack interaction model — learned from previous project's failures
- Core principle: "smallest possible signal at each step — reactions over messages, silence over acknowledgment"
- Message accumulation window (2-15s debounce + user_typing awareness)
- Four-way interrupt classification: additive, redirect, cancel, unrelated
- Reaction lifecycle: ⏳ → 🧠 → 👍/✅ → response
- Milestone-based progress (not percentages) — edit ACK at tool-call boundaries
- Updated AGENT_SPEC.md with full interaction model section + anti-patterns
- Updated CLAUDE.md with hard-won interaction principles

**Event Queue** (`src/slack/event-queue.ts`)
- Debounce-based message accumulation with per-conversation buffering
- Three user-tunable modes: Snappy (2s), Patient (4s), Wait for me (15s)
- user_typing event integration with 4s grace period
- 30s hard cap to prevent indefinite waiting
- 10 tests passing

**Slack Event Handler** (`src/slack/handler.ts`)
- Routes Socket Mode events through the accumulation queue
- Single-principal authority filtering (owner messages only)
- Reaction lifecycle management (⏳ → 🧠 → response)
- Active task tracking for milestone updates
- Interface-based design for testability (SlackReactionAPI, SlackMessageAPI)

**Interrupt Classifier** (`src/slack/interrupt-classifier.ts`)
- Fast-path regex detection for obvious cancels (no LLM needed)
- Haiku-based four-way classification for ambiguous interrupts
- Confidence threshold with "ask the user" fallback when uncertain
- 11 tests passing (including edge cases: bad JSON, invalid types, API failures)

**Agent Loop** (`src/agent/loop.ts`)
- Plan-Then-Execute with checkpoint interruption between tool calls
- Dependency-injected design (classify, plan, executeTool, checkForInterrupts)
- Handles all four interrupt types: inject context, abort+restart, cancel, queue
- Milestone updates via SlackHandler integration

**Training Wheels Policy Engine** (`src/training-wheels/policy-engine.ts`)
- Action categorization: read, write, outbound, destructive
- Trust level evaluation (levels 0-3) with graduated pattern support
- Non-graduatable action patterns (delete, revoke, external share)
- Confirmation type selection (reaction vs block_kit)
- 16 tests passing

**Graduation Engine** (`src/training-wheels/graduation.ts`)
- Pattern hash computation (sha256, order-independent key params)
- Occurrence recording with approval/rejection/modification tracking
- Graduation criteria: 10+ approvals, <5% rejection rate
- DB-backed persistence using action_patterns table
- 14 tests passing

### Key Technical Decisions
1. **DB interfaces use snake_case**: `node:sqlite` returns raw column names — interfaces must match the schema exactly
2. **Dependency injection for agent loop**: All external calls injected via `AgentLoopDeps` — enables full test coverage without API calls
3. **Fast-path cancel detection**: Regex for "scratch that"/"never mind" avoids LLM round-trip for obvious signals
4. **Conversation keying**: Messages grouped by `channel:threadTs` — prevents cross-thread contamination during accumulation

### Test Summary
- **101 total tests**, all passing
- Track A: 50 tests (security, DB, config)
- Track B: 51 tests (event queue, interrupt classifier, policy engine, graduation)

---

## Next Session — Track B Completion + Track C Start

### Priority Tasks

1. **Slack Socket Mode Connection** (`src/slack/connection.ts`)
   - `@slack/socket-mode` WebSocket setup
   - Wire Socket Mode events to SlackHandler
   - Reconnection handling
   - Real reaction/message API implementations

2. **Anthropic API Integration** (`src/agent/index.ts`)
   - Wire Haiku classifier, Opus planner, Sonnet executor
   - System prompt construction with memory tiers
   - Implement real `AgentLoopDeps` (currently interfaces)

3. **Gmail MCP Server** (`src/mcp/gmail.ts`)
   - OAuth2 token management
   - Read/send/draft/search capabilities
   - Output sanitizer integration

4. **End-to-end flow test**
   - Slack message → accumulation → classify → plan → execute → response
   - With real Slack tokens in development workspace

### Stretch Goals
- Basic memory retrieval (`src/memory/retriever.ts`)
- Tier 0/1 identity prompt construction
- Calendar MCP server skeleton
