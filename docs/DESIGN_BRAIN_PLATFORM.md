# Design: Brain Platform — Multi-Brain Architecture for a Personal Operating System

> Status: **Vision + Architecture** | Emerged from: Sessions 24-25 | Builds on: S10 (Memory Excellence), S24 (Smart Plugin Migration), S25 (Sidecar Rebuild)

## Origin Story

Clawvato started as a Slack bot with memory. Then the memory became a smart plugin (embeddings, hybrid search, reranking, dedup, clustering). Then the sidecar got tiered sweeps. Then newmail independently discovered that the same plugin could power email categorization — HDBSCAN clustering replaces Gmail's dumb inbox. Then we realized: the plugin isn't a memory system. It's a **brain platform**. Any high-volume data source can feed it, any application can sit on top of it, and multiple brains can share intelligence through a common entity namespace.

This document describes that platform.

---

## Core Concept: What Is a Brain?

A brain is a self-contained intelligence unit. It ingests data from configured sources, extracts and organizes knowledge automatically, and exposes that knowledge through a standard interface.

Every brain runs the same codebase (`clawvato-memory`). What makes each brain different is its **configuration**: what data it ingests, how it extracts facts, how fast memories decay, and what other brains it connects to.

```
Brain Instance
  ├── Identity        WHO am I? What's my purpose?
  ├── Inputs          WHERE does my data come from?
  ├── Processing      HOW do I extract and organize knowledge?
  ├── Outputs         HOW do applications consume my knowledge?
  ├── Connections     WHICH other brains do I talk to?
  └── Storage         Postgres + pgvector (one DB per brain)
```

A brain is NOT a generic database. It has opinions:
- It extracts facts from raw text (Sonnet LLM)
- It embeds everything in the same vector space (nomic-embed-text-v1.5)
- It discovers structure through clustering (HDBSCAN)
- It connects knowledge through entity tags (entity-hop traversal)
- It forgets what doesn't matter (temporal decay)
- It deduplicates aggressively (3-tier: heuristic → cross-encoder → LLM)
- It synthesizes higher-order insights (reflection engine)

All of this is automatic. You configure inputs and the brain handles the rest.

---

## Multi-Brain Architecture

### Why Multiple Brains?

A single brain works for a single concern. But a person's life has multiple concerns with different characteristics:

| Concern | Volume | Decay Rate | Content | Consumer |
|---------|--------|------------|---------|----------|
| Personal comms | High (100+/day) | Fast (14 days) | Email threads, Slack messages, meetings | Email client, comms dashboard |
| Dev projects | Medium (20-50/day) | Medium (60 days) | Architecture decisions, code patterns, bugs | Claude Code sessions, project boards |
| Business strategy | Low (5-10/day) | Slow (180+ days) | Client relationships, deals, commitments | Strategic planning, CRM |

Mixing these in one brain creates problems:
- **Volume mismatch**: 100 email facts/day drowns 5 strategy facts/day in search results
- **Decay conflict**: email should decay in 14 days, a client relationship should persist for months
- **Clustering noise**: HDBSCAN mixes "Phil's lunch email" with "Phil's $1.8M deal" because they share an entity
- **Blast radius**: if email ingestion goes wrong, it contaminates business intelligence

### The Solution: Brain Hierarchy

```
┌─────────────────────────────────────────────────────────────┐
│                     GBS Brain (strategy)                    │
│                                                             │
│   Clients, deals, pipeline, strategy, team knowledge        │
│   Fed by: subordinate brain feeds (filtered, high-quality)  │
│   Decay: 180+ days                                          │
│   Apps: strategic dashboard, CRM, pipeline view             │
│                                                             │
│   Unique capability: cross-domain intelligence              │
│   Sees patterns across personal + dev that neither can see  │
│   Reflection engine synthesizes higher-order insights       │
│                                                             │
└───────────────────┬─────────────────┬───────────────────────┘
                    │ feed            │ feed
        ┌───────────┴───┐     ┌──────┴────────┐
        │ Personal Brain│     │   Dev Brain    │
        │               │     │               │
        │ Comms: email, │     │ All projects: │
        │ Slack, meets, │     │ clawvato,     │
        │ calendar      │     │ newmail, etc. │
        │               │     │               │
        │ Decay: 14 days│     │ Decay: 60 days│
        │               │     │               │
        │ Apps: newmail, │     │ Apps: kanban, │
        │ comms hub     │     │ roadmap, CC   │
        └───────────────┘     └───────────────┘
```

