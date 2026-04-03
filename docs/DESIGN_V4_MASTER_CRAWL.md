# v4 Design: Master Crawl Architecture

> Status: PROPOSED — Session 31, Apr 2 2026
> Decision: Pending owner review

## Problem Statement

The v3 scanner architecture has fundamental issues:

1. **Keyword/domain-based content detection misses things that require understanding.** Andy Donahur (Meta) emailed 6 times over 3 weeks — never surfaced because no workstream has @meta.com as a tracked domain. The scanner only looks where it's told to look.

2. **Incremental updates compound errors.** Each scan adds/modifies individual todos. Over a week, stale items accumulate, duplicates appear, completed items aren't cleared. The todo list was ~70% accurate after one week.

3. **Too many moving parts.** Commitment scan (Opus), brief update (Opus), reconciliation (Haiku), catchall triage (Haiku) + deep read (Opus), reaction poller — each with their own failure modes. When one breaks (hallucinated UUIDs, missing timestamps, swallowed errors), the whole chain degrades silently.

4. **Intelligence at the wrong layer.** The scanner uses keyword filters and domain lists to decide what to read, then sends Opus to understand what it found. But Opus IS the understanding — it should decide what matters, not keyword filters.

## Proposed Architecture

### Core Principle: Intelligence at Write Time

Opus reads everything broadly. Opus understands what matters. Opus writes synthesized knowledge to the brain. Downstream agents query structured data — no RAG, no embedding search, no keyword retrieval needed.

The brain stores the *output* of intelligence, not raw facts waiting to be made intelligent at query time.

### Agent Architecture: Two Roles, Different Trust Models

The v3 scanner mixed two jobs into the CoS: conversational assistant AND background
intelligence writer. This caused data quality problems — the CoS, in "helpful assistant"
mode, would dump everything it knew into entity contexts, briefs, and workstream state
without separating durable facts from ephemeral status.

v4 separates these into two distinct agent roles:

```
CoS (always-on, Slack Channels)
  - Reactive: responds to owner in Slack
  - Reads: everything (brain, sources, conversation)
  - Writes: NOTHING proactively. Only modifies brain state when owner asks.
  - Why always-on: conversational continuity. Owner corrects it in real-time.

Crawl Agent (ephemeral, spawned by sidecar on schedule)
  - Proactive: runs autonomously 2x/day
  - Reads: all sources + full brain state
  - Writes: briefs (Layer 3) + artifacts. Flags drift in Layers 1-2.
  - Why ephemeral: it's an autonomous writer with no human in the loop.
```

**Why the crawl agent MUST be ephemeral:**

The crawl agent's output becomes the system of record — every CC session, every CoS
response, every future crawl reads from what it writes. If it hallucinates from stale
context instead of reading from the brain, the entire system's truth drifts. And unlike
the CoS, there's no human to say "no, that's wrong, check the brain."

An always-on crawl agent would have two copies of truth: the brain (durable) and its
own context window (volatile). LLMs naturally prefer context over external reads —
the agent would increasingly rely on what it "remembers" rather than what the brain
says. After 20+ crawls, the divergence between its internal state and the brain could
produce subtly wrong briefs. This is the v3 compounding-errors problem repackaged.

An ephemeral agent has only one copy of truth: the brain. It CAN'T hallucinate from
stale context because it has no prior context. Divergence is impossible by construction.
This is a mechanical guarantee, not prompt compliance.

