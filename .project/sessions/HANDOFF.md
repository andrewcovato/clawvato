# Session Handoff

> Last updated: 2026-04-03 | Session 32 | v4 Master Crawl — Build + Deploy

## Quick Resume

```
Phase: v4 Master Crawl — implementation
Branch: cc-native-engine
Build: Code complete, deployed, CRAWL NOT YET WORKING
State: Brain-platform deployed with tracked items (tested, working).
       Clawvato deployed but crawl agent has never completed successfully.
       Three crawl starts, zero completions. Likely MCP_CONFIG issue (fixed)
       but untested since fix deployed.

Canvas: F0AQKUH7U1L
Design doc: docs/DESIGN_V4_MASTER_CRAWL.md (comprehensive)
Crawl prompt: config/prompts/master-crawl.md (blind-reviewed)

IMMEDIATE: Set up separate Railway service for crawl sidecar.
           Owner explicitly requested cloud testing, not local.
```

## Session 32 — What Happened

### Design Refinements
1. Three-layer data model (entity BoB / workstream BoB / brief) with separation enforcement
2. Agent architecture: CoS (always-on, writes nothing proactively) vs Crawl Agent (ephemeral, autonomous writer)
3. Tracked items: structured anchors with semantic keys replacing granular todos
4. Brief continuity: delta-first format driven by tracked item status changes
5. Artifacts: multi-type reference materials (email, meeting, doc, Slack, Drive)
6. Crawl notes: Memento-style durable attention between ephemeral runs
7. Entity/workstream creation permissions: crawl can create entities, recommends workstreams via monitoring channel

### Code Built

#### brain-platform (deployed, tested, working)
- `engine/v3-schema.ts` — tracked_items table
- `engine/v3-types.ts` — TrackedItem types
- `engine/v3-tracked-items.ts` — CRUD module (upsert, list, complete, cancel)
- `engine/v3-context.ts` — tracked items in get_workstream_context
- `adapters/v3-mcp.ts` — 5 MCP tools + router cases
- Integration tested against Railway DB: all 7 tests pass

#### clawvato (deployed, crawl NOT working yet)
- `config/prompts/master-crawl.md` — full system prompt (blind-reviewed, tuned)
- `src/cc-native/master-crawl.ts` — ephemeral Opus launcher (file-based prompt, --mcp-config, stderr logging)
- `src/cc-native/urgency-check.ts` — disabled (gws GLIBC mismatch from Node sidecar)
- `src/cc-native/task-scheduler-standalone.ts` — sidecar with crawl cron + urgency + RUN_CRAWL_NOW trigger
- `config/default.json` + `src/config.ts` — crawl + urgencyCheck config
- `scripts/cc-native-entrypoint.sh` — MCP_CONFIG exported, sidecar replaces scanner

### Data Cleanup
- 11 entity contexts cleaned (10 contaminated + 1 missing Acorns)
- All entities now pure Layer 1 company profiles

### Bugs Found and Fixed
1. Missing `--mcp-config` on claude --print (critical)
2. UTC timezone in cron (used Intl.DateTimeFormat for Eastern)
3. Double-fire on restart (persist lastCrawlHour to disk)
4. Upsert parameter ambiguity (resolve in JS before SQL)
5. Summary empty string on insert (use placeholder)
6. MCP_CONFIG not exported in entrypoint (local bash var, not env var)
7. gws GLIBC mismatch in urgency check (disabled for now)

### What DIDN'T Work
- Three crawl attempts on Railway, all started but none completed
- Logs unreadable (CoS TUI ANSI codes overwhelm sidecar stderr)
- Can't tell where the crawl hangs — zero output between "starting" and timeout/silence
- Owner correctly flagged: need separate Railway service for isolated logs

### Key Decisions
1. Crawl agent must be ephemeral (Memento argument)
2. Three-layer data model with mechanical enforcement
3. Tracked items replace todos (semantic keys, brief rendered from status changes)
4. Separate Railway service for crawl sidecar (owner decision, not yet built)
5. Owner feedback: "Don't jump to fixes. Find all failure modes first, present solutions."
6. Owner feedback: "gws CLI DOES work on Railway" — issue is Node calling system gws vs Claude's gws

## Next Steps

1. **Set up separate Railway service** for the crawl sidecar (owner explicitly requested this)
   - Needs: its own container, own logs, same Railway project
   - Runs: task-scheduler-standalone.ts (task poller + crawl cron + urgency check)
   - Connects to: same Postgres, same brain-platform MCP, same Slack
   - Does NOT run: CoS (that stays in the main service)

2. **Debug the crawl** with isolated logs — figure out WHERE it hangs:
   - Does `claude --print` start? (check for process spawn)
   - Does MCP connect? (check for brain-platform tool calls)
   - Does the prompt load? (check for file read)
   - Does the LLM start generating? (check for any output)

3. **Fix urgency check gws** — find the correct gws binary path on Railway (it works inside claude subprocess but not from Node directly)

4. **Remove RUN_CRAWL_NOW=1** after testing (currently set to 0, should be removed entirely once crawl works)

5. **Test end-to-end**: crawl completes, briefs updated, tracked items created, canvas refreshed, crawl notes written

## Open Questions
- Is the prompt too large for `claude --print` to handle? (unlikely — v3 scanner passed larger prompts)
- Is there a Railway resource limit being hit? (memory, CPU)
- Does `claude --print` need different MCP config than the CoS? (HTTP transport may behave differently for --print)
- Should the crawl service use `railway run` for manual triggers instead of RUN_CRAWL_NOW env var?

## Railway Env Vars Set This Session
- `CANVAS_ID=F0AQKUH7U1L`
- `MONITORING_CHANNEL_ID=C0APG26FLRJ`
- `RUN_CRAWL_NOW=0` (was 1, set back to 0)
