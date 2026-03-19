# Session Handoff

> Last updated: 2026-03-18 | Session 14 | Sprint S3

## Quick Resume

```
Sprint: S3 — SDK Pivot (COMPLETE)
Status: Hybrid architecture deployed on Railway and tested
Tests: 311/311 passing across 24 files
Build: Clean
Commits this session: 20
NEXT: Prompt tuning, Phase 5 trim (old code), consolidation/importance scoring
```

## What Was Built (Session 14)

**20 commits** transforming the monolithic agent into a two-path hybrid:

### New Modules (~1,500 lines)
- `src/agent/hybrid.ts` — Main orchestrator (fast/heavy routing, interrupt handling)
- `src/agent/router.ts` — Haiku complexity classifier
- `src/agent/fast-path.ts` — Direct API loop (Sonnet, 10 turns, 60s)
- `src/agent/heavy-path.ts` — Claude CLI subprocess (Opus, stream-json, 200 turns, 20min)
- `src/agent/context.ts` — Shared context assembly
- `src/mcp/memory/server.ts` — Memory MCP server (6 tools)
- `src/mcp/memory/stdio.ts` — stdio entrypoint with stderr logging
- `tools/fireflies.ts` — Fireflies CLI for SDK bash access
- `config/prompts/heavy-path.md` — SDK system prompt
- `scripts/docker-entrypoint.sh` — Railway startup (auth persistence)

### Key Bugs Found & Fixed
1. **MCP stdout corruption** — pino logs mixed with JSON-RPC → CLI hung. Fix: `LOG_DESTINATION=stderr`
2. **Memory wipe on every deploy** — v5 reset migration guard key not persisting. Fix: removed migration
3. **Memory writes blocked** — `update_working_context`/`store_fact` classified as external writes. Fix: whitelisted in policy engine
4. **Short-term context too small** — 2000 tokens → follow-ups lost context. Fix: bumped to 8000
5. **TLS errors on Railway** — `node:22-slim` missing CA certs. Fix: `apt-get install ca-certificates`
6. **gws auth format** — encrypted credentials need full dir, not exported JSON. Fix: `GWS_CONFIG_B64`
7. **stream-json requires --verbose** — undocumented CLI requirement. Fix: added flag
8. **.claude.json missing** — CLI hung on onboarding. Fix: create at startup

### What Works Now
- Fast path: memory queries, calendar checks, gmail search (~2s)
- Heavy path: multi-source sweeps with Opus via SDK (~1-5min, free on Max)
- Real-time progress updates in Slack during heavy path
- Memory persists across deploys
- Owner can cancel heavy path with "stop"/"cancel"
- Background extraction from both paths → facts stored to memory
- gws CLI authenticated on Railway for Gmail/Calendar/Drive

### What Needs Work
- **Prompt tuning**: Heavy path thoroughness varies, model sometimes misclassifies search results
- **Phase 5 trim**: Old modules (agent/index.ts, search/, email-scan.ts) still in codebase
- **Consolidation/importance scoring**: Memory accumulates but doesn't consolidate or decay yet
- **Gmail search logging**: Added `query` + `threadsFound` logging — use to diagnose search quality

---

## Deployment Checklist

Railway env vars needed:
```
ANTHROPIC_API_KEY          — for fast path (Sonnet API calls)
CLAUDE_CODE_OAUTH_TOKEN    — for heavy path (from `claude setup-token`)
GWS_CONFIG_B64             — for gws Google access (base64 tar.gz of ~/.config/gws/)
SLACK_BOT_TOKEN
SLACK_APP_TOKEN
OWNER_SLACK_USER_ID
FIREFLIES_API_KEY
GOOGLE_AGENT_EMAIL
```

Deploy: `railway up --detach`

---

## Architecture After Pivot

### Fast Path (Sonnet, ~$0.01, ~2s)
- Direct `messages.create` loop
- 7 tools: search_memory, update_working_context, calendar list/get, gmail_search, slack history/search
- 10 max turns, 60s timeout
- Training wheels enforced (trust level 1)

### Heavy Path (Opus, $0 on Max, ~1-5min)
- `claude --print --verbose --output-format stream-json` subprocess
- Memory MCP server (6 tools) + gws CLI (Google) + fireflies CLI (meetings)
- 200 max turns, 20min timeout
- `ANTHROPIC_API_KEY` stripped from env → uses Max plan OAuth
- Stream-json parsed for real-time Slack progress updates
- AbortController + 2s interrupt polling for cancel support

### Router (Haiku, ~$0.0002, ~200ms)
- Sees full assembled context (same as both paths)
- FAST: memory, single-source, simple commands, greetings
- HEAVY: cross-source, multi-step, synthesis, ambiguous
- Startup crawl always routes FAST (skip classifier)

### Memory System
- MCP server exposes 6 tools to SDK
- Background Haiku extraction after every interaction (owner message + SDK response)
- Working context auto-approved at trust level 1
- FTS5 + vector hybrid search, token-budgeted retrieval

---

## Owner Preferences (confirmed this session)
- DON'T REBUILD WHAT COMES NATIVELY WITH CLAUDE
- Don't make ad-hoc one-off prompt fixes — diagnose with logs first
- All prompts in config/prompts/*.md — never hardcode in TypeScript
- Memory should be HIGH RESOLUTION
- Let Opus cook — 20min timeout, 200 turns, free on Max
- Budget: Max plan for heavy ($0), API for fast (~$30-50/mo)