Each brain is an instance of `clawvato-memory` with its own Postgres database, its own configuration, and its own Railway service. Same codebase everywhere.

### Brain-to-Brain Communication

**Feeds (upward flow):** Subordinate brains periodically publish their highest-value facts to superior brains. The personal brain publishes decisions and commitments extracted from email. The dev brain publishes architectural decisions and project milestones. The GBS brain receives pre-filtered, high-quality intelligence without touching raw data.

**Drill-down (downward, on-demand):** A superior brain can query a subordinate brain directly when it needs detail. "What exactly did Phil say in that email?" The GBS brain calls the personal brain's `retrieve_context` with the entity. Results are used in the current conversation but NOT stored in the GBS brain. The subordinate brain is the source of truth for granular data.

**Shared entity namespace:** All brains use the same entity vocabulary. "Phil Clark" is "Phil Clark" everywhere. This is what makes cross-brain queries work — you can ask any brain "what do you know about Phil Clark?" and get a coherent answer from its perspective.

```
Feed (automatic, periodic):
  Personal Brain → GBS Brain
    filter: min_importance >= 7, type in (decision, commitment, relationship)
    interval: every 6 hours

  Dev Brain → GBS Brain
    filter: type in (decision, architecture), min_importance >= 7
    interval: daily

Drill-down (on-demand, ephemeral):
  GBS Agent: "What's the latest on Acorns delivery?"
    → GBS Brain: retrieve_context (local, has high-level facts)
    → "Phil mentioned delays in an email. Want details?"
    → Owner: "yes"
    → GBS Brain queries Personal Brain: retrieve_context(entities: ["Phil Clark", "Acorns"])
    → Gets specific email summary + meeting notes
    → Presented to owner, NOT stored in GBS Brain
```

### Richer Meta-Intelligence

The GBS brain doesn't just aggregate — it **synthesizes**. Because it sees filtered feeds from both subordinate brains, it can discover patterns neither brain sees alone:

- Personal brain knows: "Phil emailed about model delivery delay"
- Dev brain knows: "Acorns API integration just succeeded, proto file parsed"
- GBS brain sees both → reflection engine produces: "Phil's delivery blocker may be resolved — the API integration he's waiting on just succeeded. Flag to owner."

This is the reflection engine running on multi-source input. It produces genuinely new intelligence that doesn't exist in any subordinate brain.

---

## Brain Configuration

Every brain is defined by a configuration file that controls its identity, inputs, processing, outputs, and connections.

### Identity

The brain's identity determines how it processes information. It's the equivalent of a `CLAUDE.md` file — it tells the brain what it is and how to operate.

```yaml
identity:
  name: "personal"
  purpose: "Real-time operational awareness across all communication surfaces"

  extraction:
    model: "claude-sonnet-4-6"
    prompt: |
      You are extracting facts from personal communications.

      EXTRACT:
      - Decisions and commitments ("I'll send the file by Thursday")
      - Action items, explicit or implied ("Can you review this?")
      - Relationship information (who works with whom, roles, preferences)
      - New information that changes understanding of a topic
      - Meeting outcomes and next steps

      DO NOT EXTRACT:
      - Pleasantries ("sounds good", "thanks!", "happy Friday")
      - Scheduling logistics ("let's move to 3pm", "joining from mobile")
      - Forwarded boilerplate, legal disclaimers, email signatures
      - Read receipts, auto-replies, calendar notifications

      Each fact should include a pointer to the source:
      - For email: gmail_thread_id
      - For Slack: slack_channel + message_ts
      - For meetings: fireflies_meeting_id

  decay:
    default_days: 14
    overrides:
      commitment: 90
      decision: 60
      relationship: 120

  domains:
    - "comms/email"
    - "comms/slack"
    - "comms/meeting"
    - "comms/calendar"
```

### Inputs

Inputs define how data enters the brain. There are four input patterns that cover every source.

#### Pattern 1: Webhook (push, real-time)

An external system pushes data to the brain's HTTP endpoint. The brain verifies the payload, fetches full content if needed, and runs extraction.

