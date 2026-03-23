# Session Handoff

> Last updated: 2026-03-23 | Session 20 | Sprint S9

## Quick Resume

```
Sprint: S9 — CC-Native Engine + Shared Memory Brain
Status: MEMORY PLUGIN VALIDATED (10/10 tests), IN-TREE SERVER UPDATED
Branch: cc-native-engine (GitHub auto-deploy to Railway)
Engine: ENGINE=cc-native env var activates CC-native mode
Database: Railway managed Postgres — 130 memories, 693 entity tags
Task Channel: #clawvato-tasks (C0AN5J0LCP3)
Build: Clean (tsc --noEmit passes)
Deploy: Live on Railway via GitHub auto-deploy
Memory Plugin: github.com/andrewcovato/clawvato-memory (local: /Users/andrewcovato/dev/clawvato-memory) — 7 bugs fixed, all 6 tools validated
CC-Native System Prompt: config/prompts/cc-native-system.md (needs SKILL.md injection for teaching)
Railway Plugin Service: Does NOT exist yet — needs to be created for Option 3
NEXT: Commit + push both repos, inject SKILL.md into system prompt, deploy to Railway, then Option 3 (HTTP MCP server)
```

## What Happened This Session (Session 20)

### Memory Plugin Validation (10/10 tests pass)

Ran full CRUD test cycle against the standalone plugin connecting to Railway Postgres:

| Test | Tool | Result |
|---|---|---|
| Browse (no query) | search_memory | PASS |
| Keyword search | search_memory | PASS |
| Filtered search | search_memory | PASS |
| Token-budgeted retrieval | retrieve_context | PASS |
| Store test fact | store_fact | PASS |
| Verify write via search | search_memory | PASS |
| Set working context | update_working_context | PASS |
| List all working contexts | list_working_contexts | PASS — saw Railway instance's state! |
| Clear working context | update_working_context (clear) | PASS |
| Retire test fact | retire_memory | PASS — verified it drops from search |

### 7 Bugs Found and Fixed in Plugin

