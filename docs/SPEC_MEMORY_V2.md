# Memory Architecture v2 (Research-Hardened)

## Changes from v1

1. **Triple-factor retrieval** (from Generative Agents paper): `recency × importance × relevance`
2. **Bi-temporal facts** (from Zep/Graphiti): every fact tracks `valid_from` and `valid_until`
3. **Agent-managed memory** (from MemGPT): agent has explicit tools to store/search, not just auto-injection
4. **Local embeddings** (confirmed): `@huggingface/transformers` + `all-MiniLM-L6-v2` in worker thread
5. **Hybrid retrieval** (from sqlite-vec research): FTS5 keyword search + vector similarity via Reciprocal Rank Fusion
6. **Importance scoring at write time** (from Generative Agents): rate each memory 1-10 when created
7. **Reflection/consolidation** (from Generative Agents): triggered when cumulative importance exceeds threshold

---

## Schema (SQLite)

```sql
-- Core memory store
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('fact','preference','decision','observation','reflection')),
  content TEXT NOT NULL,
  source TEXT NOT NULL,           -- e.g., 'slack:C123:1709654321', 'email:msg_abc', 'user_statement'

  -- Triple-factor scoring
  importance INTEGER NOT NULL DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
  confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence BETWEEN 0 AND 1),

  -- Bi-temporal tracking
  valid_from TEXT NOT NULL DEFAULT (datetime('now')),
  valid_until TEXT,               -- NULL = still valid

  -- Access tracking (for recency factor)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  access_count INTEGER NOT NULL DEFAULT 0,

  -- Entity references (JSON array of entity names/IDs)
  entities TEXT DEFAULT '[]',

  -- Consolidation tracking
  superseded_by TEXT REFERENCES memories(id),
  reflection_source INTEGER DEFAULT 0  -- 1 if this memory was created by reflection
);

-- FTS5 index for keyword search
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  content='memories',
  content_rowid='rowid'
);

-- Vector index for semantic search
CREATE VIRTUAL TABLE memories_vec USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[384]
);

-- People (structured, not embedded)
CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  slack_id TEXT,
  github_username TEXT,
  relationship TEXT CHECK(relationship IN ('colleague','client','vendor','friend','unknown')),
  organization TEXT,
  role TEXT,
  timezone TEXT,
  notes TEXT,
  communication_preferences TEXT,  -- JSON: { preferred_channel, response_time_hours, etc. }
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_interaction_at TEXT,
  interaction_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_people_name ON people(name);
CREATE INDEX idx_people_email ON people(email);
CREATE INDEX idx_people_slack ON people(slack_id);

-- Action log (immutable audit trail)
CREATE TABLE actions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('planned','pending_confirmation','confirmed','executing','completed','failed','rejected','undone')),
  trust_level INTEGER NOT NULL,
  request_source TEXT NOT NULL,
  request_context TEXT,
  planned_action TEXT NOT NULL,
  actual_result TEXT,
  confirmed_by_user INTEGER NOT NULL DEFAULT 0,
  undo_available_until TEXT,      -- 5-minute undo window for graduated actions
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at TEXT,
  completed_at TEXT
);

-- Training wheels pattern tracking
CREATE TABLE action_patterns (
  id TEXT PRIMARY KEY,
  pattern_hash TEXT NOT NULL UNIQUE,  -- Normalized hash of action type + key params
  action_type TEXT NOT NULL,
  description TEXT NOT NULL,          -- Human-readable pattern description
  total_occurrences INTEGER NOT NULL DEFAULT 0,
  total_approvals INTEGER NOT NULL DEFAULT 0,
  total_rejections INTEGER NOT NULL DEFAULT 0,
  total_modifications INTEGER NOT NULL DEFAULT 0,
  current_trust_level INTEGER NOT NULL DEFAULT 0,
  last_occurred_at TEXT,
  graduated_at TEXT,
  non_graduatable INTEGER NOT NULL DEFAULT 0  -- Some patterns never auto-approve
);

-- Durable workflow state
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','waiting_reply','waiting_confirmation','completed','cancelled','failed')),
  state TEXT NOT NULL,          -- JSON: serialized workflow state
  current_step INTEGER NOT NULL DEFAULT 0,
  total_steps INTEGER,
  slack_channel TEXT,
  slack_thread_ts TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,
  last_checkpoint TEXT          -- JSON: last successful step state for crash recovery
);

-- Consolidation tracking
CREATE TABLE consolidation_runs (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  memories_processed INTEGER,
  memories_merged INTEGER,
  memories_superseded INTEGER,
  memories_archived INTEGER,
  observations_promoted INTEGER,
  reflections_generated INTEGER
);
```