```yaml
inputs:
  - name: gmail
    type: webhook
    path: "/webhooks/gmail"
    transport: pubsub          # verification method: pubsub, hmac-sha256, generic
    config:
      topic: "projects/gbs-clawvato/topics/gmail-push"
      secret_env: "PUBSUB_VERIFICATION_TOKEN"
    fetch:                     # after receiving notification, fetch full content
      method: "gmail.users.history.list"
      then: "gmail.users.messages.get"
    domain: "comms/email"
    metadata_fields:           # attached to extracted facts for drill-down
      - gmail_thread_id
      - from
      - subject
    watch:                     # registration that must be renewed
      method: "gmail.users.watch"
      renewal_days: 6

  - name: calendar
    type: webhook
    path: "/webhooks/calendar"
    transport: google-push     # Calendar's built-in push (not Pub/Sub)
    fetch:
      method: "calendar.events.list"
      use_sync_token: true
    domain: "comms/calendar"
    metadata_fields:
      - event_id
      - start_time
      - attendees
    watch:
      method: "calendar.events.watch"
      renewal_days: 25
```

**Future webhook sources** (same pattern, different transport):
```yaml
  - name: stripe
    type: webhook
    path: "/webhooks/stripe"
    transport: hmac-sha256
    config:
      secret_env: "STRIPE_WEBHOOK_SECRET"
      header: "stripe-signature"
    domain: "business/finance"

  - name: github
    type: webhook
    path: "/webhooks/github"
    transport: hmac-sha256
    config:
      secret_env: "GITHUB_WEBHOOK_SECRET"
      header: "x-hub-signature-256"
    domain: "projects/dev"
```

#### Pattern 2: Poll (pull, scheduled)

The brain's sidecar runs a collector on a timer. Each collector is source-specific code (50-200 lines) that knows how to fetch from that API. Collectors are built-in and referenced by name.

```yaml
  - name: slack
    type: poll
    collector: "slack"         # references built-in collector
    interval_ms: 3600000       # hourly
    domain: "comms/slack"
    config:
      exclude_channels: []
      max_messages_per_channel: 500
    metadata_fields:
      - slack_channel
      - message_ts
      - thread_ts

  - name: fireflies
    type: poll
    collector: "fireflies"
    interval_ms: 3600000       # hourly
    domain: "comms/meeting"
    config:
      max_meetings: 100
    metadata_fields:
      - fireflies_meeting_id
      - meeting_date
      - participants

  - name: drive
    type: poll
    collector: "drive"
    interval_ms: 21600000      # every 6 hours
    domain: "docs/drive"
    config:
      max_files: 500
```

#### Pattern 3: Feed (subscribe to another brain)

The brain periodically queries another brain's MCP endpoint and ingests filtered results. This is how superior brains receive intelligence from subordinate brains.

```yaml
  - name: personal-feed
    type: feed
    source:
      url_env: "PERSONAL_BRAIN_URL"
      token_env: "PERSONAL_BRAIN_TOKEN"
    query:
      method: "search_memory"
      filter:
        min_importance: 7
        type: ["decision", "commitment", "relationship"]
      since: "last_sync"       # only fetch facts created since last sync
    interval_ms: 21600000      # every 6 hours
    domain: "feed/personal"
```

#### Pattern 4: Passive (external push to /ingest)

The brain exposes its `/ingest` endpoint. External systems push data to it directly. No configuration needed on the brain side — the sender controls what and when.

```yaml
  - name: journaling
    type: passive
    # No config needed. Journal hooks, CC agents, manual store_fact
    # calls all POST to /ingest or call MCP tools directly.
    # The brain just accepts whatever comes in.
```

This is how Claude Code sessions write to the brain today (via journal hook → `/ingest`). It's also how future integrations can connect without any brain-side changes.

### Processing

Processing is the same for every brain — it's the core intelligence pipeline. Configuration controls the parameters, not the logic.

```
Raw text arrives (from any input)
  → Extraction (Sonnet, using brain's identity prompt)
  → Embedding (nomic-embed-text-v1.5, 384d)
  → Dedup (3-tier: heuristic → cross-encoder → LLM)
  → Store with: entities, domain, importance, metadata, source

Background (scheduled by brain):
  → Consolidation: merge near-duplicate facts (configurable interval)
  → Reflection: synthesize higher-order insights from recent facts
  → Clustering: HDBSCAN discovers semantic groups, labels them
  → Decay: reduce importance over time (per-domain rates from identity)
  → Backfill: embed any facts missing vectors
```

### Outputs

Every brain exposes the same MCP interface over HTTP. This is the standard contract that all applications consume.

