# Design: Agent Architecture v2 — Dumb Brains, Smart Agents

> Status: PROPOSED | Session 29 | 2026-03-26
> Supersedes: Per-entity brain intelligence (S28), triage/entity-routing system
> Builds on: Brain Platform (S26-27), CC-Native Engine (S25)

## Problem Statement

Session 28 built a sophisticated entity-based routing system: Haiku NER extracts entities from messages, scores them against `memory_entities`, falls back to seed aliases, and routes content to per-client brains. After running overnight backfill:

- **Acorns brain**: 496 facts — mostly wrong. Coles negotiations, Vail SOW terms, Roblox MSA, DraftKings payments, corporate tax strategy. All misrouted.
- **GYG, Vail, Ad Platforms brains**: 0 facts each. Empty shells.
- **Root cause**: "Andrew Covato" appears in every message. Acorns accumulated facts first, so `memory_entities` always matched Acorns. New brains couldn't compete (chicken-and-egg). The fallback alias system couldn't overcome the scoring threshold.

Meanwhile, when an LLM (Opus) read the Acorns brain, it **immediately** identified every misrouted fact in a single pass. No scoring system, no NER, no thresholds — just reading and judgment.

**The insight**: We built complex routing intelligence in the wrong layer. The brain should be dumb storage. The LLM should be the intelligence.

## Design Principles

1. **Brains are dumb storage** — CRUD, embeddings, search, dedup. No routing, no extraction, no classification intelligence.
2. **Agents are the intelligence** — Opus does categorization, extraction, quality control. One prompt to classify > 500 lines of routing code.
3. **Don't rebuild what's natively available** — CC CLI with `--print` is a persistent, stateful agent runtime for $0 on Max plan.
4. **Correctness above all** — out-of-date counts as incorrect. Three layers of freshness guarantee current data.
5. **Materialized views over live queries** — `brain.md` files give agents instant, complete context without API calls or token-budgeted retrieval.
6. **Build for the future** — LLM-agnostic by design. CC CLI today, any API tomorrow.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    AGENT LAYER (CC CLI)                  │
│                                                         │
│  Clawvato (CoS)          Curator              Entity    │
│  ┌──────────────┐   ┌──────────────┐    ┌────────────┐ │
│  │ Slack Channel │   │ --print      │    │ --print    │ │
│  │ Always-on     │   │ --resume    │    │ --resume  │ │
│  │ Interactive   │   │ curator      │    │ agent-X    │ │
│  │ Broad context │   │ Always-on    │    │ On-demand  │ │
│  │ Routes tasks  │   │ Files facts  │    │ Deep on X  │ │
│  └──────┬───────┘   │ Audits data  │    │ Reads .md  │ │
│         │           │ Builds .md   │    └─────┬──────┘ │
│         │           └──────┬───────┘          │        │
│         │                  │                  │        │
│    ┌────┴──────────────────┴──────────────────┴────┐   │
│    │              MAILBOX (inter-agent)             │   │
│    └───────────────────────┬───────────────────────┘   │
└────────────────────────────┼───────────────────────────┘
                             │
┌────────────────────────────┼───────────────────────────┐
│              BRAIN PLATFORM (dumb storage)              │
│                            │                            │
│  ┌─────────┐  ┌───────────┴──┐  ┌──────────────────┐  │
│  │ Facts   │  │ Mailbox      │  │ Connectors       │  │
│  │ (pg)    │  │ (pg)         │  │ (Slack, Gmail,   │  │
│  │         │  │              │  │  Fireflies)      │  │
│  │ embed   │  │ send_message │  │                  │  │
│  │ search  │  │ get_messages │  │ Push (webhooks)  │  │
│  │ dedup   │  │ LISTEN/      │  │ Pull (hourly)    │  │
│  │ cluster │  │   NOTIFY     │  │ Query-time poll  │  │
│  └─────────┘  └──────────────┘  └──────────────────┘  │
│                                                         │
│  ┌──────────────────────────────────────────────────┐  │
│  │ brain-states/                                     │  │
│  │   acorns.brain.md    ← materialized view          │  │
│  │   vail.brain.md      ← rebuilt on fact changes    │  │
│  │   gyg.brain.md       ← pruned, structured, fresh  │  │
│  │   ...                                             │  │
│  └──────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

