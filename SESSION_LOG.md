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

## Next Session — Track B: Agent Loop

### Priority Tasks

1. **Claude Agent SDK Integration** (`src/agent/index.ts`)
   - Plan-Then-Execute agent loop (structural prompt injection defense)
   - System prompt construction from memory tiers
   - Tool routing via MCP

2. **Slack MCP Server** (`src/mcp/slack.ts`)
   - Socket Mode WebSocket connection
   - Event handling (message, app_mention, reaction)
   - Sender verification integration
   - Thread-aware conversation management

3. **Training Wheels Runtime** (`src/training-wheels/`)
   - Trust level enforcement in agent loop
   - Confirmation flow (Slack reactions: thumbsup/thumbsdown)
   - Pattern hash computation
   - Graduation logic (10+ approvals, <5% rejection, 0 recent rejections)

4. **Gmail MCP Server** (`src/mcp/gmail.ts`)
   - OAuth2 token management
   - Read/send/draft/search capabilities
   - Output sanitizer integration on all outbound content

### Stretch Goals
- Basic memory retrieval (`src/memory/retriever.ts`)
- Tier 0/1 identity prompt construction
- End-to-end Slack message → response flow
