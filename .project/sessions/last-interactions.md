# Last Interactions — Session 25

### Journal Hook + Insights Pipeline
**User**: do we need to update the clawvato memory version right here, or because we're developing here it's the pure, sweet, sweet OG source?
**Assistant**: Local .mcp.json points directly at source code. You're on the OG source — no version update needed.
**Decision**: Local dev uses source, published package is for other projects.

### Insights Capture Gap
**User**: the journal will pick up the "insights" right? can we test if it's doing that?
**Assistant**: No — journal hook only captures PostToolUse events, not conversational text. Built insights scratch pad (/tmp/clawvato-insights.md), journal hook merges on flush.
**Decision**: Insights → scratch pad → journal flush. NOT store_fact for routine insights.

### Extraction Quality
**User**: are we being TOO verbose with what to store? i dunno the quality of the memories we're making
**Assistant**: Audited: ~75% noise. Upgraded Haiku→Sonnet for /ingest extraction, rewrote prompt with explicit DO NOT EXTRACT list, interval 20→50.
**Decision**: Sonnet > Haiku for extraction. Quality over volume.

### Plugin Propagation
**User**: we need to address the update process NOW. I do NOT want straggler versions.
**Assistant**: Built `sync` command. SessionStart runs `npx @andrewcovato/clawvato-memory@latest sync`. Wrote comprehensive README.
**Decision**: sync replaces check-version.sh. Always bump version on push.

### Sidecar Rebuild
**User**: I want a super clean, slack-friendly output. Scrap the pin stuff. Task channel = RSS feed. Sweep should be a back-end task.
**Assistant**: Deleted channel-manager.ts + approval.ts (-685 lines). Rebuilt sidecar: tiered sweeps (Slack+FF 1h, Drive 6h, backfill 24h) in-process + event feed + simplified task tools.
**Decision**: Three categories of work: brain maintenance (plugin), data collection (sidecar), user tasks (CC).

### Pub/Sub Webhook Spec
**User**: one final thing: the pub/sub. can you spec this out?
**Assistant**: Visual spec (HTML) + design doc. Gmail via Pub/Sub, Calendar via events.watch(), sidecar as separate Railway service.

### Brain Platform Architecture
**User**: what if we merge fireflies and slack into this as well. The email system can do de-duped to-do, CRM, rich email with context from slack and meetings.
**Assistant**: Evolved through: two brains → single brain with domains → multi-brain hierarchy. Brain stores intelligence + source pointers, NOT content. Applications (newmail, kanban, CRM) are view layers on top.
**User**: I want to plan this out right: concept of a "brain" with general scope and data inputs.
**Assistant**: Wrote comprehensive DESIGN_BRAIN_PLATFORM.md (776 lines). Brain = identity + inputs + processing + outputs + connections. Four input patterns (webhook, poll, feed, passive). brain.yaml config. Multi-brain hierarchy with feeds up, drill-down down.
**Decision**: Brain platform architecture. Source APIs store content, brain stores intelligence. Newmail = brain clusters + Gmail API content. Decay triggers source cleanup.
