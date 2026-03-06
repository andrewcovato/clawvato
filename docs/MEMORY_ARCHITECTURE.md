# Memory Architecture: Deep Dive

## The Core Problem

```
          More memory in context
                  │
        ┌─────────┴─────────┐
        │                    │
   Better responses     Higher cost
   More personalized    Slower responses
   Fewer "who's Jake?"  Context window pollution
   moments              Needle-in-haystack degradation
                        $$$$ in token fees
```

An agent that remembers everything but dumps it all into every prompt is:
- **Expensive**: 100K tokens of memory context × $3/M input tokens × 50 requests/day = $15/day just for memory
- **Slow**: More input tokens = higher latency
- **Worse**: LLMs perform worse with irrelevant context (the "lost in the middle" problem)

An agent that remembers nothing is useless.

The goal: **right memory, right time, minimum tokens.**

---

## Architecture: Three-Tier Memory

Think of this like a CPU's memory hierarchy: registers → L1 cache → L2 cache → RAM → disk.

```
┌─────────────────────────────────────────────────────────────┐
│                      LLM CONTEXT WINDOW                     │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  TIER 0: IDENTITY  (always present, ~200 tokens)    │   │
│  │  "You are Clawvato, Andrew's AI chief of staff..."  │   │
│  │  Core preferences, active trust level, today's date │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  TIER 1: ACTIVE CONTEXT  (~300-800 tokens)          │   │
│  │  Current workflows in progress                      │   │
│  │  Today's calendar snapshot                          │   │
│  │  Recent action results (last ~2 hours)              │   │
│  │  ⟳ Refreshed every request                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  TIER 2: RETRIEVED CONTEXT  (~500-2000 tokens)      │   │
│  │  Semantic search results relevant to THIS request   │   │
│  │  People mentioned in this message                   │   │
│  │  Related past actions/decisions                     │   │
│  │  ⟳ Different every request                         │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Total memory budget: 1000-3000 tokens per request         │
│  (out of ~200K available context)                          │
└─────────────────────────────────────────────────────────────┘

         ╔═══════════════════════════════════════╗
         ║  TIER 3: DEEP STORAGE  (never auto-   ║
         ║  injected, searched on demand)         ║
         ║                                        ║
         ║  Full conversation archive             ║
         ║  Complete action history                ║
         ║  Raw email/Slack transcripts            ║
         ║  File metadata catalog                  ║
         ║                                        ║
         ║  Only accessed when agent explicitly    ║
         ║  decides: "I need to search for..."    ║
         ╚═══════════════════════════════════════╝
```

### Token Budget Per Request

```
System prompt + tools          ~2000 tokens (fixed)
Tier 0: Identity               ~200 tokens (fixed)
Tier 1: Active context          ~500 tokens (semi-fixed)
Tier 2: Retrieved context      ~1500 tokens (variable, capped)
User message + thread          ~500 tokens (variable)
─────────────────────────────────────────────
Total input                    ~4700 tokens typical

Agent response                 ~500 tokens typical
─────────────────────────────────────────────
Total per interaction          ~5200 tokens

At Sonnet pricing ($3/$15 per M tokens):
  Input cost:  4700 × $3/1M   = $0.014
  Output cost: 500 × $15/1M   = $0.008
  Per request:                   $0.022
  50 requests/day:               $1.10/day
  Monthly:                       ~$33/month
```

That's the target. Under $1.50/day for the memory layer, all-in.

---

## What Gets Stored: Facts, Not Transcripts

This is the single most important design decision.

### Bad: Storing Raw Conversations

```
Memory #4821:
  type: conversation
  content: "User said: 'hey can you find that doc I was working on
  with Sarah, the one about the Q2 projections, I think I shared it
  last Tuesday or maybe Wednesday, it was a Google Sheet not a Doc
  actually, and can you give Marcus read access to it? He's the new
  guy on the finance team, his email is marcus.w@company.com I think,
  or maybe it's marcus.wong@company.com, can you check?'"
  tokens: 89
```

This is expensive to store, expensive to retrieve, and most of it is noise.

### Good: Extracting Structured Facts

From that same conversation, extract:

```
Memory #4821: { type: "person_fact", content: "Marcus Wong is on the finance team (new hire)", confidence: 0.8 }
Memory #4822: { type: "person_fact", content: "Marcus Wong's email: marcus.wong@company.com (verified via Slack lookup)", confidence: 1.0 }
Memory #4823: { type: "action_record", content: "Gave Marcus Wong read access to 'Q2 Projections' (Google Sheet, ID: abc123)", confidence: 1.0 }
Memory #4824: { type: "relationship", content: "Sarah and Andrew collaborate on Q2 projections", confidence: 0.7 }
```

Each fact is:
- **5-20 tokens** instead of 89
- **Directly actionable** (no parsing needed at retrieval time)
- **Individually addressable** (can update Marcus's email without touching the rest)
- **Typed** (so we can filter: "give me all person_facts about Marcus")

### Memory Extraction Pipeline

```
User interaction
       │
       ▼
┌──────────────┐     ┌───────────────────────────────────┐
│  Haiku call  │     │ Extract structured facts from this │
│  ($0.00025   │────▶│ conversation. Return JSON array:   │
│   per run)   │     │ [{type, content, confidence,       │
│              │     │   entities_mentioned}]              │
└──────────────┘     └───────────────────────────────────┘
       │
       ▼
  Array of facts
       │
       ├──▶ Deduplicate against existing memories
       ├──▶ Update existing facts if new info is more confident
       ├──▶ Embed new facts (batch, not one-by-one)
       └──▶ Store in SQLite + vector store
```

**Cost of extraction**: ~$0.00025 per interaction (Haiku). Even at 100 interactions/day = $0.025/day = $0.75/month. Negligible.

---

## Memory Types and Their Lifecycle

### 1. Facts (`fact`)
Things that are true about the world.

```
"Marcus Wong works on the finance team"
"The Q2 projections spreadsheet is in /Finance/Q2/ in Google Drive"
"Company all-hands is every other Friday at 2pm"
```

**Lifecycle**: Created once, updated when contradicted, never auto-deleted.
**Retrieval**: By entity mention or semantic search.

### 2. Preferences (`preference`)
How the user likes things done.

```
"Andrew prefers meetings after 10am"
"Andrew wants email drafts reviewed before sending"
"When sharing files externally, Andrew wants view-only access by default"
```

**Lifecycle**: Learned from explicit statements or inferred from repeated behavior (5+ consistent observations). Preferences inferred from behavior have lower confidence and can be overridden.
**Retrieval**: By action type (loaded when planning a relevant action).

### 3. People (`person`)
Structured info about individuals.

```
Person: Sarah Chen
  email: sarah.chen@company.com
  slack: @sarah
  role: VP Marketing
  org: Acme Corp (internal)
  relationship: direct collaborator
  notes: "Prefers async communication. Timezone: PST."
  last_interaction: 2026-03-04
  interaction_frequency: daily
```

**Lifecycle**: Auto-created on first mention. Enriched over time. High-frequency contacts get richer profiles.
**Retrieval**: By name mention, email, or Slack ID in current message.

### 4. Observations (`observation`)
Patterns the agent notices but hasn't confirmed as preferences.

```
"Andrew usually shares the standup notes by 9:15am (observed 3/5 days this week)"
"Andrew tends to schedule meetings in 30-min blocks, not 60-min"
"Andrew has declined all Friday afternoon meetings this month"
```

**Lifecycle**: Created by background pattern analysis. Promoted to `preference` if confirmed (either explicitly or by reaching 5+ consistent observations). Deleted if contradicted.
**Retrieval**: Surfaced in proactive suggestions, not injected into regular requests.

### 5. Decisions (`decision`)
Past choices the agent should respect.

```
"Andrew decided to give the whole marketing team access to the Q2 folder (2026-02-15)"
"Andrew chose not to auto-share files with external domains (2026-01-20)"
"Andrew approved the recurring Monday standup note automation (2026-03-01)"
```

**Lifecycle**: Created when user confirms or rejects an action. High durability — only superseded by a newer contradicting decision.
**Retrieval**: When planning similar actions.

---

## Retrieval Strategy

### Step 1: Classify What's Needed (Haiku, ~$0.0001)

Before retrieving any memory, classify the request:

```typescript
type MemoryNeed = {
  people: string[];        // Names/IDs mentioned → look up in people table
  action_type: string;     // e.g., "schedule_meeting" → load relevant preferences
  time_reference: string;  // "yesterday", "last week" → bound temporal search
  needs_deep_search: boolean; // Does this require searching Tier 3?
  topic_keywords: string[]; // For semantic search
};
```

Example:
```
Message: "@clawvato can you find 30 min with Jake next week?"

MemoryNeed: {
  people: ["Jake"],
  action_type: "schedule_meeting",
  time_reference: "next_week",
  needs_deep_search: false,
  topic_keywords: ["meeting", "scheduling"]
}
```

### Step 2: Targeted Retrieval

Based on the classification, retrieve ONLY what's needed:

```typescript
async function retrieveContext(need: MemoryNeed): Promise<string> {
  const parts: string[] = [];
  let tokenCount = 0;
  const TOKEN_BUDGET = 1500;

  // 1. People lookup (structured, cheap, high value)
  for (const name of need.people) {
    const person = await db.people.findByName(name);
    if (person) {
      const summary = formatPersonSummary(person); // ~30-50 tokens
      parts.push(summary);
      tokenCount += estimateTokens(summary);
    }
  }

  // 2. Relevant preferences for this action type
  const prefs = await db.memories.findByType('preference', {
    relatedTo: need.action_type,
    limit: 5,
  });
  for (const pref of prefs) {
    if (tokenCount < TOKEN_BUDGET) {
      parts.push(`Preference: ${pref.content}`);
      tokenCount += estimateTokens(pref.content);
    }
  }

  // 3. Recent relevant decisions
  const decisions = await db.memories.findByType('decision', {
    relatedTo: need.action_type,
    limit: 3,
  });
  // ... add if budget allows

  // 4. Semantic search (only if budget remaining and topic_keywords present)
  if (tokenCount < TOKEN_BUDGET - 300 && need.topic_keywords.length > 0) {
    const semanticResults = await vectorSearch(
      need.topic_keywords.join(' '),
      { limit: 5, minScore: 0.7 }
    );
    for (const result of semanticResults) {
      if (tokenCount < TOKEN_BUDGET) {
        parts.push(result.content);
        tokenCount += estimateTokens(result.content);
      }
    }
  }

  return parts.join('\n');
}
```

### Step 3: Assemble Context (No LLM Call Needed)

```typescript
function buildPrompt(userMessage: string, need: MemoryNeed): string {
  return `
${TIER_0_IDENTITY}          // ~200 tokens, always the same

${getActiveContext()}        // ~500 tokens, Tier 1

${retrievedContext}          // ~1500 tokens max, Tier 2

User: ${userMessage}
  `.trim();
}
```

### What About Tier 3 Deep Search?

The agent itself decides when to search deeply. It's a tool call, not automatic injection:

```typescript
// The agent has a "search_memory" tool available
// It calls this when it needs more context than Tier 2 provided

tools: [{
  name: "search_memory",
  description: "Search deep memory for past interactions, decisions, or context. Use when the current context doesn't have enough information to answer the user's question.",
  parameters: {
    query: "string - what to search for",
    time_range: "optional - e.g., 'last_week', 'last_month'",
    type: "optional - fact, preference, person, decision, action",
  }
}]
```

This is critical: **Tier 3 is a tool the agent uses, not context that's auto-injected.** The agent pays the token cost only when it decides it's worth it.

---

## Memory Consolidation: Preventing Unbounded Growth

### The Problem

After 6 months of use:
- 10,000+ individual facts
- 500+ people entries
- 50,000+ action log entries
- Millions of embedding vectors

Even if each fact is only 15 tokens, you can't search 10,000 facts efficiently or retrieve them all.

### Solution: Consolidation Pipeline (runs nightly)

```
┌─────────────────────────────────────────────────┐
│           NIGHTLY CONSOLIDATION JOB              │
│           (runs at 3am, uses Haiku)              │
│                                                  │
│  1. MERGE DUPLICATES                             │
│     "Jake's email is jake@corp.com" (×3)         │
│     → Keep highest confidence, delete dupes       │
│                                                  │
│  2. SUPERSEDE CONTRADICTIONS                     │
│     "Andrew prefers 30min meetings" (Feb 2026)   │
│     "Andrew prefers 25min meetings" (Mar 2026)   │
│     → Keep newer, archive older with note         │
│                                                  │
│  3. COMPRESS OBSERVATIONS                        │
│     "Shared standup notes Mon" (×4 entries)       │
│     → Single entry: "Shares standup notes         │
│       every Monday (observed 4 times in March)"   │
│                                                  │
│  4. DECAY SCORES                                 │
│     Memories not accessed in 30 days:             │
│       relevance_score *= 0.9                      │
│     Memories not accessed in 90 days:             │
│       relevance_score *= 0.7                      │
│     Below 0.1: archive (remove from vector        │
│       index, keep in SQLite for audit)            │
│                                                  │
│  5. SUMMARIZE ACTION HISTORY                     │
│     Last week's 47 actions →                     │
│     "Week of Mar 1: Scheduled 5 meetings,        │
│      shared 12 files, sent 8 emails.             │
│      Key: onboarded Marcus to finance docs."     │
│                                                  │
│  6. PROMOTE OBSERVATIONS                         │
│     Observations with 5+ consistent data points  │
│     → Promote to preference (with note:           │
│       "inferred from behavior, not explicit")    │
│                                                  │
│  7. REBUILD VECTOR INDEX                         │
│     Re-embed any modified memories               │
│     Remove archived memories from index           │
│                                                  │
└─────────────────────────────────────────────────┘
```

### Consolidation Cost

```
Nightly job processes ~100-500 memories (day's new + decay candidates)
Haiku for dedup/merge decisions: ~$0.01 per night
Re-embedding modified memories: ~$0.005 per night
Monthly consolidation cost: ~$0.50

This is essentially free.
```

### Memory Count Over Time (Target)

```
                Without consolidation    With consolidation
Month 1:        2,000 facts             800 facts
Month 3:        8,000 facts             1,500 facts
Month 6:        20,000 facts            2,500 facts
Month 12:       50,000 facts            3,000 facts (steady state)

The consolidated store grows logarithmically, not linearly.
Key: old granular memories get compressed into summaries.
"March 2026: 47 meetings scheduled, mostly with marketing team"
replaces 47 individual action records in the active index.
```

---

## Relevance Scoring

Every memory has a relevance score that determines retrieval priority.

### Score Calculation

```
relevance_score = base_score
                  × recency_weight
                  × access_frequency_weight
                  × confidence_weight

Where:
  base_score:
    preference  = 1.0  (always highly relevant when matched)
    decision    = 0.9  (important for consistency)
    person_fact = 0.8  (important for personalization)
    fact        = 0.6  (useful but often generic)
    observation = 0.4  (unconfirmed, lower priority)

  recency_weight:
    last 24h   = 1.0
    last 7d    = 0.9
    last 30d   = 0.7
    last 90d   = 0.5
    older      = 0.3

  access_frequency_weight:
    accessed 10+ times = 1.0
    accessed 5+ times  = 0.8
    accessed 1-4 times = 0.6
    never accessed      = 0.4

  confidence_weight:
    1.0 (verified/explicit) = 1.0
    0.8 (high confidence)   = 0.9
    0.5 (inferred)          = 0.7
    0.3 (speculative)       = 0.5
```

### Retrieval Threshold

```
Memories with final relevance_score < 0.15 are never auto-retrieved.
They remain searchable via the search_memory tool but won't appear in Tier 2.

This prevents ancient, low-confidence, rarely-accessed facts from
polluting context. "Andrew mentioned liking sushi once 8 months ago"
won't show up in a meeting scheduling request.
```

---

## Embedding Strategy

### What Gets Embedded

Not everything. Embeddings are for semantic search — structured lookups don't need them.

```
EMBEDDED (for semantic/fuzzy retrieval):
  ✓ Facts
  ✓ Decisions
  ✓ Observations
  ✓ Summarized action history

NOT EMBEDDED (retrieved by structured query):
  ✗ People (looked up by name, email, Slack ID — exact match)
  ✗ Preferences (looked up by action_type — exact match)
  ✗ Active workflows (looked up by status — exact match)
  ✗ Raw action log (looked up by date, type — exact match)
```

### Embedding Model Choice

```
Option A: Anthropic API embeddings (if/when available)
  Pro: Same vendor, consistent
  Con: API cost per embed, network latency

Option B: Local embedding model (recommended)
  Model: all-MiniLM-L6-v2 (via @xenova/transformers or fastembed)
  Dimensions: 384
  Speed: ~1ms per embedding on Apple Silicon
  Cost: $0 (runs locally)
  Quality: Good enough for memory retrieval (not doing academic IR)

Recommendation: LOCAL EMBEDDINGS
  - Zero marginal cost (critical for an always-on agent)
  - No network latency
  - No API dependency for a core function
  - 384 dimensions vs 1536 means smaller vector index too
```

### Embedding at Ingest Time

```typescript
// After Haiku extracts facts from a conversation:

async function ingestFacts(facts: ExtractedFact[]) {
  // Batch embed locally (< 5ms for typical batch)
  const embeddings = await localEmbed(facts.map(f => f.content));

  // Store in SQLite + vector index
  for (let i = 0; i < facts.length; i++) {
    const id = generateId();

    // Structured storage
    db.memories.insert({
      id,
      type: facts[i].type,
      content: facts[i].content,
      source: facts[i].source,
      confidence: facts[i].confidence,
      relevance_score: calculateInitialScore(facts[i]),
      created_at: now(),
    });

    // Vector storage (for semantic search)
    if (shouldEmbed(facts[i].type)) {
      db.memoryEmbeddings.insert({
        memory_id: id,
        embedding: embeddings[i],
      });
    }
  }
}
```

---

## The "Right Memory at Right Time" Algorithm

Putting it all together — what happens when a message comes in:

```
"@clawvato can you share the budget spreadsheet with Marcus?"
                              │
                              ▼
┌──────────────────────────────────────────────────────────┐
│  STEP 1: CLASSIFY (Haiku, ~$0.0001)                     │
│                                                          │
│  Intent: file_share                                      │
│  Entities: ["Marcus", "budget spreadsheet"]              │
│  Memory needs: people lookup, file search, preferences   │
│  Deep search needed: no                                  │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  STEP 2: RETRIEVE (no LLM call — pure DB queries)       │
│                                                          │
│  a. People lookup: "Marcus"                              │
│     → Marcus Wong, marcus.wong@company.com, Finance team │
│     → 30 tokens                                          │
│                                                          │
│  b. Preferences for "file_share":                        │
│     → "Default to view-only for external shares"         │
│     → "Always confirm before sharing"                    │
│     → 25 tokens                                          │
│                                                          │
│  c. Semantic search: "budget spreadsheet"                │
│     → "Q2 Budget spreadsheet is in /Finance/Budgets/"    │
│     → "Shared Q2 budget with Sarah on Mar 1"             │
│     → 35 tokens                                          │
│                                                          │
│  d. Recent decisions (file_share type):                  │
│     → "Gave Marcus read access to Q2 Projections (Mar 3)"│
│     → 20 tokens                                          │
│                                                          │
│  TOTAL RETRIEVED: 110 tokens  (well under 1500 budget)   │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  STEP 3: BUILD PROMPT (no LLM call)                     │
│                                                          │
│  [System: Tier 0 identity, 200 tokens]                   │
│  [Active context: 2 in-progress workflows, 300 tokens]   │
│  [Retrieved memory: 110 tokens]                          │
│  [User message: 15 tokens]                               │
│  [Tools: MCP tool definitions, ~1500 tokens]             │
│                                                          │
│  TOTAL INPUT: ~2125 tokens                               │
│  COST: $0.006 (Sonnet input)                             │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  STEP 4: AGENT EXECUTES (Sonnet, 1-3 tool calls)        │
│                                                          │
│  Agent knows:                                            │
│  - Marcus is marcus.wong@company.com (from memory)       │
│  - Budget spreadsheet is in /Finance/Budgets/ (from mem) │
│  - User prefers view-only for shares (from preferences)  │
│  - Marcus already has access to related Q2 docs (context)│
│                                                          │
│  Agent plans: search Drive for "budget" in /Finance/,    │
│  confirm with user, share with Marcus as viewer          │
└────────────────────────┬─────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────┐
│  STEP 5: POST-ACTION MEMORY UPDATE (Haiku, ~$0.0001)    │
│                                                          │
│  Extract: "Shared 'FY26 Budget.xlsx' with Marcus Wong    │
│            as viewer on March 5, 2026"                   │
│  Store as action_record, confidence: 1.0                 │
│  Update Marcus's last_interaction_at                     │
│  Update interaction_count                                │
└──────────────────────────────────────────────────────────┘

TOTAL COST OF THIS INTERACTION: ~$0.02
```

---

## Handling the Tricky Cases

### Case 1: "What was that thing we discussed last month?"

Vague query → needs Tier 3 deep search.

```
1. Classifier detects: needs_deep_search = true
2. Agent's first action is a search_memory tool call:
   search_memory({ query: "discussed last month", time_range: "last_month" })
3. Returns top 10 semantic matches from full archive
4. Agent synthesizes: "Last month you discussed several things.
   The main topics were: Q2 planning with Sarah, the new hire
   onboarding process, and the client proposal for Acme Corp.
   Which one are you thinking of?"
5. Two LLM calls total (classify + respond), not 10.
```

### Case 2: Contradictory Information

```
Memory from January: "Weekly sync with Sarah is Tuesdays at 10am"
Memory from March:   "Weekly sync with Sarah is Wednesdays at 11am"

Resolution rules:
  1. More recent wins (if same confidence level)
  2. Higher confidence wins (if same recency)
  3. Explicit statement > inferred observation
  4. If truly ambiguous: ask the user

Consolidation job handles this:
  → Archives January entry with note "superseded"
  → Marks March entry as authoritative
```

### Case 3: Memory Gets Stale

```
"Marcus Wong works on the finance team" — stored 6 months ago.
Marcus may have changed teams. How do we handle this?

Options:
  a. Confidence decay over time (confidence *= 0.95 monthly for person facts)
  b. Re-verify on use: if a person fact is >3 months old and we're about
     to act on it, flag it: "I have Marcus on the finance team from 6 months
     ago. Is that still current?"
  c. Cross-reference signals: if Marcus starts appearing in #engineering
     Slack channels, observation triggers a review

Recommended: Combine (a) and (b).
  - Facts decay naturally in relevance score
  - Before acting on low-confidence person facts, verify
  - Verification is cheap (one Slack confirmation) vs. wrong action (expensive)
```

### Case 4: Too Many Memories Match

```
Query: "meetings" → 500 memories match semantically.

Protection: relevance threshold + hard limit.

  1. Semantic search returns top 20 by vector similarity
  2. Filter by relevance_score > 0.3 → maybe 8 remain
  3. Re-rank by (similarity × relevance_score) → top 5
  4. Apply token budget: take as many as fit in 1500 tokens
  5. Typically 3-7 memories make it into context

The agent always has the search_memory tool for when top-5 isn't enough.
```

---

## Cost Summary

### Per Interaction
```
Classification (Haiku):          $0.0001
Memory retrieval (DB queries):   $0.0000  (local, no API)
Local embedding (if needed):     $0.0000  (local model)
Agent execution (Sonnet):        $0.015-0.025
Post-action extraction (Haiku):  $0.0001
──────────────────────────────────────────
Typical interaction:             ~$0.02
```

### Daily (50 interactions)
```
Interactions: 50 × $0.02        = $1.00
Planning calls (Opus, ~5/day):  = $0.50  (complex tasks only)
──────────────────────────────────────────
Daily total:                      ~$1.50
```

### Monthly
```
Daily interactions:              $45
Nightly consolidation:           $0.50
Weekly pattern analysis:         $1.00
──────────────────────────────────────────
Monthly total:                   ~$47
```

### Scaling Comparison

```
                     Naive approach        This architecture
                     (dump all memory)     (tiered retrieval)

Month 1 cost:        $50/mo               $47/mo
Month 6 cost:        $200/mo              $50/mo
Month 12 cost:       $500+/mo             $52/mo
Performance:         Degrades over time    Stable
Relevance:           Low (needle in hay)   High (targeted)
```

The naive approach costs scale LINEARLY with memory size (more tokens per request).
This architecture costs are nearly CONSTANT because retrieval is bounded.

---

## Implementation Priority

For the MVP (Phase 6 in main spec), implement in this order:

1. **Fact extraction pipeline** (Haiku post-interaction) — this is the input
2. **People table** (structured, not embedded) — highest value per token
3. **Preferences table** (structured, by action type) — enables personalization
4. **Token-budgeted retrieval** — the hard cap prevents cost blowup
5. **Local embeddings + semantic search** — fuzzy matching for facts
6. **Nightly consolidation** — prevents unbounded growth
7. **Relevance scoring + decay** — keeps retrieval quality high over time
8. **Proactive pattern detection** — the "amazing" differentiator
