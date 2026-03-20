# Design: Proactive Memory & Intelligent Context Assembly

> Status: Draft | Author: Andrew + Claude | Date: 2026-03-20

## Problem Statement

The agent's memory is reactive — it only learns from conversations it's part of. The owner has hundreds of Slack messages, emails, meeting transcripts, and documents across channels and tools that the agent has never seen. When asked broad analytical questions ("analyze our GTM strategy last quarter"), the agent lacks the context to answer without doing a slow, expensive real-time sweep.

Additionally, the deep path currently acts as both researcher and analyst — it makes 20+ tool calls to gather data, then reasons about it. This is slow (~15 min) and fragile (sandbox issues, credential gaps, MCP overhead).

## Design Principles

1. **Memory is the product.** The richer the memory, the more useful the agent. Investment in memory quality pays compound returns.
2. **Separate data gathering from reasoning.** The deep path should be a pure thinking engine. All data should be pre-loaded.
3. **One memory paradigm.** Everything is a fact in the memories table. No special tables, no bespoke tools.
4. **Incremental, not batch.** Sweeps process only new content since the last sweep. Backfill is an explicit operation.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    USER MESSAGE                          │
│                         │                                │
│                    ┌────▼────┐                           │
│                    │ ROUTER  │ Haiku                     │
│                    │FAST/MED │                           │
│                    │  /DEEP  │                           │
│                    └────┬────┘                           │
│                         │                                │
│         ┌───────────────┼───────────────┐                │
│         │               │               │                │
│    ┌────▼────┐    ┌─────▼─────┐   ┌─────▼─────┐         │
│    │  FAST   │    │  MEDIUM   │   │   DEEP    │         │
│    │ Sonnet  │    │ Opus API  │   │ Opus CLI  │         │
│    │ Direct  │    │ Orchestr. │   │ Pure      │         │
│    │ answer  │    │ + answer  │   │ reasoning │         │
│    └─────────┘    └─────┬─────┘   └─────▲─────┘         │
│                         │               │                │
│                    ┌────▼────┐    ┌──────┴──────┐        │
│                    │ Context │    │  Workspace  │        │
│                    │ Planner │    │  context/   │        │
│                    │ (Opus)  │    │  findings/  │        │
│                    └────┬────┘    └─────────────┘        │
│                         │                                │
│              ┌──────────▼──────────┐                     │
│              │   Memory + Tools    │                     │
│              │  search, gmail,     │                     │
│              │  slack, fireflies   │                     │
│              └─────────────────────┘                     │
│                                                          │
│  ════════════════════════════════════════════════════     │
│                  BACKGROUND (async)                       │
│                                                          │
│    ┌─────────────┐     ┌──────────────┐                  │
│    │  Scheduled   │     │   Sweep      │                 │
│    │  Sweep Task  │────▶│  Executor    │                 │
│    │  (every Nh)  │     │              │                 │
│    └─────────────┘     └──────┬───────┘                  │
│                               │                          │
│              ┌────────────────▼────────────────┐         │
│              │  Source Collectors               │         │
│              │  Slack channels, Gmail, FF       │         │
│              │  (incremental, high-water mark)  │         │
│              └────────────────┬────────────────┘         │
│                               │                          │
│                        ┌──────▼──────┐                   │
│                        │  Workspace  │                   │
│                        │  .md files  │                   │
│                        └──────┬──────┘                   │
│                               │                          │
│                        ┌──────▼──────┐                   │
│                        │  Opus       │                   │
│                        │  Synthesis  │                   │
│                        │  (deep CLI) │                   │
│                        └──────┬──────┘                   │
│                               │                          │
│                        ┌──────▼──────┐                   │
│                        │  Memory DB  │                   │
│                        └─────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

## Component Design

### 1. Background Sweep System

**Purpose:** Continuously populate memory from Slack, Gmail, and Fireflies so the agent has rich context without on-demand research.

