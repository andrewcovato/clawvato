# Last Interactions — Session 27

### Migration Execution (Steps 1-5)
**User**: Show me the full migration steps. Let's go!
**Assistant**: Executed all 5 steps in sequence:
1. Comms brain + sidecar in brain-platform (3 connectors, 3 brains live, 55/55 tests)
2. Stripped sweeps from clawvato sidecar (task poller + event feed only)
3. Deleted ~9,800 lines from clawvato (memory, sweeps, hybrid agent, drive-sync, file-extractor)
4. Published @andrewcovato/brain-platform@1.1.0, updated all settings.json files
5. Stopped clawvato-memory Railway service

### Historical Backfill Discussion
**User**: I want to back-populate emails, Slack, and Fireflies from Nov 2025. Thousands of threads.
**Assistant**: ~$5 Sonnet cost for 2,500 emails. Not worth CLI side-quest. Started 1-week test sweep.
**Result**: Comms brain grew 21→50 memories. Quality good. But identified stale commitment problem.

### Context-Down Problem
**User**: Some stuff has been completed and is orphaned as "still needs to be done." CVs for Coles is done — the session that did it wasn't connected to memory.
**Assistant**: This is the cross-brain stitching gap. Without context-down, action-oriented concepts rot.
**User**: This isn't just for tasks. Build it generically.
**Assistant**: Designed unified feed system. Same mechanism for feeds UP and context DOWN.
**Decision**: Build inter-brain feeds generically before doing historical backfill.

### Inter-Brain Feed System
**User**: Let's plan it and build it.
**Assistant**: Planned and implemented:
- engine/feeds.ts: raw + synthesized modes, cycle prevention, origin tracking
- 5 feed connections across 3 brains configured in YAML
- Scheduler wired with 30-min sweep timer
- MCP tools: run_feeds, get_feed_status
**Verified**: comms→primary raw feed moved 17 facts. origin_brain tracked. 0 cycles.
**Issue**: Synthesized feed has JSON parsing error (Sonnet returns markdown).

### Per-Entity Brain Architecture
**User**: Having one brain per client/project/department. Every brain has all channel connectors but does deeper filtering.
**Assistant**: Major architectural shift — source-owned → entity-owned brains. Noted for design next session.
**Decision**: Table for fresh session.

### TurboQuant Discussion
**User**: Shared Google Research TurboQuant paper + MLX implementation branch.
**Assistant**: Most applicable concept: polar coordinate vector compression for embedding storage at scale. Not actionable yet — watch for pgvector-compatible packaging.
**Decision**: Tabled. Scaling problem we don't have yet.
