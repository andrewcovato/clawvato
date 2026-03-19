# Session Handoff

> Last updated: 2026-03-18 | Session 14 | Sprint S3

## Quick Resume

```
Sprint: S3 — SDK Pivot + Hybrid Architecture
Status: PHASES 1-4 COMPLETE — hybrid agent built and wired in
Tests: 311/311 passing across 24 files
Build: Clean (npm run build passes)
New modules: 7 files (~1,280 lines)
NEXT: Integration test locally → deploy to Railway → Phase 5 trim
```

## What Was Built (Session 14)

### New Files Created

| File | Lines | Purpose |
|---|---|---|
| `src/mcp/memory/server.ts` | ~240 | Memory MCP server — 6 tools wrapping SQLite store |
| `src/mcp/memory/stdio.ts` | ~25 | stdio entrypoint for SDK subprocess |
| `tools/fireflies.ts` | ~140 | Fireflies CLI wrapper (search, summary, transcript, list) |
| `src/agent/heavy-path.ts` | ~180 | Claude Code SDK integration via `claude --print` |
| `src/agent/fast-path.ts` | ~230 | Simplified API loop (10 turns, 60s, limited tools) |
| `src/agent/router.ts` | ~100 | Haiku complexity classifier (FAST vs HEAVY) |
| `src/agent/context.ts` | ~130 | Shared context assembly (memory + working ctx + history) |
| `src/agent/hybrid.ts` | ~220 | Hybrid agent orchestrator (replaces old createAgent) |

### Files Modified

- `src/cli/start.ts` — now imports `createHybridAgent` instead of `createAgent`
- `src/prompts.ts` — marked `searchPlanning` and `searchRelevance` as deprecated

### Architecture

```
Slack message arrives
  → SlackHandler.handleMessage()
  → EventQueue accumulates (4s debounce)
  → handler.onBatch() triggers...
  → createHybridAgent.processBatch()
    → assembleContext() (shared: memory + working ctx + conversation history)
    → routeMessage() (Haiku classifier: FAST or HEAVY?)
    ├── FAST: executeFastPath() — direct API, limited tools
    │   Tools: search_memory, update_working_context,
    │          google_calendar_list/get, google_gmail_search,
    │          slack_get_channel_history, slack_search_messages
    └── HEAVY: executeHeavyPath() — claude --print subprocess
        MCP: memory server (stdio)
        CLI: gws (Google), tools/fireflies.ts (meetings)
        Fallback: if SDK fails → fast path
```

### Memory MCP Server Tools

1. `search_memory` — FTS5 + vector hybrid search with filters
2. `retrieve_context` — token-budgeted context retrieval
3. `store_fact` — store new memories
4. `update_working_context` — scratch pad CRUD
5. `list_people` — known people directory
6. `list_commitments` — outstanding commitments

### Fireflies CLI Commands

- `npx tsx tools/fireflies.ts search --query "X" --days-back 60`
- `npx tsx tools/fireflies.ts summary --id "abc123"`
- `npx tsx tools/fireflies.ts transcript --id "abc123"`
- `npx tsx tools/fireflies.ts list --days-back 30`

---

## What's Left

### Immediate (before first deployment)

1. **Integration test locally**: `npx tsx src/cli/index.ts start` — verify both paths work with real Slack
2. **Verify `claude` CLI is available**: heavy path needs it installed and authenticated
3. **Deploy to Railway**: Dockerfile needs `claude` CLI installed + Max plan auth

### Phase 5 Trim (after integration test)

Old modules preserved as fallback — remove after confirming hybrid works:
- `src/search/cross-source.ts` + `adapters.ts` (SDK replaces cross-source orchestration)
- `src/google/email-scan.ts` (SDK handles email analysis)
- `config/prompts/search-planning.md` + `search-relevance.md` (SDK doesn't need these)
- Old `src/agent/index.ts` (replaced by `hybrid.ts`, keep as reference)

### Open Issues

- **SDK-001**: Max plan OAuth on headless Railway — need SSH auth first, then persist tokens
- **SDK-002**: `gws` CLI on Railway — installable? Fallback to Google MCP if not
- **SDK-006**: Heavy path fallback behavior needs testing
- **TRIM-001**: Old code cleanup after integration testing

---

## Key Design Decisions

1. **Preserve old code**: Don't trim until hybrid is proven. Old agent/index.ts is the fallback.
2. **Haiku router**: ~$0.0002/call, ~200ms. Routes every message. Cost is negligible.
3. **Heavy path uses `claude --print`**: CLI subprocess, not SDK npm package. More stable interface.
4. **Memory is the only MCP server**: Google uses `gws` CLI, Fireflies uses thin CLI wrapper. Both via bash.
5. **Fast path includes calendar + gmail_search**: Single-source lookups that don't need the full SDK.
6. **Fallback on SDK failure**: If `claude` CLI not available or fails, fall back to fast path.

---

## Previous Session Context (Session 13)

Session 13 built comprehensive search (gmail_scan, cross_source_search, 10 commits) then realized the fundamental problem: we were rebuilding Claude Code's agent loop. This led to the pivot decision that Session 14 implemented.

### What Stays After Pivot

| Module | Status |
|---|---|
| Memory system (src/memory/*.ts) | Untouched — exposed via MCP server |
| Database + schema (src/db/) | Untouched |
| Slack bot layer (src/slack/*.ts) | Untouched |
| Security (src/security/*.ts) | Untouched — used by fast path |
| Training wheels | Untouched — used by fast path |
| Config + credentials | Untouched |
| Google tools (src/google/tools.ts) | Fast path uses calendar + gmail_search |
| Fireflies (api.ts + tools.ts + sync.ts) | CLI wrapper reuses api.ts |

## Owner Preferences

- **DON'T REBUILD WHAT COMES NATIVELY WITH CLAUDE** — prime directive
- Memory should be HIGH RESOLUTION — the differentiator
- Budget: Max plan for heavy ($0), API for fast (~$30-50/mo)
- Don't over-engineer
- Let Claude Code cook
- Preserve what we built where it adds value
