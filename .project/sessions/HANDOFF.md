# Session Handoff

> Last updated: 2026-03-24 | Session 25 | Phase 3 In Progress

## Quick Resume

```
Phase: 3 IN PROGRESS — Build the Nervous System
Branch: cc-native-engine
Build: Clean (both repos)
Plugin: @andrewcovato/clawvato-memory v0.6.2 on GitHub Packages + Railway
  - Sonnet extraction (upgraded from Haiku), tighter prompt
  - sync command: auto-updates scripts on SessionStart
Sidecar: Rebuilt — tiered sweeps + task poller + event feed
  - Slack+FF hourly, Drive 6h, full backfill daily
  - 228 active memories, 20 new from first sweep run
  - Deleted pins/approval/reconciliation (-685 lines)
NEXT: S26 — Pub/Sub webhooks (Gmail + Calendar real-time ingest)
VISION: Brain Platform — multi-brain hierarchy, brain-powered apps (docs/DESIGN_BRAIN_PLATFORM.md)
```

## Session 25 — What Was Built

### Observability Pipeline
- Wired PostToolUse journal hook in project settings
- Insights scratch pad (`/tmp/clawvato-insights.md`) — agent writes insights, journal hook merges on flush
- Brief auto-update on flush — scratch pad or auto-generated from tool activity
- Three-tier brief reliability: agent-written > auto-generated > SessionEnd tombstone
- Flush interval 20→50 tool calls (fewer, richer batches)

### Extraction Quality
- Upgraded /ingest extraction from Haiku → Sonnet
- Rewrote extraction prompt: explicit DO NOT EXTRACT list (file paths, tool usage, project structure)
- Before: 6 facts from test input, ~75% noise. After: 2-3 focused facts.
- Cost: ~$0.03/session (negligible for quality improvement)

### Plugin Distribution
- Added `sync` command: fast, non-interactive, copies scripts + updates version
- SessionStart hook runs `npx @andrewcovato/clawvato-memory@latest sync`
- Replaces check-version.sh (actually updates, not just warns)
- Comprehensive README: install, update pipeline, architecture, hooks, tools
- Plugin v0.6.2 published

### Sidecar Rebuild (S25 core)
- Sidecar becomes unified process: task poller + tiered sweeps + event feed
- Tiered sweep intervals: Slack+FF hourly, Drive 6h, full backfill daily
- Collectors run in-process — no CC session needed for sweeps
- Content sent to plugin `/ingest` → Sonnet extracts facts
- sweep:all-sources task cancelled — sweeps owned by sidecar timers

### Task UX Overhaul
- Deleted `channel-manager.ts` (314 lines) and `approval.ts` (48 lines)
- Removed sync_tasks tool, pin reconciliation, Haiku summaries, reaction approval
- Task tools are now DB-only — no Slack side effects
- list_tasks output grouped by status, clean formatting
- Approval via natural language ("approve [task]") not reactions
- Event feed: task/sweep events posted to #clawvato-tasks chronologically
- Net: +311 / -685 lines

### Pub/Sub Webhook Spec
- Full design doc: `docs/DESIGN_PUBSUB_WEBHOOKS.md`
- Visual spec: `~/.agent/diagrams/pubsub-webhook-spec.html`
- Gmail: Google Pub/Sub → sidecar `/webhooks/gmail` → fetch history → /ingest
- Calendar: events.watch() → sidecar `/webhooks/calendar` → sync token → /ingest
- Sidecar deploys as separate Railway service for public URL
- Sweeps remain as daily backfill safety net

### Sweep Verification
- Production sidecar ran all 3 tiers within 30 min of deploy
- 228 total memories (up from 208), 20 new from sweeps
- 227 Slack channels discovered (8 public + 54 private + 165 mpim)
- 20 active channels processed (cadence filter skips inactive)
- High-water marks functioning — no duplicate processing

### Brain Platform Vision (end of session)
- Evolved through discussion: single brain → two brains → multi-brain hierarchy
- Wrote docs/DESIGN_BRAIN_PLATFORM.md (776 lines) — comprehensive architecture
- Brain = configurable intelligence unit (identity, inputs, processing, outputs, connections)
- Four input patterns: webhook, poll, feed, passive — covers every source
- brain.yaml config format for standardized brain setup
- Multi-brain hierarchy: personal (comms) → dev (projects) → GBS (strategy)
- Feeds flow up (filtered), drill-downs flow down (on-demand, ephemeral)
- Brain stores intelligence + source pointers, NOT content. Source APIs store content.
- Applications (newmail, kanban, CRM) are view layers: brain intelligence + source API content
- Decay triggers source cleanup (archive stale emails, clean Slack channels)
- Newmail use case: get_clusters("comms/email") → brain organizes, Gmail API provides content
- Shared entity namespace across all brains enables cross-brain queries
- Scaling: same codebase per brain, different config. Single user → team → org.

### Key Decisions
1. Insights → scratch pad → journal flush (not explicit store_fact calls)
2. Sonnet for extraction, Haiku was too noisy
3. sync command replaces check-version.sh — actually updates
4. Sidecar owns sweeps (not CC via Slack) — reliability proven
5. Pins/approval deleted — event feed + natural language approval
6. Agent scheduler stays agent-side (NOT in plugin) — confirmed as original design
7. Three categories: brain maintenance (plugin), data collection (sidecar), user tasks (CC)
8. Always bump plugin version on push — GitHub Packages won't publish duplicates
9. Brain stores intelligence + pointers, source APIs store content (permanent principle)
10. Multi-brain hierarchy with feeds up, drill-down down, shared entity namespace
11. Newmail = brain clusters + Gmail API content (brain never replaces Gmail as storage)
12. Decay as active curation — triggers source cleanup with graduated trust

## Immediate Next Steps
1. S26 Phase A: Gmail Pub/Sub webhook (GCP setup + sidecar HTTP server)
2. S26 Phase B: Calendar events.watch() webhook
3. Deploy sidecar as separate Railway service
4. S27: Louvain community detection + relationship extraction
5. Merge cc-native-engine → main when S26 stable

## Files Created This Session
- `docs/DESIGN_PUBSUB_WEBHOOKS.md` — tactical Pub/Sub webhook spec
- `docs/DESIGN_BRAIN_PLATFORM.md` — strategic brain platform architecture (776 lines)
- `~/.agent/diagrams/pubsub-webhook-spec.html` — visual Pub/Sub spec
- `scripts/test-sweep.ts` (test utility)

## Files Modified This Session
- `src/cc-native/task-scheduler-standalone.ts` (complete rewrite)
- `src/tasks/tools.ts` (complete rewrite)
- `src/cli/start.ts` (major cleanup)
- `src/slack/socket-mode.ts` (removed reaction/thread handlers)
- `src/tasks/executor.ts` (removed channelManager)
- `src/agent/hybrid.ts` (removed channelManager)
- `src/agent/fast-path.ts` (removed sync_tasks)
- `src/config.ts` (tiered sweep schema)
- `config/default.json` (tiered sweep config)
- `config/prompts/system.md` (removed pin references)
- `scripts/journal-hook.sh` (insights + brief + interval)
- `CLAUDE.md` (comprehensive updates)

## Files Deleted This Session
- `src/tasks/channel-manager.ts` (314 lines — pins)
- `src/tasks/approval.ts` (48 lines — reaction approval)

## Plugin Changes (clawvato-memory repo)
- `server/handlers/ingest.ts` — Haiku → Sonnet, tighter extraction prompt
- `bin/setup.ts` — added sync command, SessionStart hook updated
- `README.md` — comprehensive documentation
- `package.json` — v0.6.2