(This is literally the plot of Memento — the agent wakes up with no memory, reads the
notes it left itself, does its job, writes new notes, goes back to sleep. And it works
precisely because it can't trust its own memory.)

**Short-term context via `crawl_notes`:**

The one thing an ephemeral agent loses is attention continuity between crawls — "I noticed
this last time, watch for it next time." This is solved mechanically: at the end of each
crawl, the agent writes a `crawl_notes` field to the brain:

```
crawl_notes (persisted in brain, read as input by next crawl):
  watch_for:
    - "Danica BPR committee result — expected Thu Apr 3"
    - "Andy Donahur (Meta) — 6 emails, unplaced, investigate"
    - "Data Sciences INV-5834 overdue since Mar 15 — escalating"
  patterns:
    - "Supermetrics MSA has been pending for 18 days with no movement"
    - "Roblox contracting moving faster than expected"
  open_questions:
    - "Should the Talgat Mussin / incrementality.net meeting create a new workstream?"
```

This gives the next crawl directed attention without volatile context. Durable notes,
not fragile memory.

**Write permissions:**

| | CoS (Slack) | Crawl Agent (scheduled) |
|---|---|---|
| Reads | Everything | Everything |
| Writes briefs | No (unless owner asks) | Yes — full rewrite every crawl |
| Writes workstream context | Only when owner asks | No — flags drift |
| Writes entity context | Only when owner asks | No — flags drift |
| Creates entities | Only when owner asks | Yes — new orgs discovered in sources |
| Creates workstreams | Only when owner asks | No — recommends via #clawvato-monitoring |
| Stores artifacts | Only when owner asks | Yes — refs backing action items |
| Manages tracked items | Only when owner asks | Yes — upsert, complete, cancel |
| Writes crawl_notes | No | Yes — attention for next crawl |

### Master Crawl (2x daily — 8 AM, 6 PM)

One ephemeral Opus agent (`claude --print`), spawned by the sidecar on a cron.
The sidecar is just an alarm clock — the agent does everything itself.

```
Execution:
  1. Sidecar cron fires
  2. Spawn: claude --print --allowedTools "Bash,mcp__brain-platform__*,mcp__fireflies__*"
     with system prompt + brain state + previous crawl_notes
  3. Agent reads sources itself:
     - gws gmail (CLI via Bash) — full 7-day window, no domain filter
     - Slack API — recent channel history
     - Fireflies MCP — transcripts from last 7 days
  4. Agent thinks and writes:
     - Calls brain-platform MCP tools to update briefs, store artifacts
     - Writes crawl_notes for next crawl
  5. Agent exits

Tunable: crawl.lookbackDays (default: 7, reduce if token-heavy)
```

The agent reads everything, understands everything, writes structured output to the
brain, and dies. No pre-fetching, no intermediate storage, no sidecar orchestration.
Same tools the CoS uses — gws CLI, brain-platform MCP, Fireflies MCP.

```
Input (agent reads directly from sources):
  - ALL email from lookback window (no domain filter — everything not spam)
  - Slack channels (recent history)
  - Fireflies transcripts (lookback window)
  - Current brain state: all workstreams, people, entities, briefs, open items
  - Previous crawl_notes (directed attention from last crawl)

Output (agent writes directly to brain):
  - Updated brief per workstream (narrative state-of-play)
  - Action brief (admin-voice canvas — what to do, what to watch, what's urgent)
  - Artifacts (reference materials backing action items)
  - Entity/people updates (new contacts discovered)
  - Untracked activity (things that don't belong to any workstream but matter)
  - context_flags: entity/workstream context that needs owner review
  - crawl_notes: attention items + patterns + open questions for next crawl
```

### Urgency Check (every 5 min, between crawls)

Lightweight, zero LLM tokens:

```
  - Check Gmail API: any new messages since last crawl?
  - Check Slack API: any new DMs or mentions?
  - If subject/snippet contains urgency signals → notify Slack immediately
  - Otherwise → do nothing, next crawl handles it
```

This is the ONLY place keywords are used, and only for urgency detection ("ASAP", "today", "urgent"), not comprehension.

### What Stays the Same

- **Workstreams, entities, people, artifacts** — structured data in brain-platform. Working well.
- **Briefs** — per-workstream narratives stored in brain-platform. Still written, just written better.
- **Brain-platform as central store** — all CC sessions read from it.
- **MCP tools** — get_workstream_context, create_todo, update_brief, etc.
- **The canvas** — living Slack canvas as the human-facing view.

### What Changes

| Before (v3 scanner) | After (v4 master crawl) |
|---|---|
| Domain-based content check per workstream | Read ALL email, Opus routes by understanding |
| Per-workstream Opus scan (5-min cycle) | Single Opus crawl (2x daily) |
| Separate Haiku reconciliation | Opus reconciles in the same pass |
| Separate catchall with metadata triage | Opus catches untracked activity naturally |
| Proposal → Slack → reaction → accept flow | Direct apply (AI takes the wheel) |
| ~30+ LLM calls/day across multiple models | 2 Opus calls/day + zero between |
| Domains define workstream boundaries | People + purpose + context define workstreams |

### What Gets Deleted

- `checkForNewContent()` — domain-based Gmail queries
- `scanWorkstream()` — per-workstream Opus calls
- `reconcileTodos()` — Haiku reconciliation
- `scanCatchall()` — two-phase catchall
- `updateBrief()` — per-workstream brief update
- Reaction poller
- Proposal/alteration flow (pending_alterations table becomes unused)
- `workstream_domains` table becomes optional metadata, not a routing mechanism

### What Gets Added

- `masterCrawl()` — one function, reads everything, produces all outputs
- `urgencyCheck()` — lightweight, no LLM, just "anything new and hot?"
- Canvas refresh integrated into the crawl

## Workstream Definition (Revised)

A workstream is NOT defined by email domains. It's defined by:

- **People** — who's involved (across any number of organizations/domains)
- **Purpose** — what you're trying to accomplish
- **Activity** — ongoing communication/work toward that purpose
- **Back-of-book context** — the durable description of what this engagement is

The master crawl routes content to workstreams based on Opus understanding the people, topic, and context — not domain matching. An email from Will Kim about Vail insurance goes to the Vail workstream even though Will is @burr.com.

## Three-Layer Data Model

v3 had a systemic data quality problem: entity contexts, workstream contexts, and workstream briefs
were all written by LLMs with no clear separation guidance. The result: 10/18 entities have engagement
state, deal terms, and ephemeral status polluting their "company profile." The root cause is ambiguous
tool descriptions ("why they matter" invites engagement content) and no separation guidance in prompts.

v4 fixes this with a formally defined three-layer model. The master crawl reads AND enforces this
separation — it's the single writer for briefs, and it flags workstream/entity context that needs
updating.

### Layer 1: Entity Context (Back-of-Book)

**What it is**: Durable company/organization profile. What the entity IS.

**Contains**: Industry, size, HQ, key products/divisions, revenue, public market info,
competitive positioning in the market, founding story, key executives.

**Does NOT contain**: Deal terms, engagement scope, pricing, MSA status, invoice details,
project timelines, specific GBS contacts on the engagement, current negotiation state.

**Update cadence**: Rarely. Quarterly at most, or when something structurally changes
(acquisition, new CEO, major pivot, earnings that shift positioning).

**Who writes it**: Owner with CoS assistance. NOT the master crawl (crawl can flag staleness
but doesn't rewrite).

**Examples** (good):
- "Roblox Corporation (NYSE: RBLX). Global online platform for immersive 3D experiences.
   80M+ DAU, $3.6B revenue FY2025. Building out advertising business with programmatic
   video ads and brand integrations."
- "Circana. Marketing analytics firm. Panel-based in-store measurement. Legacy player —
   methodology doesn't scale beyond ~10% of retailers."

**Examples** (bad — engagement content that belongs in workstream):
- "GBS is engaged for a ~$1.8M deal including on-premise MeasurementOS deployment"
- "MSA signed mid-March, DPA is the final contracting step"
- "Invoice INV-5834, $32,500 CAD, due Mar 15 — overdue"

**Tool description fix**: `create_entity.context` should read:
> Durable company profile: what the organization IS (industry, size, HQ, key products/divisions,
> competitive positioning). NOT engagement details, deal terms, pricing, or current project
> status — those belong in the workstream context or brief.

### Layer 2: Workstream Context (Back-of-Book)

**What it is**: Durable engagement/initiative context. What you're DOING with this entity
and how the work is structured.

**Contains**: Engagement scope, deal structure, budget, contracting entity, key contacts
and their roles on the project, deliverables, working model between parties, phase structure,
competitive dynamics specific to this deal.

**Does NOT contain**: Current negotiation status, this week's blockers, meeting outcomes,
"as of Mar 27" timestamps, ephemeral action items.

**Update cadence**: When the engagement itself changes structurally — new phase, scope change,
new key contact, deal restructuring. Maybe every few weeks.

**Who writes it**: Owner with CoS assistance. Master crawl can flag when context is materially
stale (e.g., deal stage changed) but doesn't auto-rewrite without confirmation.

**Examples** (good):
- "GBS is Roblox's measurement partner. ~$1.8M engagement including on-premise MeasurementOS
   ($990K), bespoke MMM models for US ($595K) and Brazil ($185K), prepaid incrementality
   testing, dashboards ($35K), Tier 1 Advisory ($15K/mo). Contracting entity: GBS Inc."
- "Two-tranche structure within $175K AUD. First tranche: working prototype for incrementality
   measurement. GBS designs approach, Coles handles internal build execution."

**Examples** (bad — ephemeral content that belongs in brief):
- "DPA is the final contracting step" (status changes week to week)
- "Glenton asked for final confirmation before sending for signature" (this week's state)

### Layer 3: Workstream Brief

**What it is**: Time-sensitive narrative. What's happening NOW. Rewritten every crawl.

**Contains**: Current status, active negotiations, blockers, recent meeting outcomes,
upcoming deadlines, who's waiting on whom, resolved items.

**Update cadence**: Every master crawl (2x daily). Full rewrite, not incremental append.

**Who writes it**: Master crawl (Opus). This is the only layer the crawl rewrites autonomously.

### Separation Enforcement

The master crawl prompt must include explicit instructions:

```
When producing output, respect the three-layer data model:

1. ENTITY CONTEXT — what the company IS. You do not write this. If you notice
   entity context is materially wrong or stale, flag it in the maintenance section
   but do not rewrite it.

2. WORKSTREAM CONTEXT — what the engagement IS. You do not write this. If the
   engagement structure has fundamentally changed (new phase, new scope, new deal
   terms), flag it in the maintenance section.

3. WORKSTREAM BRIEF — what's happening NOW. This is what you write. Full rewrite
   every crawl. Include current status, blockers, deadlines, recent developments.
   Do NOT include durable engagement structure — that belongs in workstream context.
```

The maintenance section of the crawl output should include a `context_flags` list:
```
context_flags:
  - entity:roblox — "DPA status in entity context is stale and shouldn't be there.
    Entity context should be company profile only."
  - workstream:vail-engagement — "Workstream context still says 'MSA in final signature
    stage as of Mar 27.' Engagement has moved to insurance redline phase."
```

These flags are surfaced to the owner for manual review, not auto-applied. Entity and
workstream context are owner-controlled; the crawl just identifies drift.

### Data Cleanup (Pre-v4)

Before the first master crawl runs, the 10 contaminated entities need to be cleaned:
Aprio, Burr & Forman, CashmanCo, Data Sciences, DraftKings, GBS, Mutinex, Roblox,
Supermetrics, Vail Resorts. Engagement content moves to workstream context or brief.
Acorns needs entity context written from scratch. This is a one-time manual task.

## Reference Materials (Artifacts)

Action items in the brief need provenance — "review Jess's measurement materials" is
useless if you can't find the materials. But storing granular metadata per action item
brings us back to the todo-list paradigm.

The happy medium: **workstream artifacts**. Brain-platform already has an artifacts table.

### How It Works

The master crawl, when it encounters a reference backing an action item, stores it as
a workstream artifact:

```
add_artifact(
  workstream_id: "vail-engagement",
  type: "email-thread",
  label: "Jess measurement wrap-up",
  ref: "thread:19cfbd6740bd306e"
)

add_artifact(
  workstream_id: "vail-engagement",
  type: "meeting",
  label: "Jess paid media measurement walkthrough (Mar 27)",
  ref: "fireflies:meeting_abc123"
)

add_artifact(
  workstream_id: "roblox-engagement",
  type: "document",
  label: "BPR committee submission",
  ref: "drive:1a2b3c4d5e"
)

add_artifact(
  workstream_id: "measurementos",
  type: "document",
  label: "CashmanCo key messages doc v2",
  ref: "drive:6f7g8h9i0j"
)
```

Artifact types: `email-thread`, `meeting`, `document`, `slack-thread`, `file`, `link`.
Anything that can be pointed to and retrieved later.

The action brief references by label, not raw ID:

```
→ Review Jess's measurement materials before onsite
  ref: [Jess measurement wrap-up], [Jess paid media measurement walkthrough (Mar 27)]
```

Any CC session working on Vail can call `get_artifacts("vail-engagement")` to find the
backing material. Artifacts are durable references to source material — they don't have
status, priority, or completion tracking. They're nouns, not verbs.

### What Artifacts Are NOT

- Not todo items (no status, no assignee, no due date)
- Not a replacement for the brief (the brief is the authoritative "what to do")
- Not exhaustive (not every email gets an artifact — only ones backing action items)
- Not limited to emails — meetings, docs, Slack threads, Drive files, external links

### Artifact Lifecycle

- **Created** by master crawl when a new reference-backed action appears
- **Moved** between workstreams if the crawl reclassifies (e.g., legal artifact moves
  from vail-engagement to ops-legal)
- **No deletion** — artifacts accumulate as a reference library. Old ones just stop being
  referenced in the brief. Cheap to store, expensive to re-find.

## Tracked Items (Structured Anchor)

v3's todo list was 70% accurate because it was a separate data structure that drifted
from reality. v4's brief is narrative — great for humans but terrible for deterministic
comparison across crawls. Two crawls could describe the same Vail situation differently
enough that the delta is wrong.

The solution: **tracked items** — coarser than v3 todos, structured and keyed. The brief
is rendered FROM tracked items, not compared against the previous brief's prose.

### What Tracked Items Are

Each workstream has a set of tracked items with semantic keys, types, and statuses:

```
workstream: vail-engagement
tracked_items:
  - key: "vail/msa-execution"
    type: milestone
    status: blocked
    summary: "MSA execution — insurance redlines pending"
    blocking: "Glenton Edem, Aleck Watkins"
    since: "2026-03-30"

  - key: "vail/onsite-agenda"
    type: action
    status: open
    summary: "Detailed 3-day agenda to Aleck"
    due: "2026-04-03"
    ref: "artifact:aleck-agenda-thread"

  - key: "vail/jess-retrospective"
    type: inbound
    status: waiting
    summary: "Jess MMM retrospective materials"
    since: "2026-03-27"

  - key: "vail/onsite"
    type: milestone
    status: upcoming
    summary: "Onsite at Omni Interlocken"
    due: "2026-04-14"
```

### Item Types

- **milestone** — a significant gate or event (MSA signed, onsite, launch date)
- **action** — something the owner needs to do (send agenda, review materials)
- **inbound** — something expected from an external party (Jess's materials, Glenton's response)
- **commitment** — a promise the owner made to someone (deliver BPR materials to Danica by Thu)
- **monitor** — something to watch that may or may not require action (competitor move, market signal)

### Item Statuses

- **open** — active, needs attention
- **blocked** — waiting on a specific blocker (blocking field says who/what)
- **waiting** — owner has done their part, waiting on external party
- **upcoming** — scheduled future event, not yet actionable
- **complete** — done (kept for one crawl cycle for delta, then archived)
- **cancelled** — superseded or no longer relevant

### How Tracked Items Differ from v3 Todos

| | v3 Todos | v4 Tracked Items |
|---|---|---|
| Granularity | "Email Aleck about agenda" | "Onsite agenda preparation" |
| Lifecycle | Created by scanner, reconciled by Haiku, approved via reactions | Single owner: crawl agent creates, updates, completes |
| Relation to brief | Separate structure that drifts | Brief is RENDERED from items — can't drift |
| Identity | UUID, no semantic meaning | Semantic key: `vail/msa-execution` — stable across crawls |
| Status model | open/done/cancelled | 6 statuses + blocking + since + due |
| Cross-crawl | Compared by UUID, reconciled by Haiku | Compared by key, updated by evidence |

### How Tracked Items Power Deltas

The crawl flow:
1. Read previous tracked items (structured, keyed, deterministic)
2. Read source data (email, Slack, Fireflies)
3. Update items based on evidence: `blocked → complete`, `waiting → received`, add new, cancel stale
4. Compute delta from STATUS CHANGES — not from comparing narratives
5. Render the narrative brief using delta + current items as skeleton

Delta is now deterministic: "vail/msa-execution changed from `blocked` to `complete`"
→ brief says `✓ MSA signed`. No narrative comparison needed.

### Storage

Tracked items live in brain-platform. New MCP tools:
- `list_tracked_items(workstream_id)` — all items for a workstream
- `upsert_tracked_item(workstream_id, key, type, status, summary, ...)` — create or update by key
- `complete_tracked_item(key)` — mark done
- `cancel_tracked_item(key)` — mark cancelled
- `list_all_tracked_items(status?, type?)` — cross-workstream query

The semantic key (`vail/msa-execution`) is the primary identifier, not a UUID. The crawl
agent reads by key, updates by key. Keys are human-readable and stable.

### What the Owner Sees

The owner never interacts with tracked items directly. They see the brief (narrative)
and the canvas (dashboard). Tracked items are internal machinery that powers accurate
deltas and cross-workstream queries. The CoS can query them when the owner asks
"what's blocking across all workstreams?" but the primary interface is the brief.

## Action Brief Format (Canvas)

The canvas is the owner's dashboard — rendered from tracked items + narrative briefs.

Each workstream block has two parts:
1. **What changed** — delta computed from tracked item status changes (deterministic)
2. **Current state** — narrative context + active items

```
## Vail — Onsite Prep [active, Apr 14-16]

Since last crawl:
  ✓ Glenton acknowledged insurance redlines (Mar 31 AM)
    [vail/msa-execution: blocked → in-progress]
  ✓ Will Kim weighed in — says not a big deal, request limit change
  ~ No response from Aleck on payment terms

Contracts in final stage — insurance redlines with Glenton, Aleck
pushing exception approval. Not blocking onsite.

Flights booked (Omni Interlocken). Aleck confirmed Tue-Thu.

→ Send detailed 3-day agenda to Aleck by Apr 3
  ref: [Aleck agenda thread], [Jess paid media measurement walkthrough (Mar 27)]

→ Review Jess's measurement materials before onsite
  ref: [Jess measurement wrap-up]

⏳ Glenton/Aleck on insurance exception approval
⏳ Jess MMM retrospective (may or may not come)
```

Key properties:
- **Human-readable** — admin briefing voice
- **Deterministic deltas** — "since last crawl" driven by tracked item status changes
- **Agent-parseable** — `→` actions, `⏳` monitors, `✓` resolved, `~` no movement, `ref:` artifact labels
- **Rewritten every crawl** — no stale accumulation
- **Cross-workstream** — untracked activity section catches things outside workstreams

## Future: Cross-Session Context

Each workstream block could eventually link to session activity:

```
[Session context: Vail agenda drafted in CC session Apr 2.
Read Jess's spillover methodology, Aleck's CRO Deep Dive.
Decided Day 2 focuses on their specific pain points.
Draft: /docs/vail-onsite-agenda-v1.md]
```

This would come from a `log_activity(workstream_id, summary)` MCP tool that any CC session calls when finishing work on a workstream. Not needed for v4 launch — the action brief format with ref: links is the foundation.

## Cost Estimate

- Master crawl: ~270K input tokens × 2/day = ~540K/day on Max plan
- Urgency check: 0 LLM tokens (API calls only)
- Current v3 scanner: ~30+ calls/day, varying 5K-300K tokens each
- Net: similar or lower token usage, dramatically better output quality

## Implementation Plan

1. Build `masterCrawl()` function — reads all sources, produces structured output
2. Build `urgencyCheck()` — lightweight Gmail/Slack API polling
3. Update canvas refresh to use new action brief format
4. Test with live crawl (already prototyped in session 31)
5. Delete scanner code (checkForNewContent, scanWorkstream, reconcileTodos, scanCatchall, etc.)
6. Deploy and monitor via #clawvato-monitoring