**Implementation:**
- Recurring scheduled task (configurable per source, default every 6h)
- Each source has a **collector** that fetches new content since last sweep
- High-water marks stored in `agent_state` (e.g., `sweep:slack:C0AMELZCDLP:last_ts`)
- Collectors write raw content to workspace `.md` files (one per source batch)
- After all collectors finish, a single Opus deep path synthesizes all `.md` files into atomic facts
- Facts stored to memory via standard extraction + dedup pipeline

**Source Collectors:**

| Source | Collector | Incremental Key | Tools Used |
|--------|-----------|-----------------|------------|
| Slack channels | `slack_get_channel_history` per channel | `last_ts` per channel | Fast path (user token) |
| Gmail | `google_gmail_search` + `google_gmail_read` | `after:YYYY/MM/DD` date | Fast path |
| Fireflies | `fireflies_search_meetings` | `days_back` from last sweep | Fast path |

**Sweep configuration** (in `config/default.json`):
```json
{
  "sweep": {
    "enabled": true,
    "intervalHours": 6,
    "sources": {
      "slack": {
        "enabled": true,
        "channels": ["C0AMELZCDLP", "C0AN5J0LCP3"],
        "maxMessagesPerChannel": 200
      },
      "gmail": {
        "enabled": true,
        "maxThreads": 50
      },
      "fireflies": {
        "enabled": true,
        "maxMeetings": 10
      }
    }
  }
}
```

**Backfill:** Ad hoc via owner command ("backfill Slack from January") or CC session. Uses the same collectors with a custom time range.

### 2. Context Planner (Medium Path Enhancement)

**Purpose:** When the router decides DEEP, the medium path first plans and assembles the context the deep path will need.

**Current flow:**
```
Router → DEEP → preflight → deep path (gathers data + reasons)
```

**New flow:**
```
Router → DEEP → medium path context planning → preflight → deep path (pure reasoning)
```

**Context planning steps (Opus API, ~10-15s):**

1. **Assess coverage:** "Given this question, what categories of facts do I need?" Generate a list of retrieval queries.
2. **Execute queries:** Run each query against memory (search_memory, entity search). Fast — no external API calls if sweeps have populated memory.
3. **Identify gaps:** "Do I have enough? What's missing?" If critical gaps exist, run targeted fast-path tool calls (e.g., search Gmail for specific invoices).
4. **Optional mini-sweep:** If the gap is broad ("I have no Slack data from #product"), run an incremental sweep of that specific channel before proceeding.
5. **Assemble workspace:** Write curated context to `workspace/context/` files. Write the original question + any preflight refinements.
6. **Hand off:** Deep path runs with pre-loaded context. Zero tool calls needed for data gathering.

**Key insight:** Steps 2-4 use the fast path tools that the medium path already has access to. No new infrastructure needed — just orchestration logic.

### 3. Deep Path as Pure Reasoning Engine

**Purpose:** The deep path stops making tool calls for data gathering. It receives a fully-loaded workspace and focuses on analysis, synthesis, and response generation.

**What changes:**
- Workspace `context/` contains curated, relevant facts (not raw memory dump)
- Deep path prompt simplified: "Your context is complete. Analyze and respond."
- `--allowedTools` reduced: drop `Bash(gws:*)`, `Bash(npx:*)`, keep `Read` (workspace files), MCP memory (for store_fact if needed during analysis)
- Faster execution: no external API calls, no sandbox credential issues

**What stays:**
- Deep path can still write to `workspace/findings/` for facts discovered during analysis
- Deep path can still use `search_memory` via MCP for follow-up lookups
- The "research-heavy" deep path mode remains available for ad hoc requests ("search my email for X") — context planner decides whether to pre-fetch or let deep path research

### 4. Sweep Synthesis (Opus Deep Path)

**Purpose:** After collectors dump raw content from multiple sources, a dedicated deep path instance cross-references and synthesizes everything into atomic facts.