## Agents

### Clawvato — Chief of Staff (Always-On)

The owner's primary interface. Runs as a CC CLI instance with Slack Channel (same as today). Broad, thin context across all clients/initiatives.

**Context model:**
- Reads `business-state.md` on startup (~2K tokens — one-liner per brain)
- Reads specific `brain.md` files on-demand when a topic comes up
- Knows enough about everything to route, drills into detail when needed
- Delegates deep work to entity agents via mailbox

**Responsibilities:**
- Respond to owner in Slack
- Route questions/tasks to the right entity agent
- Morning briefing: query each active brain, surface urgencies
- Escalate when entity agents flag issues

**Runtime:** CC CLI with Channels (interactive, always-on, existing supervisor pattern).

### Curator — Data Steward (Always-On)

A dedicated CC instance whose sole job is data quality and organization. No user interaction.

**Responsibilities:**
1. **Deep-read incoming content** — pick up pointers from the inbox, read the FULL source material (entire email threads, complete Fireflies transcripts, full Slack conversations) via native tools (gws CLI, Fireflies API, Slack MCP). No snippets, no summaries. Deep analysis finds commitments buried in long threads, pricing details in email chains, context that only emerges from reading everything.
2. **Extract and file facts** — with full business context across all brains, route each extracted fact to the correct brain via `store_fact()`. Surface new entities/clients that don't match any existing brain.
3. **Build brain.md files** — materialized views of each brain, rebuilt when facts change. Structured by concept type, pruned of stale/completed items, biased toward recency.
4. **Periodic audit** — sweep each brain, retire stale facts, move misrouted ones, flag duplicates. The same judgment an LLM applies naturally when reading a list of facts ("this doesn't belong here").
5. **Ambient entity detection** — identify entities that appear everywhere (owner name, company name) and note them so they don't skew any future heuristics.

**Runtime:** CC CLI with `--print curator --model sonnet`. Sonnet for routine ingestion (structured extraction at high throughput, separate rate limit pool). Opus for periodic audits where deep reasoning matters. Always-on via a simple loop with source API access:

```bash
# Routine ingestion (Sonnet — high throughput, lower cost on rate limits)
while true; do
  claude --print curator --model sonnet \
    --allowedTools "mcp__brain-platform__*,Bash,Read,Write" \
    "Check inbox for new pointers. For each pending item: read the FULL \
     source content (entire email thread, complete transcript, full conversation). \
     Extract facts, file to correct brains, regenerate affected brain.md files. \
     Update business-state.md if any brain changed."
  sleep 60
done

# Periodic audit (Opus — deep reasoning for quality review)
# Runs daily or on-demand
claude --print curator-audit \
  --allowedTools "mcp__brain-platform__*,Read,Write" \
  "Audit all brains: review facts for correctness, staleness, misrouting. \
   Retire outdated facts, move misrouted ones, flag duplicates. \
   Regenerate affected brain.md files."
```

**Why a dedicated agent (not the CoS wearing a second hat):**
- Different rhythm — background/maintenance vs. reactive/interactive
- Different context needs — curator needs all brains deep, CoS needs all brains thin
- Separation of concerns — curator never touches Slack, CoS never files facts

### Entity Agents — Domain Specialists (On-Demand)

One per client/initiative/department. Deep context on their domain, thin on everything else.

**Context model:**
- Reads its own `brain.md` file (full current state, 2-5K tokens)
- Reads a summary of all other brains (CoS-level thin context, ~30K tokens)
- Session history provides continuity across recent activations
- Falls through to `search_memory()` for deep dives into historical data

