# Phase 2: Proactive Intelligence

> Status: Scoped | Author: Andrew + Claude | Date: 2026-03-23 | Session: 23

## Vision

Transform Clawvato from a reactive agent (responds when asked) into a proactive business OS (acts on its own). The memory plugin becomes the kernel — storing facts, tasks, and schedules. A thin scheduler sidecar fires tasks on time. CC executes them with full reasoning and tool access.

**Key principle:** The scheduler is infrastructure, not features. Task types, cadences, and workflows are all data — not code. New capabilities shouldn't require a deploy.

## Strategic Decisions

### Double Down on CC-Native

The CC-native engine is the product. The dependency on Claude Code CLI is a feature, not a risk:

- CC gives us tool orchestration, reasoning, context management, and MCP for free ($0 on Max plan)
- The hybrid engine on `main` (~2,250 lines of custom orchestration) is replaced by zero code
- Anthropic is shipping toward more CC capability (Channels, hooks, Agent SDK), not less
- The memory plugin is already model-agnostic (HTTP MCP) — that's the insurance policy

**The hack is contained.** The PTY/expect supervisor, trust prompt automation, and stream-json parsing are isolated in a few files (`cc-native-entrypoint.sh`, `slack-channel.ts`, `start.ts`). Everything else — memory, tools, prompts, sweeps, tasks — is clean and doesn't care how the agent runs. When Anthropic ships a proper programmatic API, the swap is surgical.

### Plugin as Kernel, CC as Executor

```
Plugin service (always-on, Railway):
  Memory store      → facts, entities, search, retrieval
  Task store        → definitions, due dates, recurrence, status
  Scheduler tools   → get_due_tasks, mark_running/completed/failed
  Ingest endpoints  → Gmail/Calendar webhooks → extraction → storage
  Working context   → handoffs, briefs, scratchpad

Scheduler sidecar (always-on, lightweight):
  Polls plugin for due tasks
  Posts to Slack when things are due
  Receives webhooks (Gmail, Calendar)
  Forwards to plugin for extraction + storage
  No reasoning, no DB access, no Opus

CC session (on-demand, wakes from Slack):
  Executes tasks   → reasoning, tool use, multi-step workflows
  Responds to user → Slack conversations
  Writes to plugin → store facts, update tasks, update context
```

**Plugin is the kernel. CC is the process that runs on it. Slack is the IPC.**

### Own the Scheduler

CC's built-in scheduling primitives don't work for this use case:

| Mechanism | Problem |
|-----------|---------|
| `/loop` | Session-scoped — dies on restart, 3-day expiry |
| Cloud tasks | 1-hour minimum interval |
| Desktop tasks | Requires Desktop app running |
| CronCreate | Session-scoped — same as `/loop` |

The CC session dies periodically (context pressure → handoff → restart). Session-scoped scheduling creates missed windows and random offsets. A separate always-on process is the right tool — same pattern as Celery Beat, Kubernetes CronJobs, Sidekiq scheduler.

### Why Not Put the Scheduler in the Plugin?

The plugin shouldn't have Slack credentials. It's a memory service — it stores and retrieves. The sidecar is the boundary between "what's due" (plugin knows) and "notify the user" (requires Slack access). This keeps the plugin clean and reusable.

## Architecture

### Scheduler Sidecar

```
┌─────────────────────────────────────────────┐
│ Scheduler Sidecar (Node, always-on)         │
│                                             │
│  ┌──────────────┐    ┌──────────────────┐   │
│  │ Task Poller   │    │ Webhook Server   │   │
│  │ (setInterval) │    │ (Express/Hono)   │   │
│  │               │    │                  │   │
│  │ Every 60s:    │    │ POST /webhook/   │   │
│  │ GET plugin:   │    │   gmail          │   │
│  │ get_due_tasks │    │   calendar       │   │
│  │               │    │                  │   │
│  │ If due:       │    │ On receipt:      │   │
│  │ POST Slack    │    │ GET full message │   │
│  │ mark_running  │    │ POST plugin:     │   │
│  │               │    │   store_fact     │   │
│  └──────┬───────┘    └────────┬─────────┘   │
│         │                     │              │
└─────────┼─────────────────────┼──────────────┘
          │                     │
          ▼                     ▼
    ┌───────────┐        ┌───────────┐
    │  Slack    │        │  Plugin   │
    │  Web API  │        │  HTTP MCP │
    └───────────┘        └───────────┘
          │
          ▼
    ┌───────────┐
    │  CC       │
    │  Session  │ ← picks up task from Slack
    │           │ → executes, calls mark_completed
    └───────────┘
```

### Task Execution Lifecycle

```
1. Owner or agent creates task
   → CC calls plugin: create_task(title, cron, description)
   → Plugin stores in scheduled_tasks table

2. Task comes due
   → Sidecar polls plugin: get_due_tasks()
   → Sidecar calls plugin: mark_task_running(id)
   → Sidecar posts to Slack: formatted task message

3. CC picks up from Slack
   → CC reads task, executes with full tool access
   → CC calls plugin: mark_task_completed(id, result)
   → Or if failed: mark_task_failed(id, error)

4. Recurring tasks
   → mark_task_completed auto-reschedules (computes next_run_at from cron)
   → Task becomes active again with new next_run_at

5. Stale detection
   → Sidecar checks: tasks 'running' for >30m → mark_task_failed("execution timeout")
```

### Webhook Ingest Flow

```
Gmail push notification (Google Pub/Sub)
  → POST sidecar: /webhooks/gmail
  → Sidecar fetches full message via Gmail API (gws CLI or direct API)
  → Sidecar calls plugin: store_fact(content, entities, source: "gmail")
  → Memory is immediately fresh — no 6h sweep delay

Calendar push notification
  → POST sidecar: /webhooks/calendar
  → Sidecar fetches event details
  → Sidecar calls plugin: store_fact(content, entities, source: "calendar")
```

