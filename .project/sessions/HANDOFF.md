# Session Handoff

> Last updated: 2026-03-25 | Session 26 | Phase 3 In Progress

## Quick Resume

```
Phase: 3 IN PROGRESS — Brain Platform Migration
Branch: cc-native-engine (clawvato), main (brain-platform)
Build: Clean (both repos, 55/55 tests green on brain-platform)
State: MID-MIGRATION — brain-platform deployed + cutover done, cleanup pending

brain-platform repo: github.com/andrewcovato/brain-platform (private)
  - Railway: brain-platform-production.up.railway.app
  - 36 files, ~4,700 lines, 23 MCP tools
  - 2 brains: primary (149 mems, 12 clusters), dev (96 mems, 4 clusters)
  - Recursive concept-aware HDBSCAN (adaptive depth, composite embeddings)
  - Sidecar code EXISTS but NOT running (still in clawvato)

clawvato repo: NOT YET THINNED — ~7,500 lines to delete
  - Old sidecar still running (sweeps → brain-platform /ingest)
  - src/memory/ and src/sweeps/ still in codebase (dead code)
  - MCP server name still "clawvato-memory" (backward compat)

clawvato-memory: ZOMBIE — running on Railway, nothing points to it. Safe to stop.

NEXT: Step 1 of migration plan — comms brain + wire sidecar into brain-platform
```

## Session 26 — What Was Built

### Brain Platform (new repo: brain-platform)
- Created repo from scratch, 36 TypeScript files, ~4,700 lines
- **Engine**: 22 files ported from clawvato-memory with brain_id scoping on ALL queries
  - db, log, session, utils, types (foundation)
  - embed, reranker (ML models, $0 local)
  - dedup (3-tier with brain_id scoping, entity parsing fix)
  - cluster (MAJOR: recursive concept-aware HDBSCAN — see below)
  - search, retrieve (7-stage pipeline), ingest (store + extraction)
  - surface, context (briefs/handoffs — global, not brain-scoped)
  - brain-config (YAML loader), prompt-generator (concepts → extraction prompt)
  - consolidate, decay, reflect (per-brain scheduler jobs)
  - feeds, triggers (skeletons for future)
- **Connectors**: 7 files ported from clawvato/src/sweeps/
  - Slack (298 lines), Gmail (200), Fireflies (140 + client 100), Drive (stub)
  - Retry utility, connector types with brainId routing
- **Adapters**: MCP (23 tools with brain_id), REST (skeleton)
- **Sidecar**: poll-scheduler, webhook-server (skeleton), entrypoint
- **Server**: index.ts (HTTP/stdio dual transport), scheduler (per-brain jobs)
- **Config**: dev.brain.yaml (4 concepts), primary.brain.yaml (4 concepts)

### Recursive Concept-Aware Clustering
- Composite clustering embeddings: `[concept_type] entities: content`
- Recursive HDBSCAN: adaptive depth per branch, stops when no sub-structure
- Primary brain: 10 root clusters, 2 sub-clusters, max depth 1
  - Coles (8) → C360 geo-testing (3) + measurement case study (3)
  - Acorns, Roblox, Vail, MeasurementOS all properly separated
- Dev brain: 4 flat clusters (sparse data stays flat naturally)
- Cluster identity preservation across re-runs (centroid similarity matching)
- Incremental tree assignment (walks root→leaf, marks dirty for rebalance)
- Tree structure: parent_cluster_id, depth, generation, dirty columns

### Smart Memory Classification
- Analyzed 248 existing memories: 60% business intelligence, 40% technical
- Classified: 149 → primary brain, 96 → dev brain (3 remaining are test artifacts)
- Classification by source/domain/type/surface signals
- Default brain_id changed from 'dev' to 'primary'
- DB column default updated to match

### Deployment + Cutover
- brain-platform deployed to Railway (same project as clawvato)
- DB migration: brain_id, concept_type, metadata JSONB, origin_brain columns + indexes
- Hierarchical clustering columns: parent_cluster_id, depth, generation, dirty
- Cutover: CLAWVATO_MEMORY_URL + CLAWVATO_MEMORY_INTERNAL_URL → brain-platform
- Local .mcp.json updated to point at brain-platform source
- 55/55 live tests passing (18 test categories)

### Testing
- 55 live tests across 18 categories, all green
- Tests cover: health, auth, ingest pipeline, brain isolation, schema migration,
  clustering per-brain, dedup scoping, surface tools, embedding coverage,
  hybrid search, schema integrity, scheduler guards, backward compatibility,
  extraction quality, recursive clustering, concept-aware features,
  get_clusters tree structure, incremental assignment

### Key Decisions
1. brain-platform is the core system, not a plugin. CC is one adapter.
2. Logical brain separation (brain_id column, same DB) not separate services
3. Default brain_id = 'primary' (not 'dev') — business intelligence is the majority
4. Exclusive source ownership: each raw source has exactly one brain
5. Three flow types: feeds UP, context DOWN, drill-downs (any direction, ephemeral)
6. Concepts are per-brain YAML config → extraction prompts auto-generated
7. Recursive HDBSCAN with adaptive depth (HDBSCAN decides when to stop)
8. Composite clustering embeddings ([concept_type] entities: content)
9. Cluster identity preservation via centroid similarity matching
10. MCP server name stays "clawvato-memory" for backward compat (rename later)
11. Stay in clawvato directory for sessions (project state lives here)

## Migration Plan — Remaining Steps

### Step 1: Comms brain + sidecar in brain-platform (NEXT)
- Write brains/comms.brain.yaml (commitment, follow_up, meeting_outcome, relationship_signal)
- Wire sidecar into server/index.ts
- Move connector auth env vars to brain-platform
- Deploy, verify sweeps → comms brain

### Step 2: Kill old sidecar in clawvato
- Remove sweep logic from task-scheduler-standalone.ts, keep task poller + event feed

### Step 3: Thin clawvato (~7,500 lines)
- Delete src/memory/, src/sweeps/, drive-sync, file-extractor, fireflies/sync
- Fix broken imports, remove config sections, remove unused deps

### Step 4: npm package migration
- Publish @andrewcovato/brain-platform, update SessionStart hooks

### Step 5: Stop clawvato-memory + cleanup
- Stop Railway service, archive repo, update docs

### Step 6: Rename MCP server (optional, cosmetic)

## Files Created This Session
- brain-platform/ (entire repo — 36 TypeScript files)
  - engine/ (22 files), connectors/ (7 files), adapters/ (3 files)
  - sidecar/ (3 files), server/ (2 files), bin/ (empty, future)
  - brains/dev.brain.yaml, brains/primary.brain.yaml
  - tests/live-test.ts (55 tests)
  - package.json, tsconfig.json, railway.toml, .gitignore

## Files Modified This Session
- clawvato/.mcp.json (point at brain-platform source)
- clawvato/.project/sessions/* (handoff files)
- ~/.claude/projects/.../memory/ (project memories updated)

## Design Docs
- docs/DESIGN_BRAIN_PLATFORM.md — brain platform architecture (read, not modified)
- docs/DESIGN_PUBSUB_WEBHOOKS.md — webhook spec (read, not modified)
- ~/.claude/plans/cozy-inventing-candy.md — migration plan (created this session)
