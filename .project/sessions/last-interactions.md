# Last Interactions — Session 25

### Journal Hook + Insights Pipeline
**User**: do we need to update the clawvato memory version right here, or because we're developing here it's the pure, sweet, sweet OG source?
**Assistant**: Local .mcp.json points directly at source code via npx tsx. You're on the OG source — no version update needed.

**User**: the journal will pick up the "insights" right? can we test if it's doing that?
**Assistant**: No — journal hook only captures tool calls (PostToolUse), not conversational text. Insights written as text are invisible to the pipeline. Built insights scratch pad: echo to /tmp/clawvato-insights.md, hook merges on flush.

**User**: we explicitly said in the claude.md update that "whenever you create an insight, write it to memory" — did that not show up anywhere?
**Assistant**: Found it in cc-native-system.md (cloud prompt) but not in local CLAUDE.md. Fixed: added scratch pad instruction to CLAUDE.md.

### Quality Tuning
**User**: are we being TOO verbose with what to store? i dunno the quality of the memories we're making
**Assistant**: Audited: ~75% of journal-extracted memories were noise (file paths, tool descriptions). Fixed: upgraded Haiku→Sonnet for extraction, rewrote prompt with explicit DO NOT EXTRACT list, bumped interval 20→50.

### Plugin Propagation
**User**: we need to address the update process NOW. I do NOT want straggler versions.
**Assistant**: Built `sync` command. SessionStart hook runs `npx @andrewcovato/clawvato-memory@latest sync`. Auto-copies scripts, updates version. Wrote comprehensive README.

### Scheduler Rebuild
**User**: I want to build the scheduler. The design we agreed on was to have the scheduler be SEPARATE from the memory plugin.
**Assistant**: Confirmed via memory search — two schedulers by design. Agent scheduler stays agent-side. Corrected a misleading memory that said "polls the memory plugin."

**User**: I want a super clean, slack-friendly output. Scrap the pin stuff. Task channel = RSS feed.
**Assistant**: Deleted channel-manager.ts + approval.ts (-685 lines). Rebuilt tools as DB-only. Event feed for notifications. Approval via natural language.

**User**: the "sweep" should possibly be a more back-end task
**Assistant**: Agreed. Sweeps moved from scheduled_tasks to sidecar's own timer. Three categories: brain maintenance (plugin), data collection (sidecar), user tasks (CC).

**User**: we had discussed different cadences in the context of webhooks
**Assistant**: Found in design doc: replace polling with real-time (Gmail Pub/Sub, Calendar push). Sweeps become backfill. Agreed on: Slack+FF hourly, Drive 6h, Gmail/Calendar via webhooks (S26).

### Pub/Sub Spec
**User**: one final thing to make this whole system start to pay off in spades: the pub/sub. can you spec this out?
**Assistant**: Generated comprehensive visual spec (HTML with Mermaid diagrams) + design doc. Gmail via Pub/Sub, Calendar via events.watch(), sidecar gets HTTP server, deploys as separate Railway service.
