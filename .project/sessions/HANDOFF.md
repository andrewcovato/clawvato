# Session Handoff

> Last updated: 2026-03-22 | Session 17 (extended) | Sprint S8

## Quick Resume

```
Sprint: S8 — Proactive Memory & Intelligent Context Assembly (~90% complete)
Status: Background sweep pipeline working. Haiku extraction from findings is the last blocker.
Database: Railway managed Postgres (memory wiped 2026-03-22, people table dropped)
Task Channel: #clawvato-tasks (C0AN5J0LCP3)
Build: Clean (tsc --noEmit passes)
Deploy: Live on Railway with all sweep infrastructure
BLOCKER: Haiku extraction fails on chunked findings — error serialization shows {} instead of actual error
DESIGN DOC: docs/DESIGN_PROACTIVE_MEMORY.md
```

## Current State of the Sweep Pipeline

The end-to-end pipeline is:

```
Scheduler (60s poll) → Collector (parallel, ~2 min) → Workspace .md → Opus CLI synthesis (~6 min)
→ findings.md (27KB) → Haiku chunked extraction → Postgres memory ← THIS STEP FAILS
```

### What Works
- **4 collectors** running in parallel: Slack (cadence-filtered, 18 active channels, 3K msgs), Gmail (noise-filtered, 1.8K threads), Drive (500 files with content snippets), Fireflies (58 meetings)
- **Opus synthesis** via `--append-system-prompt-file` produces a 27KB findings.md with real business data (clients, people, decisions, etc.)
- **Write tool** for synthesis output (Bash heredoc breaks on apostrophes/quotes)
- **Fail-fast**: sweep aborts if any collector errors or returns 0 items
- **Debug workspace** persisted to `/data/debug-workspaces/` AFTER synthesis (includes findings)

### What's Broken
- **Haiku extraction** from the findings file fails with empty error `{}`. Likely cause: input too large for Haiku even after chunking at 15K chars, OR `extractionMaxTokens` (now 8000) is still insufficient, OR the Anthropic API error object doesn't serialize to pino's `{ error }` pattern. The error logging was fixed to show `.message` and `.status` — next run will reveal the actual error.

### What's Built But Not Tested
- **Context planner** (`src/agent/context-planner.ts`) — replaces preflight, Opus searches memory + converses with user before deep path. Needs populated memory to test properly.
- **Analysis mode** — deep path with reduced tools when context planner says memory is sufficient. Needs planner to work first.

## What Was Built This Session

### Sprint S7: Memory Unification (complete)
- Removed `people` table — all knowledge as facts with entity tags
- Removed 5 bespoke tools (`list_people`, `list_commitments`, `slack_get_thread`, `slack_get_user_info`, `fireflies_sync_meetings`)
- Workspace .md pipeline replaces findings JSON
- `read_file` + `list_files` tools added to fast path
- DB wiped for fresh start

### Sprint S8: Proactive Memory (in progress)
- **Collectors**: Generic `Collector` interface + 4 implementations (Slack, Gmail, Drive, Fireflies)
  - Slack: cadence filter (skip channels with >21 day gaps), user token for broad access, bot DM exclusion
  - Gmail: noise filter (skip promotions, social, forums, calendar invites), 2000 thread limit
  - Drive: full folder paths via `buildFolderPathMap`, content snippets, staleness filter (6mo modified OR viewed), code/media MIME exclusion, git/hidden file post-filter
  - Fireflies: paginated at 50/page, summary extraction
- **Sweep executor**: parallel collection, fail-fast, file-based system prompt, synthesis mode (Write only), debug persistence
- **Context planner**: replaces Sonnet preflight with Opus, searches memory, converses with user, assesses sufficiency for analysis mode
- **Router update**: all paths have same tools, file reads route to FAST/MEDIUM not DEEP
- **Config**: `sweeps` section with per-source config (enabled, limits, cron, exclude lists)

## Key Architecture Decisions (This Session)