---

## Triple-Factor Retrieval Score

```typescript
function retrievalScore(memory: Memory, query: string, queryEmbedding: Float32Array): number {
  // Factor 1: Recency (exponential decay)
  const hoursSinceAccess = memory.last_accessed_at
    ? hoursBetween(new Date(memory.last_accessed_at), new Date())
    : hoursBetween(new Date(memory.created_at), new Date());
  const recency = Math.exp(-0.01 * hoursSinceAccess); // ~0.78 after 24h, ~0.50 after 72h

  // Factor 2: Importance (normalized 0-1)
  const importance = memory.importance / 10;

  // Factor 3: Relevance (cosine similarity from vector search, 0-1)
  const relevance = cosineSimilarity(queryEmbedding, memory.embedding);

  return recency * importance * relevance;
}
```

### Why Each Factor Matters

- **Recency alone** misses important old facts ("Andrew's scheduling preferences" set months ago)
- **Importance alone** misses what's relevant right now ("Q4 budget" rated 9/10 importance, but irrelevant when scheduling a meeting)
- **Relevance alone** misses temporal context (old meeting notes are semantically similar but outdated)
- **Combined**: a high-importance fact that was recently accessed and is semantically relevant rises to the top

---

## Importance Scoring at Write Time

```typescript
// Haiku call to rate importance when storing a new memory
const importancePrompt = `Rate the importance of this information on a scale of 1-10 for a personal AI assistant.
1 = trivial, mundane
5 = moderately useful, good to know
10 = critical, affects decisions, relationships, or workflows

Information: "${memory.content}"
Context: This was learned from ${memory.source}

Respond with just the number.`;

// Cost: ~$0.0001 per memory (Haiku)
```

---

## Reflection / Consolidation (Inspired by Generative Agents)

### Trigger: Cumulative Importance Threshold

```typescript
// After each memory insertion, check if reflection is due
let cumulativeImportance = 0;

async function maybeReflect() {
  const recentMemories = db.memories.getCreatedSince(lastReflectionTime);
  cumulativeImportance = recentMemories.reduce((sum, m) => sum + m.importance, 0);

  if (cumulativeImportance >= 50) {  // Threshold: 50 importance points
    await runReflection(recentMemories);
    cumulativeImportance = 0;
    lastReflectionTime = new Date();
  }
}
```

### Reflection Process

```typescript
async function runReflection(recentMemories: Memory[]) {
  // 1. Ask Haiku to identify high-level insights
  const prompt = `Given these recent observations, identify 3-5 high-level insights, patterns, or conclusions.
Focus on: recurring patterns, relationship dynamics, workflow opportunities, preference changes.

Recent observations:
${recentMemories.map(m => `- ${m.content} (importance: ${m.importance})`).join('\n')}

For each insight, provide:
- content: The insight in one sentence
- importance: 1-10
- type: 'reflection'`;

  const insights = await haiku(prompt);

  // 2. Store reflections as first-class memories
  for (const insight of insights) {
    await storeMemory({
      ...insight,
      type: 'reflection',
      source: `reflection:${new Date().toISOString()}`,
      reflection_source: 1,
    });
  }
}
```

### Nightly Consolidation (Enhanced)

