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

### Master Crawl (2x daily — 8 AM, 6 PM)

One Opus call that does everything:

```
Input:
  - ALL email from last 7 days (no domain filter — everything not spam)
  - Slack channels (recent history)
  - Fireflies transcripts (last 7 days)
  - Current brain state: all workstreams, people, entities, briefs, open items
  - Previous action brief (for continuity)

Output:
  - Updated brief per workstream (narrative state-of-play)
  - Action brief (admin-voice canvas — what to do, what to watch, what's urgent)
  - Item changes: completed, new, updated (applied directly, no proposal flow)
  - Entity/people updates (new contacts discovered)
  - Untracked activity (things that don't belong to any workstream but matter)
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

## Action Brief Format (Canvas)

The canvas replaces discrete todo lists with admin-voice workstream blocks:

```
## Vail — Onsite Prep [active, Apr 14-16]

Contracts in final stage — insurance redlines with Glenton, Aleck
pushing exception approval. Not blocking onsite.

Flights booked (Omni Interlocken). Aleck confirmed Tue-Thu.

→ Send detailed 3-day agenda to Aleck by Apr 3
  (rough outline sent Apr 2 — needs session owners + time blocks)
  ref: thread:19d4eb548261058c

→ Review Jess's measurement materials before onsite
  ref: thread:19cfbd6740bd306e

⏳ Glenton/Aleck on insurance exception approval
⏳ Jess MMM retrospective (may or may not come)
```

Key properties:
- **Human-readable** — admin briefing voice
- **Agent-parseable** — `→` items are actions, `⏳` items are monitors, `ref:` links to sources
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