**Input:** Workspace with raw `.md` files from all source collectors
**Output:** Single `findings.md` with cross-referenced, deduplicated atomic facts
**Model:** Opus via CLI ($0 on Max plan)

**Synthesis prompt responsibilities:**
- Cross-reference across sources (Slack + email + meeting about the same topic)
- Deduplicate (same info mentioned in Slack and email)
- Validate (if something seems off, flag it rather than storing bad data)
- Produce atomic facts with proper entity tags
- Set appropriate importance/confidence scores

## Data Flow Examples

### Example 1: "Analyze our GTM strategy last quarter"

```
1. Router: DEEP
2. Medium path (context planner):
   - Needs: client wins/losses, product launches, marketing decisions, revenue data
   - Queries memory: search "GTM", "launch", "client", "Q4", entity search for known clients
   - Finds 30 relevant facts from recent sweeps
   - Gap: no revenue numbers → searches Gmail for "revenue report Q4"
   - Assembles 35 facts into workspace/context/analysis_context.md
3. Deep path:
   - Reads context file (one Read call)
   - Pure analysis: identifies patterns, strengths, weaknesses
   - Writes response to Slack
   - Writes findings.md with synthesized insights
```

### Example 2: Background sweep (every 6h)

```
1. Scheduler triggers sweep task
2. Collectors run (fast path, ~30s each):
   - Slack: 3 channels × 50 new messages = raw_slack.md
   - Gmail: 20 new threads = raw_gmail.md
   - Fireflies: 2 new meetings = raw_fireflies.md
3. Opus synthesis (deep path, ~3-5 min):
   - Reads all 3 files
   - Cross-references: "Sarah mentioned the Vail delay in Slack AND sent a revised SOW"
   - Produces 45 atomic facts
4. Facts stored to memory with embeddings
5. High-water marks updated
```

### Example 3: Ad hoc lookup with gap

```
1. "How much did we pay Fieldwork last quarter?"
2. Router: MEDIUM
3. Medium path:
   - Searches memory for "Fieldwork" + "invoice" + "payment"
   - Found: nothing (not yet swept)
   - Searches Gmail: `from:fieldwork invoice`
   - Finds 3 invoice threads, reads them
   - Answers directly: "$45K across 3 invoices"
   - Stores facts to memory for next time
```

## Migration Path

This design is additive — it enhances the existing architecture without breaking it.

### Phase 1: Background Sweeps (Track M)
- Source collectors for Slack, Gmail, Fireflies
- High-water mark tracking in agent_state
- Workspace-based synthesis via existing deep path
- Recurring task via existing scheduler
- Configuration in default.json

### Phase 2: Context Planner (Track N)
- Medium path pre-fetch logic before deep path handoff
- Memory query planning (Opus API)
- Gap detection + targeted mini-sweeps
- Workspace assembly from memory queries
- Deep path prompt simplification

### Phase 3: Deep Path Pure Mode (Track N continued)
- Reduce allowedTools for analysis-only tasks
- Context planner decides research vs. analysis mode
- Router hints (DEEP_RESEARCH vs DEEP_ANALYSIS)

### 5. Relationship-Aware Extraction

**Purpose:** Facts should capture not just what happened, but how entities relate. This allows the agent to traverse connections without re-learning them each time.

**Current state:** Extraction produces flat facts with entity tags. Tags create weak links (both mention "Sarah") but no explicit relationships.

**Enhancement:** The Opus synthesis step (sweep or context planner) SHOULD produce relationship-aware facts:

Instead of:
```
fact: "Sarah Chen is VP Marketing at Acorns"
fact: "Sarah sent revised SOW to Vail"
```

Produce:
```
fact: "Sarah Chen is VP Marketing at Acorns and the primary contact for the Vail engagement. She sent a revised SOW to Vail on 2026-03-15 due to timeline slippage caused by data access delays."
  entities: ["Sarah Chen", "Acorns", "Vail"]
```