1. **One memory paradigm** — no special tables, no bespoke tools. Trust search_memory.
2. **Generic Collector interface** — pluggable for future sources (GitHub, QuickBooks, etc.)
3. **Single sweep cadence** — collect all sources together, synthesize together for cross-referencing
4. **Context planner replaces preflight** — Opus gathers context AND converses (not two separate steps)
5. **Three routing modes only** — FAST/MEDIUM/DEEP. Planner decides analysis mode, not router.
6. **Synthesis via CLI with file-based prompt** — `--append-system-prompt-file` for large content, `Write` tool only
7. **Plan before coding** — owner requires plan review before implementation

## Files Changed This Session

### New files (src/sweeps/):
- `types.ts` — Collector interface, CollectorResult, high-water mark helpers
- `slack-collector.ts` — Slack channel sweep with cadence filter
- `gmail-collector.ts` — Gmail thread sweep with noise filter
- `drive-collector.ts` — Drive file sweep with path resolution + content snippets
- `fireflies-collector.ts` — Fireflies meeting sweep with pagination
- `executor.ts` — Sweep orchestrator (parallel collect → synthesis → extraction)

### New files (other):
- `src/agent/context-planner.ts` — Opus context planning + user conversation
- `config/prompts/sweep-synthesis.md` — Opus synthesis prompt
- `config/prompts/context-planner.md` — Context planner system prompt

### Modified files:
- `src/agent/deep-path.ts` — synthesisMode, systemPromptFile, analysisMode, info-level tool logging
- `src/agent/hybrid.ts` — context planner replaces preflight, analysis mode wiring
- `src/agent/fast-path.ts` — read_file, list_files tools
- `src/agent/router.ts` — same 3 decisions (removed DEEP_ANALYSIS)
- `src/tasks/executor.ts` — sweep task dispatch, findings extraction with chunking
- `src/tasks/scheduler.ts` — sweep tasks bypass timeout
- `src/cli/start.ts` — collector registration, sweep deps
- `src/config.ts` + `config/default.json` — sweeps config section
- `src/prompts.ts` — sweepSynthesis, contextPlanner prompts
- `config/prompts/router.md` — all paths have same tools
- `src/memory/extractor.ts` — better error logging
- `src/google/drive-sync.ts` — exported buildFolderPathMap

## Immediate Next Steps

1. **Fix Haiku extraction** — run sweep, check actual error message (logging is now fixed). Likely need to handle the Anthropic error type properly or reduce chunk size.
2. **Verify end-to-end** — once extraction works: collect → synthesize → extract → verify facts in Postgres
3. **Test context planner** — with populated memory, ask analytical questions and verify planner finds relevant facts
4. **Drive MIME filtering** — .ts files still getting through as text/texmacs. Consider folder-based exclusion.

## Backlog

### Immediate
1. Fix Haiku extraction from sweep findings
2. Context planner Slack progress feedback
3. Drive code file filtering improvement

### Near-term
1. Unified tool access across all paths
2. Artifact short-term memory (FIFO cache for follow-ups)
3. Sweep status in Slack
4. Ad hoc backfill CLI
5. --session support for deep path

### Strategic
1. Plugin adapter + CC memory bridge (shared brain via MCP)
2. Finance integration
3. GitHub integration
4. Obsidian .md export

## Hard-Won Gotchas (new this session)
- CLI `--append-system-prompt` has OS arg size limit (~128KB) — use `--append-system-prompt-file` for large prompts (E2BIG error)
- Bash heredoc (`cat << 'EOF'`) breaks on apostrophes, quotes, dollar signs in business data — use `Write` tool
- Google Drive classifies `.ts` TypeScript files as `text/texmacs` — MIME type alone can't filter code
- Synced git repos in Drive flood `files.list` with .git objects (application/octet-stream)
- Drive API `files.list` does NOT support `name starts with` — only `name contains` and `mimeType !=`
- Parallel `Promise.allSettled` for collectors — still fail-fast by checking each result
- Haiku extraction needs chunked input — findings files can be 27KB+
- `extractionMaxTokens` was too low (2000) for extracting from large chunks — bumped to 8000
- Debug workspace must be copied AFTER synthesis, not before (otherwise findings/ is empty)
- Context planner runs `executeFastPath` internally — no Slack reaction lifecycle (goes silent)
- Router didn't know about read_file/list_files — was sending file reads to DEEP instead of MEDIUM