**Query tools** (read):
| Tool | Purpose |
|------|---------|
| `retrieve_context(message, token_budget)` | 7-stage retrieval pipeline: entity lookup → entity-hop → hybrid search → cluster expansion → cross-encoder rerank → soft-signal boost → token budget. The primary way to get relevant knowledge. |
| `search_memory(query, domain, type, min_importance)` | Direct keyword + semantic search with filters. For when you know what you're looking for. |
| `get_clusters(domain)` | Returns the HDBSCAN cluster hierarchy for a domain. Each cluster has a label, member count, and centroid. This is how applications get organized views of knowledge. |
| `get_cluster_stats()` | Overview of all clusters — sizes, labels, coverage. |
| `get_memory_stats()` | Health metrics — total active, by type, by domain, embedding coverage, staleness. |

**Write tools** (used by connectors and agents):
| Tool | Purpose |
|------|---------|
| `store_fact(type, content, source, domain, entities, metadata)` | Store a single fact with full metadata. Auto-embedded and dedup-checked. |
| `store_facts(facts[])` | Batch store. More efficient for bulk operations. |
| `ingest_conversation(text, source, domain)` | Send raw text for server-side extraction. The brain's Sonnet prompt handles the rest. |
| `retire_memory(id, reason)` | Soft-delete. Sets `valid_until = NOW()`. Fact is excluded from queries but not hard-deleted. |

**Session tools** (for multi-surface coordination):
| Tool | Purpose |
|------|---------|
| `update_brief(surface, content)` / `get_briefs()` | Cross-surface awareness. Each surface writes a brief, others read all briefs. |
| `update_handoff(surface, content)` / `get_handoff(surface)` | Session continuity within a surface. Full state transfer between sessions. |

**Maintenance tools** (manual triggers for background jobs):
| Tool | Purpose |
|------|---------|
| `run_consolidation()` | Merge near-duplicate facts now. |
| `run_reflection()` | Synthesize insights from recent facts now. |
| `run_clustering()` | Run HDBSCAN and label clusters now. |

### Connections

Connections define how brains communicate with each other.

```yaml
connections:
  # What this brain publishes to other brains
  publish:
    - to_env: "GBS_BRAIN_URL"
      token_env: "GBS_BRAIN_TOKEN"
      filter:
        min_importance: 7
        type: ["decision", "commitment", "relationship"]
      interval_ms: 21600000

  # What this brain allows other brains to query (drill-down)
  allow_drill_down:
    - from: "gbs"
      token_env: "GBS_DRILL_DOWN_TOKEN"
      # Drill-down results are read-only — not stored in the querying brain
```

---

## The Newmail Use Case: Brain-Powered Email Client

Newmail is the first application built on the brain platform. It demonstrates the pattern: **the brain provides intelligence, the source API provides content, the application merges both.**

### Architecture

```
┌──────────────────────────────────────────────────────────┐
│  Newmail (frontend web app)                              │
│                                                          │
│  Renders email with brain-powered organization:          │
│  - Inbox landscape (clusters from brain)                 │
│  - Thread content (from Gmail API)                       │
│  - Cross-source context (from brain entity-hop)          │
│  - Priority signals (from brain importance scores)       │
│  - Decay-based archive suggestions (from brain)          │
│                                                          │
│  Operational actions (via Gmail API):                    │
│  - Read, reply, compose, forward                         │
│  - Archive, delete, label                                │
│  - Send                                                  │
└──────────┬───────────────────────────┬───────────────────┘
           │                           │
           │ intelligence              │ content + actions
           │                           │
           ▼                           ▼
    Personal Brain               Gmail API
    (clawvato-memory)            (googleapis)

    Stores: summaries +          Stores: full email
    pointers per thread          content, attachments,
                                 threading, labels
    Provides:
    - get_clusters("comms/      Provides:
      email") → inbox groups    - threads.list/get
    - retrieve_context →        - messages.get/send
      cross-source enrichment   - threads.modify
    - importance scores         - drafts.create
    - decay signals
    - entity relationships
```

### What the Brain Stores vs. What Gmail Stores

The brain does NOT duplicate Gmail. It stores **extracted intelligence + source pointers:**