The richer fact captures the relationship in natural language. The entity tags ensure it surfaces when querying any of the three entities. No schema changes needed — the relationship is in the content, and the entity tags are the index.

**Why not a relationship table?** We considered `memory_relationships (source_entity, relationship, target_entity)` but this violates the "one memory paradigm" principle. Natural language facts with good entity tags achieve the same result without extra schema. The agent reads "Sarah Chen is VP Marketing at Acorns and primary contact for Vail" and understands the relationships natively.

**Implementation:** Update the synthesis prompt to explicitly request relationship-aware facts. The extraction prompt for real-time (Haiku) stays focused on atomic facts — relationships are synthesized by Opus during sweeps when it has cross-source context.

### 6. Shared Brain via MCP

**Purpose:** The Postgres memory database is accessible from any Claude surface — Slack agent, Claude Code sessions, future plugins — via the MCP memory server.

**Current state:** The MCP memory server (`src/mcp/memory/server.ts`) already exposes search_memory, store_fact, retrieve_context, update_working_context over stdio. The deep path connects to it via `--mcp-config`.

**For Claude Code sessions:** A CC session connects to the same MCP server, pointed at the same Postgres. It can search the agent's memory, store facts from code work, and share context bidirectionally.

**MCP config for CC sessions:**
```json
{
  "mcpServers": {
    "clawvato-memory": {
      "command": "npx",
      "args": ["tsx", "src/mcp/memory/stdio.ts"],
      "env": { "DATABASE_URL": "..." }
    }
  }
}
```

**What this enables:**
- CC session asks "what do we know about the Vail engagement?" → searches agent memory
- CC session discovers a bug fix → stores "Fixed race condition in event queue" as a technical fact
- Slack agent later retrieves this fact when owner asks about recent changes
- Future plugins (GitHub, finance) write to the same brain

**No new infrastructure needed.** The MCP server exists. Postgres is the shared brain. The only work is documenting the CC integration pattern and ensuring the MCP server handles concurrent connections cleanly.

## Migration Path

This design is additive — it enhances the existing architecture without breaking it.

### Phase 1: Background Sweeps (Track M)
- Source collectors for Slack, Gmail, Fireflies
- High-water mark tracking in agent_state
- Workspace-based synthesis via existing deep path
- Recurring task via existing scheduler
- Configuration in default.json
- Relationship-aware synthesis prompt

### Phase 2: Context Planner (Track N)
- Medium path pre-fetch logic before deep path handoff
- Memory query planning (Opus API)
- Gap detection + targeted mini-sweeps
- Workspace assembly from memory queries
- Deep path prompt simplification

### Phase 3: Deep Path Pure Mode (Track N continued)
- Reduce allowedTools for analysis-only tasks
- Context planner decides research vs. analysis mode
- Router hints (DEEP_RESEARCH vs DEEP_ANALYSIS)

### Phase 4: CC Memory Bridge (Track H / PLUGIN-001)
- Document MCP config for Claude Code sessions
- Test concurrent MCP server connections
- Bidirectional memory sharing (CC ↔ Slack agent)

## Open Questions

1. **Sweep channel list:** Static config vs. auto-discover from Slack? Start static, graduate to auto.
2. **Synthesis model:** Always Opus CLI, or Haiku for simple batches? Start with Opus, measure cost.
3. **Sweep frequency:** Per-source or global? Start global (every 6h), per-source later.
4. **Context planner timeout:** How long can medium path spend assembling context before it's slower than letting deep path research? Target: 30s max.
5. **Conflict resolution:** When sweep finds a fact that contradicts existing memory, which wins? Newer source wins (supersede with higher confidence).
6. **CC concurrent access:** Does the MCP server handle multiple simultaneous connections to the same Postgres? Likely yes (postgres.js pools), but needs testing.