**Responsibilities:**
- Answer detailed questions about their domain (delegated from CoS)
- Process domain-specific tasks
- Flag issues to CoS via mailbox (e.g., "Vail SOW hasn't progressed in 2 weeks")

**Runtime:** CC CLI with `--print agent-{brain_id}`. Activated by the supervisor when a mailbox message arrives:

```bash
claude --print agent-acorns \
  --allowedTools "mcp__brain-platform__*,Read" \
  "You are the Acorns specialist agent. Read brain-states/acorns.brain.md \
   for current state. Message from CoS: 'What's Phil's latest on Phase 2?'"
```

**Lifecycle:**
- Session persists via `--resume` (CC stores conversation as JSONL)
- Auto-compaction handles context pressure — old conversation fades, brain.md is always fresh
- No handoff protocol needed — the brain IS the persistence. The .md file IS the handoff.

**Source Access:**
Entity agents have the same source API tools as the curator (gws CLI, Slack MCP, Fireflies). When asked "what did Jon say in Slack about Phil's feedback on the dashboard, and how does that compare to last week's meeting?" the agent:
1. Reads brain.md → knows Jon, Phil, the dashboard workstream, recent context
2. Searches Slack directly (Jon + dashboard + Phil) → reads the actual messages in full
3. Searches Fireflies for last week's meeting → reads the relevant transcript section
4. Synthesizes: compares what Jon said in Slack vs. what was discussed in the meeting

The brain tells the agent *what to look for*. The source APIs provide *what was actually said*. No pointers, no indirection — the agent searches with context, just like a human would.

## Brain Platform (Simplified)

### What Stays
- `memories` table — facts with embeddings, concept_type, entities, importance, timestamps, brain_id, status

### Source Access (Direct, Not Pointers)

Facts are distilled intelligence, not breadcrumb trails back to source material. When an agent needs to know "what did Jon actually say," it doesn't follow a pointer from a fact — it searches the source directly.

**The pattern:**
1. Brain.md gives the agent **context** — it knows the people, workstreams, recent activity
2. With that context, the agent **searches sources directly** — Slack search for "Jon + dashboard + Phil", Gmail search for the relevant thread, Fireflies search for last week's meeting
3. The agent reads the **full original content** and synthesizes the answer

**Why not source pointers on facts:**
- Facts may derive from multiple sources (a Slack thread + a meeting + an email all contributing to one understanding)
- Pointers go stale (messages edited, threads archived)
- Rich context is lost in the pointer — the surrounding conversation, tone, what was said before/after
- It adds schema complexity for something the agent can do natively by just searching

**What the agent needs:** Access to source APIs (gws CLI, Slack MCP tools, Fireflies tools) and enough context from brain.md to know what to search for. The brain tells the agent *what matters*. The source APIs provide *what was actually said*.

The existing `source` field on memories remains as a lightweight label (e.g., `"sweep"`, `"direct"`, `"feed"`) for provenance tracking and debugging — not as a drilldown mechanism.

### Fact Reconciliation

When a new fact changes the picture (e.g., "Phil left Acorns"), affected facts need reconciliation — not just appending the new fact alongside contradictory old ones. Two mechanisms:

1. **Curator reconciliation (on brain.md rebuild):** When regenerating a brain.md, the curator reads ALL current facts and builds a coherent narrative. If Phil left, the "Key People" section drops him, open commitments tied to Phil get flagged as at-risk, and the curator may proactively retire or mark-historical facts that reference Phil as current contact. The brain.md always presents a consistent picture.