### What the Sidecar Does NOT Do

- **No reasoning** — it doesn't interpret tasks, synthesize, or make decisions
- **No direct DB access** — all state goes through the plugin HTTP API
- **No Opus/Sonnet/Haiku calls** — extraction on ingest uses the plugin (which may call Haiku internally)
- **No tool orchestration** — CC handles multi-step execution

## Sprint Plan

### S10: Memory Durability (prerequisite)

| Task | Where | Notes |
|------|-------|-------|
| Memory scoping | Plugin | Per-project/surface domain filters on retrieval |
| LLM reranking | Plugin | Haiku reranker between retrieval and presentation |
| Merge to main | Repo | cc-native-engine → main, hybrid preserved as git tag |

### S11: Scheduler Rebuild

**S11a — Plugin scheduler tools**

Add to `clawvato-memory` plugin:

| Tool | Input | Behavior |
|------|-------|----------|
| `get_due_tasks` | `(limit?)` | Returns tasks where `next_run_at <= NOW()` AND status = 'active' |
| `mark_task_running` | `(id)` | Atomic status → 'running', sets `last_run_at = NOW()` |
| `mark_task_completed` | `(id, result?)` | Status → 'completed', stores result, reschedules if recurring |
| `mark_task_failed` | `(id, error)` | Status → 'failed', stores error |

These wrap existing `store.ts` functions. Thin layer, mostly plumbing.

**S11b — Sidecar rebuild**

Replace broken `task-scheduler-standalone.ts`:

- Lightweight HTTP server (webhook endpoints) + polling loop
- Talks to plugin via HTTP MCP (same URL/auth as CC)
- Talks to Slack via Web API (post messages only)
- Deployed alongside CC on Railway (same service, child process via supervisor)
- Stale task detection: running >30m → mark failed
- Approval reminders: pending_approval >1h → thread reply on pinned message

**S11c — Validation**

Create an ad-hoc task via Slack ("remind me to X on Friday"), verify end-to-end:
- Task created in plugin
- Sidecar fires it at the right time
- CC executes and marks complete
- Recurring tasks reschedule correctly

### S12: Real-Time Ingest

**S12a — Gmail webhook**

| Component | Where | Notes |
|-----------|-------|-------|
| Google Pub/Sub topic + subscription | GCP | Points to sidecar's public URL |
| `POST /webhooks/gmail` endpoint | Sidecar | Receives push, fetches message, calls plugin |
| History ID tracking | Plugin (agent_state) | Prevents reprocessing |
| Extraction | Plugin or inline Haiku | Structured fact extraction from email content |

**S12b — Calendar push notifications**

Same pattern as Gmail. Google Calendar push API → sidecar → plugin.

**S12c — Sweep consolidation**

Sweeps become a recurring task:
- Task in DB: `cron: "0 */6 * * *"`, title: "Run background sweep"
- Sidecar fires it → CC executes sweep with existing tool access
- Removes need for sweep-specific scheduling code

### S13: Autonomous Workflows

These are **tasks in the database**, not code. Each is a recurring task with a prompt that CC executes:

| Workflow | Cadence | What CC Does |
|----------|---------|-------------|
| Meeting CRM | After Fireflies sync | Extract contacts, action items, follow-ups from new meetings |
| Project tracking | Daily | Cross-reference project mentions across email/Slack/meetings |
| Stale follow-up detection | Daily | Surface unanswered emails, overdue action items |
| Weekly digest | Weekly | Synthesize the week's activity, key decisions, open threads |

**These are examples, not the deliverable.** The deliverable is a system where any of these can be created ad-hoc via natural language in Slack.

## Dependency Chain

```
S10 (Memory durability)
  │
  ├── S11a (Plugin scheduler tools) ← can start in parallel
  │     ↓
  │   S11b (Sidecar rebuild)
  │     ↓
  │   S11c (Validation)
  │
  ↓
S12 (Real-time ingest) ← depends on S10 for retrieval quality
  │
  ↓
S13 (Autonomous workflows) ← depends on S12 for fresh data
```

## Deferred

| Item | Reason |
|------|--------|
| Track G (self-development) | Cool but not load-bearing. Wait until core is stable. |
| Session topology | Only matters at high Slack volume (~50+ msgs/day, 5+ topics) |
| Better embeddings | Scaling concern. Matters at 10K+ memories. |
| Hierarchical summarization | Scaling concern. Matters at 50K+ memories. |
| Finance integration | New domain. Not core. |
| Obsidian export | Nice-to-have. |
| Artifact cache | Not load-bearing. |
| SKILL.md as MCP resource | Polish. |

## Risk Register

| Risk | Mitigation |
|------|-----------|
| CC session dies mid-task-execution | Stale detection: running >30m → mark failed, sidecar re-fires on next poll |
| Gmail webhook volume overwhelms plugin | Rate limit ingest endpoint, batch extractions |
| Sidecar crashes | Supervisor manages sidecar lifecycle (same as CC restart loop) |
| Plugin downtime blocks scheduling | Sidecar retries with backoff, stores pending notifications in-memory |
| Task creates infinite loop (task creates task creates task) | Max depth limit on spawned_by_task chain |
| Extraction quality degrades at scale | Memory scoping (S10) + reranking (S10) are prerequisites for this reason |

## Success Criteria

Phase 2 is done when:
1. An owner can say "remind me to follow up with X on Friday" and it happens
2. An owner can say "give me a briefing every morning" and it happens
3. New emails appear in memory within minutes, not hours
4. The system surfaces things the owner didn't ask about but should know
5. None of the above required a code deploy to set up
