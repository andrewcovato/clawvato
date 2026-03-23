# Session Handoff

> Last updated: 2026-03-23 | Session 21 | Sprint S9

## Quick Resume

```
Sprint: S9 — CC-Native Engine + Shared Memory Brain
Status: HTTP MEMORY PLUGIN DEPLOYED — all instances wired
Branch: cc-native-engine (GitHub auto-deploy to Railway)
Engine: ENGINE=cc-native env var activates CC-native mode
Database: Railway managed Postgres — 125+ memories, 693 entity tags
Task Channel: #clawvato-tasks (C0AN5J0LCP3)
Build: Clean (tsc --noEmit passes)
Deploy: Live on Railway via GitHub auto-deploy (both clawvato + clawvato-memory services)
Memory Plugin: github.com/andrewcovato/clawvato-memory — deployed as HTTP MCP server on Railway
  Public URL: https://clawvato-memory-production.up.railway.app/mcp
  Internal URL: http://clawvato-memory.railway.internal:8080/mcp
  Auth: Bearer token (MCP_AUTH_TOKEN env var on both services)
Local CC: wired to public URL via .mcp.json (type: "http")
Railway CC: wired to internal URL via runtime-generated MCP config
NEXT: Remove in-tree MCP server, memory scoping, stabilize
```

## What Happened This Session (Session 21)

### Native Plugin Audit — What to Keep vs Replace

Full comparison of Anthropic's native MCP plugins (Gmail, Calendar, Slack, Fireflies, Figma) vs Clawvato's custom integrations:

| Integration | Decision | Rationale |
|---|---|---|
| Calendar | Keep custom `gws` CLI | Feature parity, less overhead than MCP |
| Gmail | Keep custom `gws` CLI | Native can't send email — only creates drafts |
| Drive | Keep custom | No native Drive plugin exists |
| Slack | Keep custom Channel MCP | Native can't do reactions — breaks the entire UX |
| Fireflies | **Split**: native for interactive, custom for sweeps | Native has better search grammar; custom needed for sweep ingestion pipeline |
| Memory/Tasks/Sweeps | Keep custom | No native equivalent — this IS the product |

Key insight: Native plugins are designed for interactive, stateless, session-scoped use. Clawvato is an autonomous operating system with persistent memory, background ingestion, and cross-instance coordination. They solve different problems.

### Fireflies + Slack Prompt Updates

Updated all 3 prompts (cc-native-system.md, system.md, deep-path.md):
- Fireflies: switched from bash CLI (`npx tsx tools/fireflies.ts`) to native `fireflies_*` MCP tools for interactive queries. Custom FirefliesClient retained only for sweep collector.
- Slack: added native `slack_search_public_and_private` and `slack_search_users` to cc-native prompt for cross-channel search alongside custom Channel MCP.

### HTTP Memory Plugin — Full Implementation (Option 3)

Built, deployed, and wired the HTTP transport for `clawvato-memory`:

1. **Dual transport in plugin** (`server/index.ts`):
   - `MCP_TRANSPORT=http` → HTTP server with StreamableHTTPServerTransport
   - Default (no env var) → stdio transport (unchanged, for local dev)
   - Stateless mode: new Server+Transport per request (MCP SDK requires 1:1 binding for concurrent clients)
   - Bearer token auth middleware on all MCP endpoints
   - Health endpoint: `GET /health` with Postgres connectivity check
   - CORS support for cross-origin clients
   - Connection pool: 10 for HTTP (vs 3 for stdio)

2. **Railway service created**:
   - Service: `clawvato-memory` in the `clawvato` project
   - Public URL: `https://clawvato-memory-production.up.railway.app`
   - Internal URL: `clawvato-memory.railway.internal:8080`
   - Env vars: `MCP_TRANSPORT=http`, `DATABASE_URL=${{Postgres.DATABASE_URL}}`, `MCP_AUTH_TOKEN`
   - Health check configured at `/health`
   - GitHub repo connected for auto-deploy

3. **Local CC wired** (`.mcp.json`):
   - Changed from stdio (local process + direct Postgres URL) to HTTP (Railway public URL + bearer token)
   - Format: `"type": "http"` (not `"url"` — CC schema validation requires `"http"`)
   - Verified working: search_memory returns live data from Railway Postgres

4. **Railway CC wired** (`cc-native-entrypoint.sh`):
   - Entrypoint now generates MCP config at runtime (heredoc → `/tmp/cc-native-mcp.json`)
   - Injects `MCP_AUTH_TOKEN` from env var via `$env(MCP_CONFIG)` in expect script
   - Uses internal Railway URL for zero-latency service-to-service communication
   - `MCP_AUTH_TOKEN` set on both Railway services (memory + agent)

### Eyes Bug Fixed