2. **Correction cascade:** The existing `correct()` MCP tool already does targeted reconciliation — it finds affected facts and classifies them as keep/update/correct/retire. When the CoS calls `correct("Phil left Acorns, joined GOAT")`, the correction engine handles the downstream updates. The curator then rebuilds brain.md from the corrected state.
- Embeddings — nomic-embed-text-v1.5, 384d Matryoshka
- Hybrid search — tsvector + pgvector + RRF scoring
- Cross-encoder reranking — ms-marco-MiniLM-L-6-v2
- Write-time dedup — 3-tier (heuristic, cross-encoder, Haiku LLM)
- HDBSCAN clustering — semantic organization, auto-labeled
- Background maintenance — consolidation, temporal decay, embedding backfill
- MCP tools — `store_fact`, `store_facts`, `search_memory`, `retrieve_context`, `retire_memory`, `correct`, `merge_entities`, brain management tools
- Per-brain YAML configs — concepts, purpose, entity info (used by curator for extraction guidance)

### What Gets Deleted
- `engine/entity-router.ts` — agents make routing decisions
- `engine/triage.ts` — agents make routing decisions
- Haiku NER extraction in entity router — agents extract entities
- Scoring/threshold/fallback logic — not needed when an LLM just reads and decides
- API-based fact extraction in `/ingest` — curator extracts facts, calls `store_fact` directly
- `sidecar/poll-scheduler.ts` triage integration — replaced by curator

### What Gets Added

#### 1. Inbox Table (Pointers, Not Content)

Discovery queue — connectors identify what's new, the curator reads the full content directly from source APIs.

**Key principle:** The inbox stores **pointers**, not content. A Gmail pointer says "thread abc123 has new messages." The curator then reads the entire thread via gws CLI — every email, full bodies, attachments metadata. No truncation, no snippets. Same for Fireflies (full transcript), Slack (full conversation history). This ensures deep analysis: commitments buried on page 3 of a transcript, pricing details in the 8th email of a thread, name drops that only make sense in full context.

```sql
CREATE TABLE inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source TEXT NOT NULL,            -- 'slack', 'gmail', 'fireflies'
  source_id TEXT NOT NULL,         -- thread_id, channel_id:ts, meeting_id
  metadata JSONB DEFAULT '{}',    -- discovery metadata (subject, sender, channel name, duration, etc.)
  status TEXT DEFAULT 'pending',   -- 'pending', 'processing', 'done', 'failed'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ,
  processed_by TEXT,              -- agent that processed it (e.g., 'curator')
  UNIQUE(source, source_id)       -- prevent duplicate pointers
);

CREATE INDEX idx_inbox_status ON inbox(status) WHERE status = 'pending';
CREATE INDEX idx_inbox_source ON inbox(source, source_id);
```

MCP tools: `get_pending_inbox(limit?)`, `mark_inbox_processed(id)`, `mark_inbox_failed(id, reason)`

**The curator reads full content directly:**
- Gmail: `gws gmail thread <id>` → full thread with all messages, complete bodies
- Fireflies: `fireflies transcript <id>` → full transcript with timestamps and speakers
- Slack: `slack_get_history(channel, oldest)` → full conversation

This replicates the experience from the cowork session where CC read full source material through native connectors and found important details that snippet-based pipelines miss.

#### 2. Mailbox Table

Inter-agent message passing with store-and-forward semantics.

```sql
CREATE TABLE agent_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent TEXT NOT NULL,        -- 'clawvato', 'curator', 'agent-acorns'
  to_agent TEXT NOT NULL,          -- target agent id
  message_type TEXT DEFAULT 'task', -- 'task', 'response', 'notification', 'alert'
  payload JSONB NOT NULL,          -- { task: "...", context: "...", priority: "..." }
  status TEXT DEFAULT 'pending',   -- 'pending', 'processing', 'done'
  parent_id UUID REFERENCES agent_messages(id),  -- for request/response threading
  created_at TIMESTAMPTZ DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX idx_messages_recipient ON agent_messages(to_agent, status) WHERE status = 'pending';
```

MCP tools: `send_message(to, payload, type?)`, `get_messages(for, type?, limit?)`, `mark_message_done(id)`, `reply_to_message(id, payload)`

