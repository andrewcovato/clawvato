# Memory Compression Research — Pre-Track C Synthesis

> Compiled March 2026. This document synthesizes published research and production implementations relevant to Clawvato's memory system (Track C). Each section includes concrete schema changes, formulas, and implementation recommendations.

---

## 1. Progressive Summarization

### How MemGPT/Letta Does It

MemGPT implements a three-tier memory hierarchy inspired by OS virtual memory:

- **Core Memory** (in-context, ~2,000 chars): Always-visible, self-editable via tool calls.
- **Recall Memory** (auto-persisted conversation history): Raw conversation stored to disk, searchable.
- **Archival Memory** (semantic long-term store): Processed, indexed information queried on demand.

The compression mechanism is **recursive summarization** via a queue manager. When prompt tokens exceed a flush threshold, the queue manager evicts 50-70% of messages and generates a new summary by combining the *existing* recursive summary with newly evicted messages. Over time, older messages have progressively less influence.

### Time-Windowed Compression for Clawvato

Map this to a nightly consolidation pipeline:

```
Raw memories (0-24h)     → kept as-is
Daily summary (1-7d)     → Haiku compresses day's facts into 3-5 bullet summaries
Weekly summary (1-4w)    → Sonnet consolidates 7 daily summaries into thematic digest
Monthly summary (1-12m)  → Sonnet produces a paragraph-level narrative per month
Archive (12m+)           → Single-sentence reference, full text searchable in archival store
```

### Achievable Compression Ratios

- Atomic fact extraction (conversation to facts): ~5-10x compression
- Daily to weekly: ~5-7x (7 daily summaries of ~100 tokens to ~100-150 tokens)
- Weekly to monthly: ~4x (4 weekly summaries to a single paragraph)
- Cumulative: 50,000 tokens/year of raw facts compresses to ~3,000 tokens of active memory

### References

- MemGPT: Towards LLMs as Operating Systems (arXiv 2310.08560)
- Letta Memory Management Documentation (docs.letta.com)

---

## 2. Sentiment-Preserving Compression

### The DAM-LLM Framework (Lu & Li, October 2025)

The most directly relevant published work is "Dynamic Affective Memory Management for Personalized LLM Agents" (arXiv 2510.27418). It maintains a probability distribution over sentiment polarities per memory unit:

```json
{
  "object_id": "project-q2-budget",
  "sentiment_profile": { "positive": 0.7, "negative": 0.1, "neutral": 0.2 },
  "H": 1.16,
  "summary": "Budget project generally going well, some timeline concerns"
}
```

**Bayesian update formula when new evidence arrives:**

```
C_new = (C * W + S * P) / (W + S)
W_new = W + S
```

Where `C` = current confidence vector, `W` = prior weight, `S` = evidence strength, `P` = new observation's sentiment profile. The system converges to stable sentiment within ~10 interactions.

**Entropy-driven compression triggers:**
- `H(m) = -SUM(p_k * log2(p_k))` for k in {positive, negative, neutral}
- Low entropy (H < 0.8): mature, confident memory
- High entropy (H > 1.4): uncertain memory, triggers optimization

### Schema Extension

```sql
ALTER TABLE memories ADD COLUMN sentiment_polarity TEXT
  CHECK(sentiment_polarity IN ('positive','negative','neutral','mixed'));
ALTER TABLE memories ADD COLUMN sentiment_confidence REAL DEFAULT 0.5
  CHECK(sentiment_confidence BETWEEN 0 AND 1);

ALTER TABLE people ADD COLUMN relationship_sentiment TEXT DEFAULT 'neutral'
  CHECK(relationship_sentiment IN ('positive','negative','neutral','mixed'));
ALTER TABLE people ADD COLUMN sentiment_evidence_count INTEGER DEFAULT 0;
ALTER TABLE people ADD COLUMN sentiment_last_updated TEXT;
```

The Bayesian update runs during Haiku's post-interaction extraction step.

### References

- Dynamic Affective Memory Management for Personalized LLM Agents (arXiv 2510.27418)
- Cognitive Memory in Large Language Models (arXiv 2504.02441v1)

---

## 3. Distillation vs. Summarization

### Key Distinction

| Aspect | Summarization | Distillation |
|--------|--------------|-------------|
| Input | 3 scheduling interactions with Sarah | Same events |
| Output | "First week of March: scheduled 3 meetings" | "Andrew prefers 30-min morning slots, books via Slack DM" |
| Memory type | `reflection` (event summaries) | `preference` or `fact` (learned knowledge) |
| Lifecycle | Replaces raw events, decays over time | Persists until contradicted |