1. `search_vector` → `content_tsv` (column name mismatch with Railway schema)
2. Removed `updated_at` from memories INSERT (column doesn't exist)
3. Added `id` generation via `crypto.randomUUID()` (schema requires explicit TEXT PK)
4. Removed `created_at` from `memory_entities` INSERT (column doesn't exist)
5. Added `valid_until IS NULL` to all query paths (was returning retired/superseded facts)
6. `delete_memory` → `retire_memory` (soft-delete via `valid_until = NOW()`, preserves audit trail)
7. Added `normalizeCategory()` (lowercase + strip trailing 's' to prevent category drift)

### In-Tree MCP Server Updated

Ported two new tools to `src/mcp/memory/server.ts` to match plugin functionality:
- `list_working_contexts` — cross-instance awareness (groups by session, handles both `wctx:label` and `wctx:SESSION_ID:label` formats)
- `retire_memory` — soft-delete with audit trail (matches plugin's behavior)

Build passes clean.

### Design Spec Written: Remote Memory Plugin (Option 3)

`docs/DESIGN_REMOTE_MEMORY_PLUGIN.md` — comprehensive spec for converting the memory plugin from stdio to HTTP MCP server on Railway:
- StreamableHTTPServerTransport (dual transport: stdio for local dev, HTTP for production)
- Separate Railway service with GitHub auto-deploy
- Bearer token auth
- Internal network for Railway CC, public URL for local/Cowork
- SKILL.md as MCP resource for teaching CC instances about capabilities
- Migration path: dual transport → remove in-tree server → SKILL.md as resource
- Latency analysis: ~100-200ms added, negligible vs LLM inference

### Key Architectural Decision: Correction via Retire, Not Delete

Deep crawl of the memory architecture revealed:
- Every in-tree surface (sweeps, consolidation, fast-path, Drive/Fireflies sync) uses `supersedeMemory()` — soft-delete with `valid_until = NOW()`
- Plugin was the only surface doing hard DELETE — inconsistent and destructive
- **Decision**: All correction flows use soft-delete (retire). CC corrects facts via: `store_fact` (new) → `retire_memory` (old). Future hard-purge of old superseded rows can be added to consolidation when needed.

### The "Teaching Problem" Identified

Railway CC instance doesn't know about `list_working_contexts` because:
1. Its MCP server (in-tree) didn't expose it (FIXED)
2. Its system prompt doesn't mention multi-instance awareness
3. SKILL.md from the plugin isn't loaded on Railway

**Solution path** (in design doc): Inject condensed SKILL.md into `config/prompts/cc-native-system.md`, long-term serve SKILL.md as MCP resource.

## What's Working (deployed + local)

### CC-Native Engine (Track O — deployed on Railway)
```
Railway container:
  Supervisor (expect + restart loop)
    └── claude (interactive, Max plan = $0)
          ├── Slack Channel MCP server (Socket Mode → channel events)
          ├── Memory MCP server (in-tree, NOW with list_working_contexts + retire_memory)
          └── Google/Fireflies via Bash

  Task Scheduler (standalone sidecar)
```

### Memory Plugin (Track H — validated locally)
```
Standalone repo: github.com/andrewcovato/clawvato-memory
  ├── 6 tools: search_memory, store_fact, retrieve_context,
  │            update_working_context, list_working_contexts, retire_memory
  ├── Session-scoped working context (wctx:SESSION_ID:key)
  ├── SKILL.md teaching CC memory discipline
  ├── Connects to Railway Postgres via public URL
  └── Validated: 10/10 CRUD tests pass from local CC
```

### Cross-Instance Awareness Demonstrated
- Local CC can see Railway instance's working contexts (Coles RFP, sweep cadence, etc.)
- Railway can see local sessions (once deployed with updated in-tree server)
- Shared Postgres is the coordination layer — no message passing needed

## Files Created/Modified This Session

### New:
- `docs/DESIGN_REMOTE_MEMORY_PLUGIN.md` — Spec for HTTP MCP server (Option 3)

### Modified (clawvato repo):
- `src/mcp/memory/server.ts` — Added `list_working_contexts` + `retire_memory` tools
- `.project/sessions/HANDOFF.md` — This file
- `.project/state.json` — Updated session/sprint state

### Modified (clawvato-memory repo):
- `server/index.ts` — 7 bug fixes (schema alignment, retire_memory, valid_until filter, category normalization)
- `skills/memory/SKILL.md` — Updated `delete_memory` → `retire_memory`, added correction workflow

### NOT YET COMMITTED
Both repos have uncommitted changes. Need to commit + push both.

## Immediate Next Steps

1. **Commit + push both repos** — clawvato (in-tree fixes) + clawvato-memory (plugin fixes)
2. **Deploy in-tree fixes to Railway** — push triggers auto-deploy, Railway CC gets `list_working_contexts` + `retire_memory`
3. **Inject memory awareness into CC-native system prompt** — add condensed SKILL.md to `config/prompts/cc-native-system.md`
4. **Implement Option 3** — HTTP transport for memory plugin:
   - Add StreamableHTTPServerTransport to plugin
   - Deploy as separate Railway service
   - Wire Railway CC to internal URL
   - Wire local CC to public URL
5. **Remove in-tree MCP server** — once Railway CC uses the HTTP plugin

## Backlog

### High Priority
1. Option 3: HTTP MCP memory server (design doc ready)
2. Track G Phase 1: read-only GitHub access
3. Track G Phase 2: branch + PR (self-development, owner-gated)
4. Inject SKILL.md into cc-native system prompt
5. Sweep integration with cc-native

### Medium Priority
6. SKILL.md as MCP resource (future-proof teaching)
7. Track G Phase 3: self-deploy with health check + auto-rollback
8. Artifact short-term memory (FIFO cache)
9. SessionEnd hook for memory extraction safety net

### Strategic
10. Merge cc-native to main (after stability proven)
11. Finance integration
12. Obsidian .md export
13. Clawvato self-development (Track G Phase 3)

## Hard-Won Gotchas (new this session)

- Plugin schema must exactly match Railway DB — `search_vector` vs `content_tsv`, `updated_at` doesn't exist, `created_at` not on `memory_entities`, `id` must be explicitly generated
- Plugin `store_fact` must populate BOTH `memories.entities` (JSON column) AND `memory_entities` (junction table) — the in-tree code uses both paths for different lookups
- `delete_memory` (hard DELETE) can dangle `superseded_by` FK references — always use soft-delete (`valid_until = NOW()`)
- Superseded rows are free for queries (filtered by index), cheap for storage (embedding deleted), and autovacuum handles bloat
- Railway CC won't know about new MCP tools unless: (a) the MCP server exposes them, (b) the system prompt teaches them, (c) SKILL.md is loaded
- Global `~/.claude/.mcp.json` may not load for a project — use project-scoped config