Real-time notifications via Postgres `LISTEN/NOTIFY`:
```sql
-- On INSERT trigger:
PERFORM pg_notify('agent_mail', NEW.to_agent || ':' || NEW.id::text);
```

#### 3. Brain State Files (Materialized Views)

Structured markdown files maintained by the curator. Stored on disk (or in a `brain_states` table for cloud access).

```markdown
# Acorns — Current State
> Last updated: 2026-03-26T14:30Z | 47 active facts | 3 clusters

## Key People
- **Phil Clark** — primary contact, COO
- **Raquel Aguirre** — legal/contracts, MSA signatory
- **Niall Donnelly** — MOS strategy review
- **Christopher** — fractional PM (active via Deel since 2026-02-03)

## Active Deals
- **Phase 1** ($180k): MSA executed 2026-02-23. Analytics dashboard + API integration. PM active.
- **Phase 2** (~$100k+): Mobile app instrumentation. Contingent on Phase 1 success. Not yet contracted.
- **MeasurementOS Strategy**: Niall reviewing v10 — flagged that Year 1 costs exclude consulting services.

## Open Commitments
- Jonathan evaluating hand-off vs. managed service model (decision pending)
- GA for Experimentation: most features free, programmatic access + MOS integration paywalled

## Workstreams
- Fractional PM (Christopher): $12,500/mo flat, both GA4E and MOS products
- MOS strategy doc: v10 in review, cost gap flagged by Niall

## Recent Activity (7 days)
- [none since last sweep]

## Historical Notes
- MSA fully executed 2026-02-23 (DocuSign, Raquel initiated)
- Original engagement scoped Nov 2024
```

**Any agent can write to any brain.** The curator is the primary bulk writer (ingestion), but not the exclusive one:
- **CoS writes** when the owner provides direct input ("Phil left Acorns", "actually the Vail SOW is $225k not $200k", "I just had coffee with Aleck and he said X")
- **Entity agents write** when they discover something during a task
- **Curator writes** during bulk ingestion and audits

All writes use the same MCP tools (`store_fact`, `correct`, `retire_memory`). The brain doesn't care who wrote — it's dumb storage.

**Regeneration is mechanically guaranteed — not prompt-driven:**

```
Any agent calls store_fact / correct / retire_memory
  → brain-platform fires NOTIFY on 'brain_updated' channel
     with payload: brain_id that changed
  → curator picks up notification
  → regenerates affected brain.md
  → regenerates business-state.md (rollup of all brain.mds)
```

No polling for freshness, no staleness window. Fact changes → files update. During bulk ingestion (curator processing 20 emails), notifications are debounced (5-10s) to avoid regenerating 20 times — but the guarantee is: by the time any agent reads the file, it reflects the latest state.

**Additional triggers (safety nets):**
- Periodic refresh (hourly) — catches any missed notifications
- On-demand — any agent can request regeneration via mailbox

**Construction rules:**
- Only `status = 'current'` facts
- Organized by concept type (deals, people, commitments, workstreams)
- Most recent facts first within each section
- Completed/closed items summarized in one line or pruned entirely
- Target: 2-5K tokens per brain (fits comfortably in any context window)
- Curator uses the brain's YAML config (concepts, purpose) to structure the file

## Three-Layer Freshness Model

Data freshness is guaranteed by three independent, complementary layers:

### Layer 1: Push (Real-Time)

Webhooks from source systems push events into the inbox immediately.

| Source | Mechanism | Latency |
|--------|-----------|---------|
| Gmail | Pub/Sub push notification → inbox | Seconds |
| Google Calendar | events.watch() → inbox | Seconds |
| Slack | Events API (already in place via CoS Channel) | Real-time |
| Fireflies | Webhook on transcript ready | Minutes |

**Implementation:** Each webhook endpoint validates, writes to inbox table, fires `NOTIFY` to wake the curator. Existing Slack Channel on the CoS handles Slack events directly.

### Layer 2: Pull (Hourly Sweep)