```
Brain memory (one per email thread):
  type: "fact"
  content: "Phil Clark emailed about Acorns model file delivery.
            Proto file received, API returned 200. Asking about
            next steps for multi-brand rollout."
  entities: ["Phil Clark", "Acorns", "model delivery", "multi-brand"]
  importance: 7
  domain: "comms/email"
  metadata: {
    "gmail_thread_id": "18e4f2a3b...",
    "from": "phil@acorns.com",
    "subject": "Re: Model file delivery",
    "message_count": 4
  }

Gmail (source of truth for content):
  Full thread with all messages, headers, attachments, HTML bodies,
  signatures, forwarded chains — everything.
```

When newmail renders the inbox:
1. **Brain** → `get_clusters(domain: "comms/email")` → organized groups with labels
2. **Gmail API** → `threads.get(thread_id)` for each thread in the cluster → full content
3. **Brain** → `retrieve_context(entities from thread)` → cross-source enrichment (related Slack messages, meetings)
4. **Newmail** → merges brain intelligence with Gmail content → renders

### What This Unlocks for Newmail

**Smart inbox organization:** HDBSCAN clusters emails by semantic similarity. "All the Acorns emails" group together regardless of sender or subject line changes. Gmail labels can't do this.

**Cross-source context:** When you open an email from Phil, newmail shows: "You discussed this in #acorns-internal yesterday. Meeting with DSI team covered this topic on Tuesday." The brain's entity-hop connects email → Slack → meetings automatically.

**Priority signals:** The brain knows this thread involves an active deal (importance 8, entities overlap with high-importance business facts). Newmail renders it at the top, even if the last message was "sounds good."

**Decay-based cleanup:** Threads where every associated memory has decayed below a threshold are objectively stale. Newmail surfaces: "These 47 threads have had no activity, no references from other sources, and no entity connections to active work. Archive?" The brain is the garbage collector for the inbox.

**De-duped to-dos:** Phil emails "can you send the model file?", mentions it in Slack, it comes up in a meeting. Three sources, one action item. The brain's entity-hop + dedup produces one fact with three evidence sources. Newmail renders it as one to-do.

### The General Pattern: Brain-Powered Applications

Newmail is the first, but the pattern applies to any application that wants intelligent organization of high-volume data:

| Application | Brain Domain | Source API | Intelligence Layer |
|-------------|-------------|-----------|-------------------|
| Newmail (email) | `comms/email` | Gmail API | Clusters, priorities, cross-source context, decay cleanup |
| Comms Hub (all channels) | `comms/*` | Slack + Gmail + Calendar APIs | Unified view across surfaces, de-duped action items |
| Dev Kanban | `projects/*` | GitHub API | Auto-discovered workstreams, decision log, blocker detection |
| Client CRM | `clients/*` | None (brain-native) | Relationship graph, interaction history, deal tracking |
| Strategic Dashboard | `business/*` | None (brain-native) | Cross-client patterns, pipeline health, team knowledge |

Every application follows the same architecture:
1. **Brain provides intelligence**: clusters, entities, importance, context, decay signals
2. **Source API provides content**: the raw data lives in Gmail/Slack/GitHub, not the brain
3. **Application merges both**: renders source content with brain-powered organization

The brain is never the content store. It's the index + intelligence layer. Source systems remain the source of truth for raw data.

---

## Data Flow: End-to-End

### Real-Time Path (webhook)

```
Email arrives in Gmail
  → Google Pub/Sub pushes notification to Personal Brain sidecar
  → Sidecar verifies notification
  → Sidecar calls Gmail API: users.history.list(startHistoryId)
  → Gets message IDs of new messages
  → Sidecar calls Gmail API: users.messages.get(messageId)
  → Gets subject, from, body snippet (NOT full HTML/attachments)
  → Sidecar POST to brain /ingest:
      { text: "subject + from + body snippet",
        source: "gmail:webhook",
        domain: "comms/email",
        metadata: { gmail_thread_id, from, subject } }
  → Brain extracts facts via Sonnet (using personal extraction prompt)
  → Brain embeds, deduplicates, stores
  → Brain updates historyId for next notification

  Latency: <30 seconds from email arrival to brain knowledge
```

### Scheduled Path (poll)

```
Sidecar timer fires (hourly for Slack)
  → Slack collector fetches messages since high-water mark
  → Formats as markdown chunks
  → POST to brain /ingest for each chunk
  → Brain extracts, embeds, deduplicates, stores
  → High-water mark updated

  Latency: up to 1 hour from message to brain knowledge
```

### Feed Path (brain-to-brain)

