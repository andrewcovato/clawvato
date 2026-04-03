# Session Handoff

> Last updated: 2026-04-02 | Session 31 | Scanner Stabilization → v4 Design

## Quick Resume

```
Phase: 3 → proposing v4
Branch: cc-native-engine
Build: DEPLOYED (brain-platform + clawvato on Railway)
State: v3 scanner running but fundamentally limited.
       v4 Master Crawl design proposed, pending owner review.

Canvas: F0AQKUH7U1L (https://growthbyscience.slack.com/docs/T05CQ396M8V/F0AQKUH7U1L)
  - Last updated Apr 2 with full manual crawl
  - Action brief format with admin-voice workstream blocks

Design doc: docs/DESIGN_V4_MASTER_CRAWL.md (927 lines)
```

## Session 31 — What Happened

### First Half: Scanner Stabilization
Fixed ~12 bugs in the v3 scanner that were burning through Max plan session limits:
- Persisted scan times in DB (no more 7-day re-read on restart)
- Epoch-second Gmail filtering (no more re-scanning same-day threads)
- Sequential scan loops (no more overlapping cycles)
- Separate MCP URLs for CoS vs scanner
- Token monitoring → #clawvato-monitoring
- Fireflies scanning implemented
- Two-phase catchall (metadata triage → deep read)
- Post-brief Haiku reconciliation
- Auto-apply alterations
- Living Slack canvas for todo list

### Second Half: v4 Design
Despite all fixes, fundamental problems remained:
- Todo list accuracy was ~70% — stale items, missing items, duplicates
- Domain-based content check missed contacts outside tracked domains
- Incremental updates compounded errors over time
- Too many moving parts (6+ separate processes, each with failure modes)

Arrived at v4 proposal through ~10 design iterations:
- Single Opus master crawl 2x/day replaces all scanner components
- Reads ALL email (no domain filter), Opus routes by understanding
- Action brief in admin voice replaces discrete todo list
- Workstreams defined by people + purpose, not domains
- Lightweight urgency check between crawls (zero LLM tokens)

### Key Decisions
1. Kill domain-based content filtering — Opus reads everything
2. Kill incremental updates — full rewrite every crawl
3. Kill proposal/approval flow — auto-apply (AI takes the wheel)
4. Action brief format: human-readable prose + agent-parseable actions
5. Workstreams = people + purpose + context, NOT domains
6. Canvas as the primary human-facing view
7. Brain-platform stores output of intelligence, not raw facts

### Files Created/Modified
- docs/DESIGN_V4_MASTER_CRAWL.md (NEW — full design doc)
- src/cc-native/v3-scanner.ts (MODIFIED — many fixes, will be replaced by v4)
- src/cc-native/slack-channel.ts (MODIFIED — added slack_update tool)
- scripts/cc-native-entrypoint.sh (MODIFIED — scanner auto-restart, separate MCP URLs)
- config/prompts/cc-native-system.md (MODIFIED — progress update instructions)
- ~/.claude.json (MODIFIED — global brain-platform MCP config)
- ~/.claude/.mcp.json (MODIFIED — updated to v3 server)

### brain-platform changes (separate repo, deployed)
- engine/v3-cron.ts — exported getLastRun/updateLastRun, optional timestamp
- engine/v3-context.ts — include todo UUIDs in context output
- adapters/v3-mcp.ts — added get_last_scan, set_last_scan, update_alteration_slack, get_alteration_by_slack_ts

## Next Steps

1. **Owner reviews docs/DESIGN_V4_MASTER_CRAWL.md** — confirm direction before building
2. **Build masterCrawl()** — single function, reads all sources, produces all outputs
3. **Build urgencyCheck()** — lightweight, no LLM
4. **Test with live crawl** — already prototyped manually this session (worked well)
5. **Delete v3 scanner code** — checkForNewContent, scanWorkstream, reconcileTodos, scanCatchall
6. **Update CLAUDE.md** — architecture has fundamentally changed (again)

## Open Questions
- Should the master crawl also update entity back-of-books, or just briefs?
- How to handle the "activity log" concept for cross-session context?
- Should workstream_domains table be dropped entirely or kept as optional metadata?
- Exact prompt structure for the master crawl output format