Safety net that catches what push missed, covers sources without webhook support, and backfills gaps.

| Source | Frequency | Method |
|--------|-----------|--------|
| Slack | 1 hour | Conversations API — discover new messages |
| Gmail | 1 hour | Threads API — discover new/updated threads |
| Fireflies | 1 hour | GraphQL API — discover new transcripts |
| Google Drive | 6 hours | Files API — discover new/modified files |

**Implementation:** Lightweight cron or timer loop. Connectors only do **discovery** — they identify what's new (via high-water marks) and write pointers to the inbox table. No content fetching, no extraction, no routing. The curator reads the full content when it processes each pointer. This keeps connectors fast and simple (~50 lines each).

### Layer 3: Query-Time Refresh (On-Demand)

Right before an agent responds, a quick check: "anything new since last update for this brain?"

```
Agent receives task about Acorns
  → Check: inbox has pending items tagged 'acorns'?
  → If yes: curator processes them first (or agent processes inline)
  → Read acorns.brain.md (now guaranteed fresh)
  → Respond
```

**Implementation:** The supervisor checks the inbox before routing a mailbox message to an entity agent. If there's pending content for that brain, it wakes the curator first. Adds milliseconds of latency for guaranteed freshness.

Together: push catches events in real-time, hourly sweep catches stragglers, query-time refresh guarantees freshness at the moment it matters. Any single layer can fail and the others compensate.

## Agent Supervisor

A lightweight Node.js process that manages the agent pool. Not an LLM — just orchestration logic.

**Responsibilities:**
1. **Mailbox polling** — listen for new messages via `LISTEN/NOTIFY`, route to the right agent
2. **Agent lifecycle** — start CC CLI processes, handle exits, track session names
3. **Inbox monitoring** — when new content arrives, wake the curator
4. **Query-time freshness** — before routing a task to an entity agent, check if its brain has pending inbox items
5. **Health monitoring** — track agent response times, restart if stuck

**Implementation:** ~200-300 lines of Node.js. Uses `child_process.execFile` for `claude --print`. Listens to Postgres NOTIFY channels. Simple state: which agents exist, which are currently processing, queue of pending messages.

```
Supervisor loop:
  1. LISTEN on 'agent_mail' channel
  2. On notification → route to agent:
     a. Check inbox for pending content for this brain
     b. If pending → wake curator first, wait for processing
     c. Invoke: claude --print {agent-id} "{message}"
     d. Capture response → send_message back to requester
  3. On timer (60s) → check for any unprocessed inbox/mailbox items
```

**Not responsible for:** Intelligence, extraction, routing decisions, data quality. Those are agent responsibilities.

## Inter-Agent Communication

### Message Flow Examples

**CoS delegates a question:**
```
Owner (Slack): "What's the latest on Vail?"
  → Clawvato reads vail.brain.md (has summary)
  → Needs more depth → send_message(to: "agent-vail", type: "task",
      payload: { task: "Owner asks for latest Vail update. Full status please." })
  → Supervisor routes to Vail agent
  → Vail agent reads vail.brain.md, processes, responds
  → reply_to_message(id, { result: "Vail SOW still unsigned..." })
  → Clawvato receives response, posts to Slack
```

**Curator flags an issue:**
```
Curator finds stale commitment in Acorns brain
  → send_message(to: "clawvato", type: "alert",
      payload: { alert: "Acorns: unsigned compliance questionnaire from Dec 2025. 3 months overdue." })
  → Clawvato decides whether to surface to owner
```

**New content arrives:**
```
Gmail webhook fires → inbox row created → NOTIFY
  → Supervisor wakes curator
  → Curator reads email, extracts facts, routes to correct brain(s)
  → Regenerates affected brain.md files
  → If urgent (deadline, commitment): send_message to CoS
```

### Message Types

