# Session Handoff

> Last updated: 2026-03-23 | Session 23 | Sprint S9→S10

## Quick Resume

```
Sprint: S10 — Memory Durability (Phase 2: Build the Brain)
Status: PHASE 2 SCOPED — design doc written, roadmap restructured
Branch: cc-native-engine (GitHub auto-deploy to Railway)
Engine: ENGINE=cc-native
Database: Railway managed Postgres — 125+ memories, 693 entity tags
Task Channel: #clawvato-tasks (C0AN5J0LCP3)
Build: Clean (tsc --noEmit passes)
Deploy: Live on Railway via GitHub auto-deploy
Memory Plugin: clawvato-memory-production.up.railway.app/mcp (auth: Bearer token)
Design Doc: docs/DESIGN_PHASE2_PROACTIVE_INTELLIGENCE.md
NEXT: Start S10 — memory scoping, LLM reranking, merge to main
```

## What Happened This Session (Session 23)

### Dead Code Cleanup
Removed the in-tree MCP memory server (replaced by HTTP plugin in Session 21):
- Deleted: `src/mcp/memory/server.ts`, `src/mcp/memory/stdio.ts`, `.cc-native-mcp.json`
- Updated: `deep-path.ts` (HTTP plugin instead of stdio), `Dockerfile` (removed dead COPY), `policy-engine.ts` (added `clawvato-memory` tool pattern), `CLAUDE.md` (removed in-tree references)
- Build clean, zero dangling references.

### Phase 2 Strategic Scoping
Major architectural discussion. Key decisions:

1. **Double down on CC-native** — don't abstract for model-agnosticism. The plugin is already model-agnostic (HTTP MCP). The agent layer should stay CC-native because that's where all the leverage is.

2. **Plugin as kernel** — the memory plugin evolves from just a memory store to the kernel of the business OS: facts, tasks, scheduler tools, ingest endpoints, working context.

3. **Own the scheduler** — CC's built-in scheduling (/loop, CronCreate) is session-scoped and dies on restart. Cloud tasks have 1h minimum. The always-on sidecar is the right tool. Rebuild it properly against the HTTP plugin (no direct DB access).

4. **Sidecar pattern** — sidecar polls plugin for due tasks, posts to Slack when things are due. CC picks up from Slack naturally and executes. Sidecar also receives webhooks (Gmail, Calendar) and forwards to plugin for extraction.

5. **Tasks are data, not code** — new task types, cadences, and workflows shouldn't require a deploy. Owner creates them via natural language in Slack.

### Files Modified
- `src/mcp/memory/server.ts` — DELETED
- `src/mcp/memory/stdio.ts` — DELETED
- `.cc-native-mcp.json` — DELETED
- `src/agent/deep-path.ts` — HTTP plugin instead of stdio, tool names updated
- `Dockerfile` — removed dead COPY
- `src/training-wheels/policy-engine.ts` — added clawvato-memory pattern
- `CLAUDE.md` — removed in-tree refs, added Phase 2 architecture, updated build tracks
- `.project/state.json` — restructured with phases, new sprint plan S10-S13
- `docs/DESIGN_PHASE2_PROACTIVE_INTELLIGENCE.md` — NEW, full Phase 2 design doc

## Sprint Plan

### S10: Memory Durability (CURRENT — Phase 2)
- Memory scoping — per-project/surface domain filters (BLOCKING)
- LLM reranking — Haiku reranker in plugin
- Merge cc-native-engine → main

### S11: Scheduler Rebuild (Phase 3)
- S11a: Plugin scheduler tools (get_due_tasks, mark_running/completed/failed)
- S11b: Sidecar rebuild against HTTP plugin, no direct DB
- S11c: End-to-end validation with ad-hoc task

### S12: Real-Time Ingest (Phase 3)
- Gmail webhook (Google Pub/Sub → sidecar → plugin)
- Calendar push notifications
- Sweep consolidation (sweeps become a recurring task)

### S13: Autonomous Workflows (Phase 4)
- Ad-hoc workflows as tasks (CRM, project tracking, briefings)
- System surfaces things owner didn't ask about

## Architecture

```
Plugin service (always-on, Railway):
  Memory store      → facts, entities, search, retrieval
  Task store        → definitions, due dates, recurrence, status
  Scheduler tools   → get_due_tasks, mark_running/completed/failed
  Ingest endpoints  → Gmail/Calendar webhooks → extraction → storage
  Working context   → handoffs, briefs, scratchpad

Scheduler sidecar (always-on, lightweight):
  Polls plugin for due tasks → posts to Slack
  Receives webhooks (Gmail, Calendar) → forwards to plugin
  No reasoning, no DB access, no LLM calls

CC session (on-demand, wakes from Slack):
  Executes tasks → reasoning, tool use, multi-step workflows
  Responds to user → Slack conversations
  Writes to plugin → store facts, update tasks, update context
```

## Recent Interactions (verbatim)

**User**: yo...guess it didn't work again

**Assistant**: It actually did work this time! I have full context from Session 22. [proved it by citing specific details]

**User**: niiiiiiiiice!

**User**: dead code cleanup and then let's do a full backlog assessment and a gut check on the next phases of this project.

**Assistant**: [completed dead code cleanup, then full backlog assessment]

**User**: you're bang on on all of this. The memory system needs to be incredible. I would argue that what we're building now has evolved to a robust memory system for claude code. Where I see this is two directions: 1) double down on that, or 2) make it flexible enough to be model agnostic.

**Assistant**: Go with #1 — double down on CC. Plugin is already model-agnostic (HTTP MCP). Agent layer should stay CC-native.

**User**: this all resonates except that my worry isn't CC CLI breaks, it's that we've built kind of a hacky way to interact with it as the core engine.

**Assistant**: The hack is contained — PTY/expect/supervisor are isolated in a few files. Everything else is clean. When Anthropic ships a proper API, the swap is surgical.

**User**: CC now has loops and scheduled tasks. Is it worth using them for the always-on componentry?

**Assistant**: [researched CC scheduling] Session-scoped (/loop) dies on restart. Cloud tasks have 1h minimum. Own the scheduler.

**User**: This feels weird. Feels like there will be some weird offsets because the session will die at random times.

**Assistant**: You're right. Plugin service is already always-on — put the scheduler there. [proposed plugin-posts-to-Slack model]

**User**: weird UX. and we have to wire the plugin to now message slack?

**Assistant**: You're right on both. [reconsidered: keep sidecar, don't cross plugin/Slack boundary]

**User**: the session will die. We have the auto-clearing process. TL/DR: i think we need to keep our own async scheduler.

**Assistant**: You're right. The sidecar is actually the right tool. Rebuilt scope around proper sidecar.

**User**: yes feels good--but i want to be clear: the tasks outlined (daily briefing etc) are EXAMPLES. we need to be able to build those ad hoc.

**Assistant**: Exactly — the scheduler is infrastructure, not features. Task types are data, not code.

**User**: Yes--pls write it up.