The 👀 reaction was added on message receipt but never removed. Now removed immediately after the channel event is pushed to CC:
- 👀 added → message received (code-enforced, instant feedback)
- 👀 removed → channel event pushed to CC (code-enforced)
- 🧠 added → CC starts processing (prompt-driven)
- 🧠 removed → CC posts response (prompt-driven)

### Search Limit Cap Removed

Owner directive: no artificial caps on query results. `search_memory` default is 20, but no hard maximum. If a query needs 2000 results, return 2000 results. Postgres and CC can handle it.

## Bugs Found and Fixed

1. **MCP config type**: `"type": "url"` fails CC schema validation → must be `"type": "http"`
2. **Expect/Tcl variable**: `$MCP_CONFIG` in single-quoted expect heredoc was read as Tcl variable → fix: `export MCP_CONFIG` + `$env(MCP_CONFIG)`
3. **Eyes reaction stuck**: 👀 added but never removed → added removal after channel event push
4. **Search limit too tight**: Hard cap at 50 results → removed cap entirely

## Files Modified This Session

### clawvato repo:
- `config/prompts/cc-native-system.md` — Fireflies native MCP tools + Slack native search
- `config/prompts/system.md` — Fireflies native MCP tools (hybrid fallback)
- `config/prompts/deep-path.md` — Fireflies native MCP tools (deep path)
- `scripts/cc-native-entrypoint.sh` — Runtime MCP config generation, internal URL, expect fix
- `src/cc-native/slack-channel.ts` — Eyes reaction removal after CC pickup

### clawvato-memory repo:
- `server/index.ts` — HTTP transport, dual transport, stateless Server per request, auth middleware, health endpoint, search limit uncapped
- `package.json` — v0.2.0, `start:http` script, dev deps (typescript, @types/node)

## Architecture After This Session

```
Railway Project: clawvato
├── clawvato (agent) — CC-native engine
│     ├── Slack Channel MCP (stdio, in-process)
│     ├── clawvato-memory MCP (HTTP, internal network)
│     ├── Google/Fireflies via Bash (gws CLI)
│     └── Native MCP tools (Fireflies, Slack search)
│
├── clawvato-memory (HTTP MCP server) — NEW THIS SESSION
│     ├── 6 tools: search, store, retrieve, working ctx, list ctx, retire
│     ├── StreamableHTTPServerTransport (stateless)
│     ├── Bearer token auth
│     ├── Health check at /health
│     └── Connects to Postgres via internal network
│
├── Postgres (managed DB)
│     └── memories, agent_state, memory_entities, etc.
│
Local CC / Cowork / Teammates
  └── clawvato-memory MCP (HTTP, public URL + bearer token)
```

Push to `clawvato-memory` repo → Railway auto-deploys → all CC instances get updates.

## Immediate Next Steps

1. **Remove in-tree MCP server** — `src/mcp/memory/server.ts` + `src/mcp/memory/stdio.ts` are dead code now. Also remove the static `.cc-native-mcp.json` file (replaced by runtime generation).
2. **Memory scoping** — per-session project/domain partitioning. BLOCKING further memory scaling. Owner directive: no dev memories in the shared brain.
3. **Stabilize cc-native** — monitor Railway deploy for 24h with the new HTTP memory wiring.
4. **LLM reranking in plugin** — port from in-tree retriever. Essential at 1K+ memories.

## Backlog

### High Priority
1. Remove in-tree MCP server (dead code)
2. Memory scoping config (per-session project/domain filters)
3. LLM reranking in plugin retrieve_context
4. Track G Phase 1: read-only GitHub access
5. Sweep integration with cc-native

### Medium Priority
6. Tiered token budgets for retrieval
7. Hierarchical memory summarization (critical at 50K+)
8. Better embeddings (evaluate at 10K+)
9. Session topology design (topic bleed at high Slack volume)
10. SKILL.md as MCP resource
11. SessionEnd hook for memory extraction safety net
12. Artifact short-term memory (FIFO cache)

### Strategic
13. Merge cc-native to main (after stability proven)
14. Track G Phase 3: self-deploy with health check + auto-rollback
15. Finance integration
16. Obsidian .md export

## Hard-Won Gotchas (new this session)

- MCP config schema: CC requires `"type": "http"`, NOT `"type": "url"` — the latter fails schema validation silently
- Expect heredocs (`<< 'EOF'`) prevent bash variable interpolation — use `export` + `$env(VAR)` for Tcl access
- MCP SDK's `Server.connect()` is 1:1 with transport — for HTTP with concurrent requests, create new Server+Transport per request
- `railway add --service` + `source.repo` via CLI doesn't trigger GitHub webhook auto-deploy — must connect repo through Railway dashboard
- Railway injects `PORT` automatically (default 8080) — don't hardcode port
- Native Claude MCP plugins (Gmail, Fireflies, etc.) are stateless + session-scoped — they can't replace systems that need persistent memory or background processing
- Don't impose artificial caps on query results — use sensible defaults but no hard maximums