| Type | Purpose | Example |
|------|---------|---------|
| `task` | Request work from another agent | CoS → entity: "Answer this question" |
| `response` | Reply to a task | Entity → CoS: "Here's the answer" |
| `alert` | Flag something important | Curator → CoS: "Stale commitment found" |
| `notification` | Informational, no response needed | Curator → entity: "Your brain.md was updated" |

## Cost Model

```
Max Plan 1 ($200/mo):
  - Clawvato CoS (Slack, always-on, interactive)
  - Local dev sessions (this conversation)
  - Ad-hoc entity agents (on-demand, low frequency)

Max Plan 2 ($100-200/mo):
  - Curator (always-on, high throughput)
  - Entity agents overflow (if Plan 1 rate-limited)

Total: $300-400/month for unlimited Opus across all agents
vs. estimated $1,500-1,800/month on API for equivalent workload
```

**Scaling:** At 20-30 entity agents, most are idle most of the time. The curator sequences processing (Acorns, then Vail, then GYG...) so agents rarely run concurrently. 3-5 concurrent CC instances has been proven stable. Rate limiting handles burst naturally.

## Migration Plan

### Phase 0: Cleanup (Prerequisite)
- Nuke misrouted data from Acorns brain (retire all, re-backfill with curator)
- Delete entity-router.ts, triage.ts, Haiku NER code from brain-platform
- Simplify `/ingest` endpoint to "store pre-extracted facts" (or deprecate entirely)

### Phase 1: Mailbox + Inbox Infrastructure
- Add `inbox` and `agent_messages` tables to brain-platform
- Add MCP tools: `send_message`, `get_messages`, `mark_message_done`, `reply_to_message`, `get_pending_inbox`, `mark_inbox_processed`
- Add LISTEN/NOTIFY triggers
- Modify connectors to write to inbox instead of calling `/ingest`

### Phase 2: Curator Agent
- Build curator system prompt (brain configs, concept types, extraction guidance)
- Implement curator loop: poll inbox → extract → file → regenerate brain.md
- Build brain.md generation logic (structured, pruned, concept-organized)
- Test: feed raw content → verify correct brain assignment + brain.md quality

### Phase 3: Agent Supervisor
- Build supervisor process: LISTEN/NOTIFY → route to agents → capture responses
- Implement query-time freshness check (inbox scan before routing)
- Wire up Clawvato CoS to send mailbox messages instead of handling everything directly

### Phase 4: Entity Agents
- Create entity agent system prompt template
- Test with 2-3 clients (Acorns, Vail, GYG)
- Validate: CoS delegates → entity agent responds accurately from brain.md + search

### Phase 5: Three-Layer Freshness
- Wire Gmail Pub/Sub webhook → inbox
- Wire Calendar events.watch() → inbox
- Wire Fireflies webhook → inbox
- Implement query-time refresh in supervisor
- Hourly sweep as fallback (simplified existing connectors)

### Phase 6: Scale + Polish
- Create remaining entity brains as needed
- Tune brain.md generation (token budget, pruning rules, concept organization)
- Morning briefing routine for CoS
- Ambient entity detection in curator

## What Gets Simpler

| Before (v1) | After (v2) |
|---|---|
| Haiku NER + entity scoring + seed aliases + threshold tuning | Opus reads and decides |
| entity-router.ts (227 lines) | Deleted |
| triage.ts (54 lines) | Deleted |
| API-based extraction in /ingest | Curator extracts natively |
| Complex sidecar (triage + extraction + sweeps) | Connectors dump to inbox (simple) |
| `retrieve_context` with token budgets for every query | `Read("brain-states/acorns.brain.md")` |
| Elaborate handoff protocol per agent | Brain.md IS the handoff |
| Prompt engineering for extraction quality | Opus just reads and understands |

## What Gets More Complex