```
NIGHTLY JOB (3am):

1. MERGE DUPLICATES
   - Group memories by entity + type
   - Use content hash for exact matches
   - Use embedding similarity > 0.95 for near-duplicates
   - Keep highest importance, merge metadata

2. TEMPORAL SUPERSESSION
   - Find contradicting facts about same entity
   - Mark older one: valid_until = newer.valid_from, superseded_by = newer.id
   - Example: "Jake is on Sales team" (Jan) → "Jake is on Marketing team" (Mar)
     → Jan record gets valid_until = Mar date

3. COMPRESS OBSERVATIONS
   - Group observations by pattern
   - If 3+ similar observations: create a reflection, mark originals as superseded
   - "Shared standup Mon" x4 → "Shares standup notes every Monday (observed 4x)"

4. DECAY STALE MEMORIES
   - Memories not accessed in 30 days: importance *= 0.9
   - Memories not accessed in 90 days: importance *= 0.7
   - Below importance 1: set valid_until = now (archived)
   - Remove from vector index (keep in SQLite for audit)

5. PROMOTE OBSERVATIONS
   - Observations with 5+ consistent data points → promote to preference
   - Tag as confidence: 0.7 (inferred, not explicit)

6. VERIFY STALE PERSON FACTS
   - Person facts older than 90 days: flag for verification
   - Next time agent acts on this fact, it asks: "I have Jake on the Sales team
     from 3 months ago. Is that still current?"

7. REBUILD VECTOR INDEX
   - Re-embed any modified memories
   - Remove archived memories from vec index
```

---

## Embedding Pipeline

### Local Model Setup

```typescript
// embedding-worker.ts — runs in a worker_threads Worker
import { parentPort } from 'worker_threads';
import { pipeline } from '@huggingface/transformers';

let extractor: any = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',  // Quantized for 2x speed on Apple Silicon
    });
  }
  return extractor;
}

parentPort?.on('message', async (msg: { id: string; texts: string[] }) => {
  const ext = await getExtractor();
  const result = await ext(msg.texts, { pooling: 'mean', normalize: true });
  parentPort?.postMessage({ id: msg.id, embeddings: result.tolist() });
});
```

### Hybrid Search (RRF)

```sql
-- Reciprocal Rank Fusion: combine FTS5 keyword + vec0 semantic
WITH fts_results AS (
  SELECT rowid AS id, row_number() OVER (ORDER BY rank) AS rank_num
  FROM memories_fts WHERE memories_fts MATCH ?1
  LIMIT 30
),
vec_results AS (
  SELECT memory_id AS id, row_number() OVER (ORDER BY distance) AS rank_num
  FROM memories_vec WHERE embedding MATCH ?2
  LIMIT 30
),
all_ids AS (
  SELECT id FROM fts_results UNION SELECT id FROM vec_results
)
SELECT
  a.id,
  COALESCE(1.0 / (60 + f.rank_num), 0) +
  COALESCE(1.0 / (60 + v.rank_num), 0) AS rrf_score,
  m.content, m.type, m.importance, m.valid_from, m.valid_until
FROM all_ids a
LEFT JOIN fts_results f ON a.id = f.id
LEFT JOIN vec_results v ON a.id = v.id
JOIN memories m ON a.id = m.id
WHERE m.valid_until IS NULL  -- Only currently-valid memories
ORDER BY rrf_score DESC
LIMIT ?3
```

---

## Cost Model (Monthly)

```
Memory extraction (Haiku, ~100 interactions/day):
  100 × $0.00025 = $0.025/day × 30 = $0.75/mo

Importance scoring (Haiku, ~50 new facts/day):
  50 × $0.0001 = $0.005/day × 30 = $0.15/mo

Reflection (Haiku, ~1 per day):
  1 × $0.001 = $0.001/day × 30 = $0.03/mo

Nightly consolidation (Haiku):
  $0.01/night × 30 = $0.30/mo

Local embeddings: $0

TOTAL MEMORY COST: ~$1.23/mo
```
