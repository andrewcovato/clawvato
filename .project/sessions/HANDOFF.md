# Session Handoff

> Last updated: 2026-03-26 | Session 29 | Agent Architecture v2

## Quick Resume

```
Phase: 3 IN PROGRESS — Agent Architecture v2 (dumb brains, smart agents)
Branch: cc-native-engine (clawvato), main (brain-platform)
Build: Clean (both repos compile, 61 tests green on brain-platform)
State: INFRASTRUCTURE COMPLETE — mailbox, inbox, brain-state all built and tested

brain-platform v1.5.0:
  - Mailbox (agent_messages) + inbox tables with NOTIFY triggers
  - Brain state generator (brain.md + business-state.md materialized views)
  - 11 new MCP tools (mailbox, inbox, brain-state)
  - Deleted: entity-router.ts, triage.ts (routing now handled by agents)
  - 61 tests, all passing

clawvato:
  - Agent supervisor (LISTEN/NOTIFY → route to CC --print --session agents)
  - Curator loop (Sonnet, always-on, --print --session)
  - System prompts for curator + entity agents
  - Entrypoint updated with curator + supervisor startup
```

## Session 29 — What Was Built

### Architecture Pivot
- Diagnosed backfill failure: entity routing put all 496 facts in Acorns, 0 in other brains
- Root cause: "Andrew Covato" entity dominated scoring
- Designed Agent Architecture v2: dumb brains + smart CC CLI agents
- Full design doc: docs/DESIGN_AGENT_ARCHITECTURE_V2.md

### Brain-Platform Infrastructure (Phase 1)
1. **Mailbox system**: engine/mailbox.ts — inbox + agent_messages tables, CRUD, NOTIFY triggers
2. **Brain state generator**: engine/brain-state.ts — per-brain .md files + business-state.md rollup
3. **MCP tools**: 11 new tools — send_message, get_messages, mark_message_done, reply_to_message, add_to_inbox, get_pending_inbox, mark_inbox_processed, mark_inbox_failed, get_brain_state, get_business_state, regenerate_brain_states
4. **NOTIFY triggers**: brain_updated on memories table (triggers brain.md regeneration), agent_mail on agent_messages
5. **Deleted**: entity-router.ts, triage.ts, and their tests
6. **Simplified**: poll-scheduler.ts (discovery-only, no triage), config.ts (removed entityRouting)

### Clawvato Agent Layer (Phase 2)
7. **Agent supervisor**: src/cc-native/agent-supervisor.ts — LISTEN/NOTIFY message router, invokes CC --print --session
8. **Curator loop**: scripts/curator-loop.sh — Sonnet, always-on, processes inbox, audits brains
9. **System prompts**: curator-system.md, entity-agent-system.md
10. **Entrypoint**: updated to start curator + supervisor as background processes

## Current State

### What Works
- Mailbox: send/receive messages between agents ✓ (11 tests)
- Inbox: content discovery pointers, processing lifecycle ✓
- Brain state: .md file generation from DB facts ✓ (8 tests)
- NOTIFY: triggers fire on fact changes, debounced regeneration ✓
- All 61 brain-platform tests pass ✓
- Both repos compile clean ✓

### What's Not Yet Tested End-to-End
1. Curator processing real inbox items (needs deployment or local run with CLI)
2. Agent supervisor routing real messages to CC --print
3. Brain.md regeneration via NOTIFY in production (tested in unit tests)
4. Full flow: content → inbox → curator → store_fact → brain.md → entity agent reads

### Known Issues
1. Acorns brain still has 496 misrouted facts — needs cleanup (curator audit job will handle this)
2. GYG/Vail/Ad Platforms brains still empty — need re-backfill with curator
3. business-state.md truncates purpose text at 80 chars (cosmetic)
4. brain.md for dev brain is 76K chars (~20K tokens) — may need pruning for large brains

## Next Steps
1. **Push brain-platform to main** → auto-deploy to Railway
2. **Push clawvato to cc-native-engine** → auto-deploy to Railway
3. **Test curator end-to-end** — verify it processes inbox items and files facts correctly
4. **Clean up Acorns brain** — run curator audit to retire misrouted facts
5. **Re-backfill** with curator doing the extraction (not the old triage pipeline)
6. **Test entity agent** — CoS sends message via mailbox, entity agent responds
7. **Wire up webhooks** (Phase 5 in design doc) — Gmail Pub/Sub, Calendar watches

## Files Created/Modified

### brain-platform
- engine/mailbox.ts (NEW) — inbox + agent_messages + NOTIFY
- engine/brain-state.ts (NEW) — brain.md + business-state.md generation
- adapters/mcp.ts (MODIFIED) — 11 new tools, deprecated triage refs
- server/index.ts (MODIFIED) — schema migrations, brain state listener
- sidecar/poll-scheduler.ts (MODIFIED) — discovery-only, no triage
- engine/config.ts (MODIFIED) — removed entityRouting
- engine/brain-config.ts (MODIFIED) — removed refreshEntityList
- config/default.json (MODIFIED) — removed entityRouting, triage disabled
- connectors/types.ts (MODIFIED) — added contentIds to CollectorResult
- tests/mailbox.test.ts (NEW) — 11 tests
- tests/brain-state.test.ts (NEW) — 8 tests
- engine/entity-router.ts (DELETED)
- engine/triage.ts (DELETED)
- tests/entity-router.test.ts (DELETED)
- tests/triage.test.ts (DELETED)

### clawvato
- src/cc-native/agent-supervisor.ts (NEW) — message routing
- scripts/curator-loop.sh (NEW) — always-on curator
- config/prompts/curator-system.md (NEW) — curator instructions
- config/prompts/entity-agent-system.md (NEW) — entity agent template
- scripts/cc-native-entrypoint.sh (MODIFIED) — starts curator + supervisor
- docs/DESIGN_AGENT_ARCHITECTURE_V2.md (NEW) — full design document