| New Component | Complexity | Why Worth It |
|---|---|---|
| Mailbox table + MCP tools | Low (~100 lines) | Foundation for all inter-agent comms |
| Inbox table + MCP tools | Low (~80 lines) | Clean separation: collect vs. process |
| Curator agent + loop | Medium (system prompt + bash loop) | Replaces all routing/extraction logic |
| Agent supervisor | Medium (~250 lines Node.js) | Manages N agents, routes messages |
| Brain.md generation | Medium (curator responsibility) | Instant context, no API call needed |

**Net complexity change:** Significantly simpler. We delete ~500 lines of routing/triage/NER code and replace it with ~400 lines of infrastructure (tables, tools, supervisor) plus natural language prompts that Opus executes. The intelligence moves from code to prompts — where it's more maintainable, more flexible, and more correct.

## Resolved Design Decisions

1. **Brain.md storage**: Files on disk at `/data/brain-states/` on Railway persistent volume (same volume used for Claude CLI auth). Simple, native CC file reads, persists across deploys.

2. **Curator model**: Sonnet for routine ingestion (high-volume, structured extraction — read thread, extract facts, file correctly). Opus for audits and complex reconciliation where deep reasoning matters. Separate rate limit pool for Sonnet means higher throughput. Curator batches ingestion hourly, but query-time refresh checks inbox first — if new content exists for the relevant brain, curator processes it before the entity agent responds.

3. **Query-time refresh**: Check inbox for pending pointers before answering. If nothing new → skip refresh, just read brain.md (instant). If new content → curator processes it first (seconds to minutes depending on volume). Don't refresh blindly — only when there's actually new data.

4. **CoS context loading**: NOT all 30 brain.md files. Instead, a **`business-state.md`** meta-summary — one line per brain with current status. ~2K tokens total. CoS reads this on startup for broad awareness, drills into specific brain.md files only when a topic comes up.

    ```markdown
    # Business State
    > Updated: 2026-03-26T15:00Z

    ## Active Clients
    - **Acorns**: Phase 1 active ($180k), PM on Deel, Phase 2 pending. 47 facts.
    - **Vail**: SOW unsigned, payment terms dispute (Net 60 + rebate). 23 facts.
    - **GYG**: Revised proposal sent, Tristan ready to move forward. 12 facts.
    - **Roblox**: MSA negotiation, pricing pushback on 25% increase. 31 facts.
    - **Coles**: Budget capped at AUD$250k, option 3 (slim prototype). 18 facts.

    ## Initiatives
    - **MeasurementOS**: Strategy v10 in review, cost gap flagged. 15 facts.

    ## Operations
    - **Finance**: S-corp → C-corp consolidation, Aprio handling. 22 facts.
    - **Legal**: IP C&D active (Erica/C-Level), MeasurementOS trademark (Burr & Forman). 8 facts.
    ```

    The curator maintains this file alongside individual brain.md files. Regenerated whenever any brain.md changes.

5. **A2A**: Skip for now. Postgres mailbox is sufficient. The mailbox schema doesn't preclude wrapping an A2A-compatible HTTP interface around it later if external interop is needed. Build the simple thing, adopt the protocol when there's a reason.

6. **Cross-session awareness**: Replaced by `business-state.md` + individual `brain.md` files. Any agent (cloud, local, entity) reads these files for cross-session context. No separate brief/handoff protocol needed — the curator maintains the files, they're always current. For real-time agent status, the mailbox itself serves as a signal: messages in-flight show what's happening, pending messages show queued work. The `update_brief`/`update_handoff`/`get_briefs`/`get_handoff` MCP tools become deprecated once this architecture is live.

7. **Coding session data**: Backlogged. Dev sessions (architecture decisions, implementation state, debugging) are a different use case from business context. The dev brain + CLAUDE.md + CC auto-memory + session persistence may be sufficient natively. Revisit after business architecture is stable.

8. **Concurrency**: Not a concern in practice. Most flows are sequential (hand off → pick up → bring back). Only parallelism is when a batch of content pertains to multiple brains simultaneously — rare, and even then 2-3 concurrent instances max. CC rate limiting handles burst naturally. No special orchestration needed.