```
Personal Brain sidecar timer fires (every 6 hours)
  → Queries local brain: search_memory(since: last_sync, min_importance: 7)
  → Gets recent high-value facts
  → POST each fact to GBS Brain: store_fact(...)
  → GBS Brain deduplicates (may already have from a previous feed)
  → GBS Brain stores or updates

  Latency: up to 6 hours from personal fact to GBS knowledge
```

### Application Path (query)

```
User opens newmail
  → Newmail calls Personal Brain: get_clusters(domain: "comms/email")
  → Brain returns: 5 clusters with labels, member counts, top entities
  → Newmail calls Gmail API: threads.get() for threads in selected cluster
  → Gmail returns: full thread content
  → Newmail calls Personal Brain: retrieve_context(entities from threads)
  → Brain returns: related Slack messages, meeting notes, importance signals
  → Newmail renders: Gmail content + brain intelligence merged
```

---

## Source Pointer Architecture

Every extracted fact carries metadata that points back to its source. This enables drill-down without duplicating content.

### Metadata Schema

The memories table gets a `metadata` JSONB column (nullable, no migration risk):

```sql
ALTER TABLE memories ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT NULL;
```

Each source type produces specific metadata fields:

```
Email:     { gmail_thread_id, from, subject, message_count }
Slack:     { slack_channel, message_ts, thread_ts }
Meeting:   { fireflies_meeting_id, meeting_date, participants, duration }
Calendar:  { event_id, start_time, end_time, attendees, location }
Drive:     { drive_file_id, file_name, mime_type, modified_by }
GitHub:    { repo, issue_number, pr_number, commit_sha }
```

### Drill-Down Pattern

Applications use the metadata to fetch full content from the source API:

```
1. Brain returns: memory with metadata.gmail_thread_id = "18e4f2a3b..."
2. App calls: gmail.users.threads.get({ id: "18e4f2a3b..." })
3. App renders: full thread content with brain-provided context
```

The brain never needs to store the full content. The source API is always available for drill-down. If the source is unavailable (API down, deleted), the brain's extracted summary still provides value — you know what the email said, even if you can't read the original.

---

## Decay as Active Curation

Temporal decay isn't just forgetting — it's a signal for action.

### Decay Thresholds

```
Importance 7-10:  Active, top of mind
Importance 4-6:   Background awareness, still retrievable
Importance 1-3:   Fading, candidates for source cleanup
Importance 0:     Retired (valid_until set)
```

### Source Actions on Decay

When a memory's importance decays below a threshold, the brain can trigger actions on the source system:

```yaml
actions:
  - trigger: "decay_below"
    threshold: 2
    domain: "comms/email"
    action: "suggest_archive"    # surfaces in newmail as "archive these?"
    approval: "batch"            # owner approves in bulk

  - trigger: "decay_below"
    threshold: 1
    domain: "comms/email"
    action: "auto_archive"       # archives in Gmail automatically
    approval: "graduated"        # starts as batch, graduates to auto after 95% approval rate

  - trigger: "decay_below"
    threshold: 2
    domain: "comms/slack"
    action: "suggest_archive_channel"  # if ALL messages in a channel have decayed
    approval: "manual"
```

This creates a virtuous cycle:
1. Data enters the brain from all sources
2. Brain extracts intelligence, discards noise
3. Intelligence that stays relevant keeps high importance (re-referenced, entity-hopped)
4. Intelligence that nobody references decays
5. Decayed intelligence triggers source cleanup
6. Source surfaces get cleaner
7. Next ingestion has less noise
8. Brain stays focused on what matters

The brain becomes the **garbage collector for your entire digital workspace**.

### Graduated Trust for Automated Actions

Source actions (archiving emails, cleaning Slack) are high-stakes. The trust model:

1. **Manual**: Brain suggests, owner acts. "These 47 threads decayed. Archive?"
2. **Batch**: Brain groups suggestions, owner approves in bulk. "Archive all 47? [Yes/No]"
3. **Graduated**: After a month of 95%+ approval rate on batch suggestions, brain auto-acts. Owner can always review and override.

This mirrors the training wheels pattern already in the codebase (trust levels 0-3), just applied to source actions instead of tool permissions.

---

## Implementation Path

### Phase 1: Foundation (S26) — NEXT

Immediate work that builds toward the platform without premature abstraction:

1. **Add `metadata` JSONB column** to memories table
2. **Gmail Pub/Sub webhook** on the existing brain (personal + business mixed, that's fine for now)
3. **Calendar webhook** on the existing brain
4. **`get_clusters(domain)` MCP tool** — expose cluster hierarchy to applications
5. **Deploy sidecar as separate Railway service** with public URL
6. **Domain re-classification** — tag the 155 "general" memories with proper domains

### Phase 2: Newmail Integration (S27)

1. **Newmail calls brain** instead of LLM for categorization
2. **Brain returns clusters** → newmail renders landscape
3. **Source pointer drill-down** → newmail hydrates clusters with Gmail API content
4. **Cross-source enrichment** → brain provides Slack/meeting context alongside email
5. **Decay-based archive suggestions** → newmail surfaces cleanup candidates

### Phase 3: Brain Split (S28)

Only when the data volume justifies it:

1. **Spin up Dev Brain** — copy `projects/*` memories, configure for dev sessions
2. **Spin up Personal Brain** — receives comms webhooks, fast decay
3. **Existing brain becomes GBS Brain** — receives feeds from personal + dev
4. **Cross-brain entity queries** — GBS agent can drill down to subordinate brains
5. **Feed configuration** — personal → GBS, dev → GBS

### Phase 4: Platform Generalization (S29+)

1. **`brain.yaml` config format** — standardize brain identity + inputs + connections
2. **`init-brain` command** — one-command brain setup with config
3. **Generic webhook transport** — HMAC verification for any source
4. **Feed protocol** — standardize brain-to-brain sync
5. **Application SDK** — thin client library for brain-powered apps

---

## Scaling: From One Person to an Organization

The single-user architecture scales naturally to teams and organizations because each brain is a small, independent unit.

### Single User (now)

```
One brain (or 2-3 domain brains)
  - All sources feed in
  - All apps query from it
  - Owner sees everything
```

### Team (future)

```
Per-team brain
  - Team Slack channel, shared inbox, team meetings feed in
  - Team members query their team brain
  - Team lead approves source actions
  - Team brain publishes highlights to company brain
```

### Organization (future)

```
Hierarchy of brains
  - Company brain at the top (read-only aggregator, no raw data)
  - Department brains in the middle (team feeds)
  - Team brains at the leaf (raw source data)
  - Shared entity namespace across all brains
  - Cross-brain drill-down with access control
  - Each brain: same codebase, same interface, same tools
```

The key design choice that enables this: **the brain is the unit of deployment, not the feature.** You don't add "email support" to an existing brain — you run a brain with email configured as an input. You don't add "team support" to the platform — you run a brain per team. The code is identical at every level. Only the configuration changes.

---

## What We're NOT Building (Yet)

- **Access control between brains**: For now, bearer tokens are sufficient. Multi-tenant auth is an organization problem, not a single-user problem.
- **Real-time feed streaming**: Periodic polling (every 6h) is fine for brain-to-brain feeds. WebSocket/SSE streaming is premature.
- **Application SDK**: MCP over HTTP is the interface. A thin client library can wait until we have 3+ applications consuming it.
- **Brain orchestration layer**: A meta-service that manages brain topology. For now, each brain is independently deployed and configured.
- **Content storage in the brain**: The brain stores extracted intelligence + source pointers. Source systems store content. This is a permanent architectural principle, not a temporary limitation.

---

## Design Principles

1. **Brain stores intelligence, not content.** Source systems are the content database. The brain is the index + intelligence layer. Source pointers enable drill-down.

2. **Same codebase, different config.** Every brain runs `clawvato-memory`. What makes each brain different is its `brain.yaml`: identity, inputs, decay rates, connections.

3. **Connectors are inevitable.** Each data source has unique auth, APIs, and data formats. Don't over-abstract. A 50-200 line connector that produces `{ text, source, domain, metadata }` is the right unit.

4. **The `/ingest` contract is the universal boundary.** Everything on the input side — webhooks, polls, feeds, manual writes — eventually produces the same shape and sends it to `/ingest`. Everything on the output side consumes the same MCP tools.

5. **Feeds flow up, drill-downs flow down.** Subordinate brains publish filtered intelligence to superior brains. Superior brains query subordinate brains for detail. Never the reverse.

6. **Decay is action, not just forgetting.** When a memory decays, it can trigger cleanup on the source system. The brain is the garbage collector for the digital workspace.

7. **Don't split until you must.** One brain with domain segmentation works until volume or decay conflicts force a split. The split is a data migration, not a code change.

8. **Shared entity namespace.** "Phil Clark" means the same thing in every brain. This is what makes cross-brain queries work without a mapping layer.