Summarization compresses narrative ("what happened?"). Distillation extracts reusable knowledge ("what did I learn?").

### Letta's Vision

Letta's roadmap describes full distillation: "memories in token space eventually distilled into model weights" via SFT or RL. For Clawvato's purposes, distillation means our existing observation-to-preference promotion pipeline: after 5+ consistent observations, the pattern gets distilled into a preference.

### Implementation

Formalize this by tagging the source:

```sql
ALTER TABLE memories ADD COLUMN derived_from TEXT;  -- comma-separated source memory IDs
ALTER TABLE memories ADD COLUMN derivation_type TEXT
  CHECK(derivation_type IN ('summarized','distilled','reflected'));
```

Summarized memories replace event sequences. Distilled memories represent learned patterns extracted from multiple events.

### References

- Continual Learning in Token Space (Letta blog)
- Letta Memory Management Documentation

---

## 4. Reflexion and Entity-Scoped Reflection

### Reflexion (Shinn et al., NeurIPS 2023)

Reflexion implements "verbal reinforcement learning" where agents store natural language reflections as episodic memory. Three components:

1. **Actor**: Generates actions, producing a trajectory
2. **Evaluator**: Scores the trajectory
3. **Self-Reflection**: LLM generates verbal feedback stored in memory buffer

Key result: 91% pass@1 on HumanEval (vs GPT-4's 80%) by injecting prior reflections into prompts.

### Generative Agents (Park et al., 2023)

Reflections are triggered when cumulative importance score of recent memories exceeds a threshold (~2-3x per simulated day). The 100 most recent memories generate "3 most salient high-level questions" which produce insights stored as elevated-importance memories.

### Entity-Scoped Reflection for Clawvato

Rather than global reflections, scope to specific entities:

**Per-person:** "Sarah prefers async communication, most responsive 10am-2pm PST, calendar invites should include agenda bullets."

**Per-project:** "Q2 Budget involves Sarah (lead), Marcus (data). Spreadsheets in /Finance/Q2/. Andrew reviews before external sharing."

**Trigger query:**

```sql
SELECT
  json_each.value as entity,
  SUM(importance) as total_importance,
  COUNT(*) as memory_count
FROM memories, json_each(memories.entities)
WHERE created_at > datetime('now', '-7 days')
GROUP BY json_each.value
HAVING total_importance > 50
  AND memory_count >= 10;
```

When an entity crosses the threshold, generate a scoped reflection via Haiku and store as type `reflection` with that entity tagged.

### References

- Reflexion: Language Agents with Verbal Reinforcement Learning (NeurIPS 2023, arXiv 2303.11366)
- Generative Agents: Interactive Simulacra of Human Behavior (arXiv 2304.03442)

---

## 5. ACT-R-Inspired Decay

### What ACT-R Actually Says

ACT-R (Carnegie Mellon) uses a **power law** for memory activation:

```
B_i = ln( SUM_{j=1}^{n} t_j^{-d} )
```

Where `n` = prior retrievals, `t_j` = time since j-th retrieval, `d` = decay parameter (default **0.5**).

Key properties:
- Both frequency and recency contribute
- Power law decays slower than exponential — memories are never truly gone
- Logarithmic transform means activation grows sub-linearly with practice

### Simplified Formula for Clawvato

Replace the current linear recency brackets (1.0/0.9/0.7/0.5/0.3) with:

```typescript
function calculateActivation(memory: Memory): number {
  const daysSinceAccessed = memory.last_accessed_at
    ? daysBetween(memory.last_accessed_at, now())
    : daysBetween(memory.created_at, now());

  const decayRates: Record<string, number> = {
    preference: 0.05,    // almost never decays
    decision:   0.1,     // very slow decay
    reflection: 0.2,     // slow decay
    fact:       0.3,     // moderate decay
    observation: 0.5,    // fast decay
  };

  const d = decayRates[memory.type] ?? 0.3;
  const recencyComponent = Math.pow(daysSinceAccessed + 1, -d);
  const frequencyBoost = Math.log(memory.access_count + 1) * 0.1;

  return (memory.importance / 10) * (recencyComponent + frequencyBoost);
}
```

### MemoryBank Alternative

MemoryBank (AAAI 2024) uses Ebbinghaus forgetting curve: `R = e^(-t/S)` where `S` increments on recall. Simpler but less psychologically accurate than ACT-R's power law.

### References

- ACT-R Unit 4: Activation of Chunks and Base-Level Learning (act-r.psy.cmu.edu)
- MemoryBank: Enhancing LLMs with Long-Term Memory (arXiv 2305.10250)

---

## 6. Graceful Forgetting Strategies

### The MaRS Framework (December 2025)

"Forgetful but Faithful" (arXiv 2512.12856v1) formalizes six forgetting policies:

| Policy | Mechanism | Complexity | Best For |
|--------|-----------|-----------|----------|
| **FIFO** | Remove oldest first | O(1) amortized | Utility decays primarily with age |
| **LRU** | Remove least-recently-accessed | O(1) average | Access patterns indicate relevance |
| **Priority Decay** | Score = alpha*type + beta*recency + gamma*frequency; remove lowest density | O(log n) | High-value old items should persist |
| **Reflection-Summary** | Cluster similar episodes via embeddings; replace with summaries | O(n log n) | Redundant episodic memories |
| **Random-Drop** | Probabilistic eviction | O(1) | Baseline only |
| **Hybrid** | Staged: temporal -> reflection -> importance -> privacy | O(n log n) | Best composite performance |

**Unified density score:**

```
score(n) = [U_n - lambda_priv * s_n] / w_n
```

(utility minus privacy-weighted sensitivity, divided by token cost)

**Benchmark result:** Hybrid policy achieved best composite performance (~0.911) across narrative coherence, goal completion, social recall, privacy leakage, and cost.

### Recommendation

Clawvato's existing consolidation pipeline (merge duplicates -> supersede contradictions -> compress observations -> decay scores -> summarize actions -> promote observations) already implements a simplified Hybrid approach. The MaRS framework validates this staging. Key enhancement: add the **density score** for more principled eviction.

### References

- Forgetful but Faithful: A Cognitive Memory Architecture and Benchmark (arXiv 2512.12856v1)
- Agentic Memory: Unified Long-Term and Short-Term Management (arXiv 2601.01885v1)

---

## 7. Atomic Fact Extraction

### FACTScore (EMNLP 2023)

Established the decompose-and-evaluate paradigm: break text into atomic facts (self-contained propositions including entity names), verify each independently. The "decompose-decontextualize-verify" pipeline makes each claim context-free (no pronouns, no implicit references).

### Zep's Graphiti Engine (January 2025)

Production implementation for agent memory:

1. Extract atomic units of context-free information from each message
2. Generate embeddings (1024-dim vectors) for each fact
3. Deduplicate entities via cosine similarity + full-text search + LLM verification
4. Bi-temporal model: four timestamps per edge (created/expired for transaction time, valid/invalid for event time)

### Mem0's Pipeline (2025)

Each new fact is compared to top `s` similar entries in vector DB; LLM chooses one of four operations: **ADD**, **UPDATE**, **DELETE**, or **NOOP**. Simple but production-tested.

### Enhanced Extraction Prompt

```typescript
const EXTRACTION_PROMPT = `Extract structured facts from this conversation.
Each fact must be:
1. ATOMIC: one claim per fact
2. CONTEXT-FREE: include full entity names (not "he" or "the project")
3. TIMESTAMPED: include temporal references when present

Return JSON array:
[{
  "type": "fact|preference|decision|observation",
  "content": "self-contained statement",
  "confidence": 0.0-1.0,
  "entities": ["full entity names"]
}]`;
```

### References

- FACTScore: Fine-grained Atomic Evaluation (EMNLP 2023, arXiv 2305.14251)
- Zep: A Temporal Knowledge Graph for Agent Memory (arXiv 2501.13956v1)
- Mem0: Production-Ready AI Agents with Scalable Long-Term Memory (arXiv 2504.19413)

---

## 8. Hybrid Retrieval: FTS5 + Vector Search with RRF

### Reciprocal Rank Fusion

RRF combines multiple ranked lists using positions rather than normalized scores:

```
RRF_score(d) = SUM_r( w_r / (k + rank_r(d)) )
```

Where `k` = constant (default **60**, tunable), `rank_r(d)` = 1-based position in ranking `r`, `w_r` = weight for ranking method.

Documents that rank well in **both** methods score highest.

### Implementation with sqlite-vec

Clawvato already has FTS5 (`memories_fts`). Add vector search via **sqlite-vec** (pure-C SQLite extension, SIMD-accelerated):

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[384]   -- 384 dims for all-MiniLM-L6-v2
);
```

```typescript
async function hybridSearch(query: string, limit = 10): Promise<Memory[]> {
  // 1. FTS5 keyword search
  const ftsResults = db.prepare(`
    SELECT m.id, rank FROM memories_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memories_fts MATCH ?
    ORDER BY rank LIMIT ?
  `).all(query, limit * 2);

  // 2. Vector similarity search
  const queryEmb = await embed(query);
  const vecResults = db.prepare(`
    SELECT memory_id as id, distance FROM memory_embeddings
    WHERE embedding MATCH ? ORDER BY distance LIMIT ?
  `).all(queryEmb, limit * 2);

  // 3. RRF fusion (k=60, fts_weight=1.0, vec_weight=0.7)
  const scores = new Map<string, number>();
  const K = 60;
  ftsResults.forEach((r, rank) =>
    scores.set(r.id, (scores.get(r.id) ?? 0) + 1.0 / (K + rank + 1)));
  vecResults.forEach((r, rank) =>
    scores.set(r.id, (scores.get(r.id) ?? 0) + 0.7 / (K + rank + 1)));

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => getMemoryById(id));
}
```

### Embedding Model Options

| Model | Dims | Speed (Apple Silicon) | Cost | Quality |
|-------|------|----------------------|------|---------|
| **all-MiniLM-L6-v2** | 384 | ~1ms/embed | Free (local) | Good enough |
| **nomic-embed-text-v1.5** | 768 | ~3ms/embed | Free (Ollama) | Better than text-embedding-3-small |
| **text-embedding-3-small** | 1536 | Network latency | $0.02/M tokens | Strong baseline |

**Recommendation:** Start with all-MiniLM-L6-v2 locally (zero cost, sub-millisecond). Upgrade to nomic-embed-text-v1.5 if quality insufficient.

### References

- RRF: Reciprocal Rank Fusion (ParadeDB)
- sqlite-vec (github.com/asg017/sqlite-vec)
- Nomic Embed: Reproducible Long Context Text Embedder (arXiv 2402.01613)

---

## 9. Cost Model

### API Pricing (March 2026)

| Model | Input/1M tokens | Output/1M tokens |
|-------|----------------|------------------|
| Haiku 4.5 | $1.00 | $5.00 |
| Sonnet 4.6 | $3.00 | $15.00 |
| Opus 4.6 | $5.00 | $25.00 |

### Monthly Cost Estimate (50 Memory Operations/Day)

| Component | Calculation | Monthly |
|-----------|------------|---------|
| Fact extraction (Haiku) | 50/day * (500in + 200out) | $2.25 |
| Nightly consolidation (Sonnet) | 30/month * (5000in + 1000out) | $0.90 |
| Weekly reflections (Sonnet) | 20/month * (2000in + 300out) | $0.21 |
| Embeddings (local) | all-MiniLM-L6-v2 | $0.00 |
| **Total** | | **$3.36/month** |

### Optimization Opportunities

- **Prompt caching** (reuse extraction system prompt): saves ~$0.60/month
- **Batch API** (async consolidation): saves ~$0.55/month
- **Combined**: $2.21/month

Memory operations represent ~7% of total agent budget (~$47/month from MEMORY_ARCHITECTURE.md). Well within the $1.50/day target.

---

## 10. Phased Implementation Plan for Track C

### Phase 1: Enhanced Extraction (Week 1)
- Decontextualized atomic fact extraction prompt
- Sentiment polarity extraction during Haiku step
- Schema additions: `sentiment_polarity`, `sentiment_confidence`

### Phase 2: Improved Retrieval (Week 2)
- Add sqlite-vec + all-MiniLM-L6-v2 embedding pipeline
- Implement RRF hybrid search
- Wire into agent context injection

### Phase 3: Compression Pipeline (Week 3)
- ACT-R decay replacing linear brackets
- Progressive summarization in nightly consolidation
- Entity-scoped reflection generation

### Phase 4: Distillation + Forgetting (Week 4)
- Observation-to-preference promotion formalization
- MaRS-inspired density scoring for eviction
- Relationship sentiment tracking for people table

### Schema Changes Summary

```sql
-- Phase 1
ALTER TABLE memories ADD COLUMN sentiment_polarity TEXT;
ALTER TABLE memories ADD COLUMN sentiment_confidence REAL DEFAULT 0.5;

-- Phase 2
CREATE VIRTUAL TABLE memory_embeddings USING vec0(
  memory_id TEXT PRIMARY KEY,
  embedding float[384]
);

-- Phase 3
ALTER TABLE memories ADD COLUMN access_count INTEGER DEFAULT 0;
ALTER TABLE memories ADD COLUMN last_accessed_at TEXT;

-- Phase 4
ALTER TABLE memories ADD COLUMN derived_from TEXT;
ALTER TABLE memories ADD COLUMN derivation_type TEXT;
ALTER TABLE people ADD COLUMN relationship_sentiment TEXT DEFAULT 'neutral';
ALTER TABLE people ADD COLUMN sentiment_evidence_count INTEGER DEFAULT 0;
ALTER TABLE people ADD COLUMN sentiment_last_updated TEXT;
```
