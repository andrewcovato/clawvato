# Session Handoff

> Last updated: 2026-03-25 | Session 27 | Phase 3 In Progress

## Quick Resume

```
Phase: 3 IN PROGRESS — Inter-Brain Intelligence
Branch: cc-native-engine (clawvato), main (brain-platform)
Build: Clean (both repos, 55/55 tests green on brain-platform)
State: MIGRATION COMPLETE — feeds system live, historical backfill pending

brain-platform repo: github.com/andrewcovato/brain-platform
  - Railway: brain-platform-production.up.railway.app
  - 3 brains: primary (~185 mems), dev (~90 mems), comms (~50 mems, growing)
  - Inter-brain feeds: 5 connections (raw + synthesized), 30-min sweep
  - Sidecar: 3 connectors (Slack, Gmail, Fireflies), 15-min sweep frequency
  - npm: @andrewcovato/brain-platform@1.1.0

clawvato repo: THINNED — 9,822 lines deleted
  - Thin agent: CC-native engine + task poller + event feed
  - No memory/, sweeps/, hybrid agent code — all in brain-platform
  - Hybrid agent DELETED (not just deprecated)

clawvato-memory: STOPPED on Railway. Nothing points to it. Archive candidate.
```

## Session 27 — What Was Built

### Migration Complete (Steps 1-5)
1. **Comms brain + sidecar**: 3 connectors wired (Slack, Gmail, Fireflies), all routing to comms brain
2. **Old sidecar stripped**: Task poller + event feed only (~130 lines, was ~350)
3. **Clawvato thinned**: 9,822 lines deleted — memory, sweeps, hybrid agent, drive-sync, file-extractor, fireflies/sync, dead tests
4. **npm package**: @andrewcovato/brain-platform@1.1.0 published, SessionStart hooks updated
5. **clawvato-memory decommissioned**: Railway service stopped, all references updated

### Inter-Brain Feed System (Track R)
- `engine/feeds.ts`: 280 lines — queryFeedableFacts, runFeedConnection (raw + synthesized), runFeedSweep, generateSynthesisPrompt
- Raw mode: individual facts flow source→target through dedup with origin_brain tracking
- Synthesized mode: Sonnet produces digest facts from source for target brain
- Cycle prevention: facts with origin_brain=target excluded from queries
- 5 feed connections configured across 3 brains
- 30-min global sweep timer, per-connection intervals (1h raw, 6h synthesized)
- MCP tools: run_feeds, get_feed_status
- VERIFIED: comms→primary raw feed moved 17 facts, origin_brain tracked, 0 cycles

### Brain-Specific Extraction
- `ingestConversation` now uses `generateExtractionPrompt(brain)` from brain-config
- Comms brain concepts (commitment, follow_up, meeting_outcome, relationship_signal) used during extraction
- Previously was using generic DEFAULT_EXTRACTION_PROMPT

### 15-Minute Sweep Frequency
- Slack + Gmail + Fireflies sweep every 15 minutes (was 1h Slack/FF, 24h Gmail)

### 1-Week Test Backfill
- Reset Gmail/Slack/Fireflies HWMs to 1 week ago
- Comms brain grew from 21 → ~50 memories
- Quality good: follow_ups, commitments, meeting_outcomes, relationship_signals all extracted
- Identified problem: stale commitments (CVs for Coles already completed but stored as open)
- Decision: don't do historical backfill until context-down feeds are working
- HWMs reset back to present; live sweeps continue

## Current State

### Feed Connections (live)
- comms→primary: raw (commitment, follow_up, meeting_outcome, 1h) — VERIFIED WORKING
- comms→primary: synthesized (relationship_signal, 6h) — JSON parse error, needs prompt fix
- primary→comms: synthesized (deal_status, commitment, 6h) — this is the critical context-down
- primary→dev: raw (commitment, 7+ importance, 1h)
- dev→primary: raw (project_milestone, 1h)

### Known Issues
1. Synthesized feed JSON parsing — Sonnet sometimes returns markdown instead of JSON
2. Feed query checks both `concept_type` and `type` columns (extraction stores in `type` not `concept_type`)
3. Railway deploys can get stuck behind long-running sweep processes — use dashboard restart

### Key Decisions
1. Unified feed model: raw + synthesized are the same mechanism with different config
2. No automatic cross-brain retirement — dedup + consolidation handle conflicts
3. Historical backfill blocked until context-down feeds verified working
4. Per-entity brain architecture proposed (1 brain per client/project) — design next session
5. 15-min polling sufficient — Gmail Pub/Sub webhook deprioritized

## Files Created/Modified This Session

### brain-platform (new files)
- brains/comms.brain.yaml (+ connections on all 3 brain configs)
- sidecar/init-connectors.ts
- engine/feeds.ts (full implementation, was skeleton)
- scripts/{fetch-handoff,session-end-handoff,journal-hook,check-version}.sh
- bin/setup.ts (CLI for npm package)

### brain-platform (modified)
- server/index.ts (sidecar wiring)
- server/scheduler.ts (feed timer, non-blocking startup)
- engine/ingest.ts (brain-specific extraction + origin_brain)
- engine/brain-config.ts (unified FeedConnectionConfig)
- adapters/mcp.ts (run_feeds, get_feed_status tools)
- sidecar/poll-scheduler.ts (15-min frequency, gmail added to frequent tier)
- package.json (v1.1.0, scripts/ in files)

### clawvato (deleted ~9,800 lines)
- DELETED: src/memory/ (7 files), src/sweeps/ (7 files), src/agent/ (6 files)
- DELETED: src/tasks/executor.ts, src/google/drive-sync.ts, src/google/file-extractor.ts, src/fireflies/sync.ts
- DELETED: tests/memory/ (5 files), tests/google/ (2 files)
- Modified: src/cc-native/task-scheduler-standalone.ts (sweeps stripped)
- Modified: src/cli/start.ts (cc-native only), src/cli/index.ts (engine flag removed)
- Modified: src/db/index.ts, src/google/tools.ts (dead import removal)
- Modified: .mcp.json (BRAIN_CONFIG_DIR added)

### Settings updated
- ~/.claude/projects/-Users-andrewcovato-dev-clawvato/settings.json (brain-platform URLs + package)
- ~/.claude/projects/Users-andrewcovato-dev-newmail/settings*.json (same)
- ~/.claude/.mcp.json (brain-platform source path)

## Recent Interactions
**User**: Let's finish the migration (Steps 1-5).
**Assistant**: Executed all 5 steps. Comms brain live, sidecar wired, 9.8K lines deleted, npm published, old service stopped.

**User**: Can we back-populate 5 months of emails? What about using Claude CLI instead of Sonnet API?
**Assistant**: ~$5 worst case for Sonnet. Not worth CLI side-quest. Started 1-week test.

**User**: Stale commitments problem — CVs for Coles stored as open but already done. Context-down needed.
**Assistant**: Proposed options. User chose: do it right, build context-down first.

**User**: This isn't just for tasks — it's for everything. Build it generically.
**Assistant**: Designed inter-brain feed system. Unified raw + synthesized modes. Built, deployed, verified.

**User**: Per-entity brains (1 per client/project) — all channels, deeper filtering.
**Assistant**: Noted for next session design. Fundamental shift from source-owned to entity-owned brains.

## Next Steps
1. Fix synthesized feed JSON parsing
2. Verify primary→comms context-down feed (the one that resolves stale commitments)
3. Design per-entity brain architecture
4. Historical backfill once context-down is verified
