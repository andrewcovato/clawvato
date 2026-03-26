# Last Interactions — Session 29

### Backfill Verification + Architecture Pivot
**User**: Asked to verify backfill status and check cloud brief staleness.
**Assistant**: Found Acorns brain had 496 facts (mostly misrouted — Coles, Vail, Roblox, DraftKings all landing in Acorns). GYG/Vail/Ad Platforms brains were empty. Root cause: "Andrew Covato" entity dominated scoring. Cloud brief was stale (8h) despite 7:51 AM interaction.
**Decision**: Entity routing is fundamentally broken. Need architectural change.

### Architecture Design — Dumb Brains, Smart Agents
**User**: "When you looked at Acorns, you immediately knew stuff was wrong. Why don't we lean into that?" Pushed toward LLM judgment over scoring engines. Proposed dedicated CC instances per entity brain. Decided on Sonnet curator + Opus entity agents. Insisted on full content ingestion (entire email threads, transcripts). Wanted direct human input via CoS (store_fact, correct). Materialized brain.md files as instant context. business-state.md as CoS meta-summary.
**Assistant**: Wrote comprehensive design doc (DESIGN_AGENT_ARCHITECTURE_V2.md). Architecture: CoS (Channels, always-on) + Curator (--print --session, Sonnet) + Entity agents (--print --session, on-demand Opus). Mailbox for inter-agent comms. Three-layer freshness (push + hourly sweep + query-time). NOTIFY triggers for mechanical brain.md regeneration.
**Decision**: Brains are dumb storage. CC CLI agents are the intelligence. Delete entity-router, triage, Haiku NER from brain-platform.

### Build — Phase 1 Complete
**User**: "PLAN AND BUILD! Full autonomous, I'll be away."
**Assistant**: Built Phase 1 infrastructure in brain-platform:
- engine/mailbox.ts: inbox + agent_messages tables, CRUD, NOTIFY triggers, 11 tests
- engine/brain-state.ts: brain.md + business-state.md generation, NOTIFY listener, debounce, 8 tests
- adapters/mcp.ts: 11 new MCP tools (mailbox + inbox + brain state)
- Deleted: entity-router.ts, triage.ts, entity-router.test.ts, triage.test.ts
- Modified: poll-scheduler.ts (discovery-only), config.ts (removed entityRouting), brain-config.ts (removed refreshEntityList), server/index.ts (schema migrations + brain state listener)
- Version: 1.5.0, 61 tests all passing

Built Phase 2 in clawvato:
- scripts/curator-loop.sh: always-on Sonnet curator with --print --session
- src/cc-native/agent-supervisor.ts: LISTEN/NOTIFY message router, agent lifecycle
- config/prompts/curator-system.md + entity-agent-system.md: system prompts
- scripts/cc-native-entrypoint.sh: updated with curator + supervisor startup
