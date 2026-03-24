# S10: Memory Excellence

> Status: Design | Author: Andrew + Claude | Date: 2026-03-24 | Session: 23

## Vision

Make the memory system so good that it anticipates what the model needs, surfaces implicit relationships, and keeps itself clean without human intervention. The goal is not "a database with facts in it" — it's a reasoning substrate that makes every CC session smarter than the last.

Five workstreams, each building on the previous:

1. Memory scoping — hard isolation between domains
2. Write-time dedup — ADD/UPDATE/DELETE/NOOP at extraction
3. Embedding upgrade — 56% → 86% retrieval accuracy
4. Cross-encoder reranking — precision at retrieval time
5. Memory usage instructions — teach CC to wield the memory

## Research Foundation

Based on deep analysis of: Hindsight (91.4% LongMemEval), Mem0 (26% accuracy boost via write-time dedup), Zep/Graphiti (bi-temporal knowledge graphs), Letta/MemGPT (tiered self-managed memory), Mastra (compression-first), and 20+ papers from 2024-2026. Full research notes in session 23 handoff.

Key numbers driving these decisions:
- all-MiniLM-L6-v2 achieves **56% Top-5 accuracy**. nomic-embed-text-v1.5 achieves **86.2%**.
- Hybrid search (BM25 + vector + RRF) adds **+22 points** over pure vector.
- Cross-encoder reranking is **60x cheaper and 48x faster** than LLM reranking.
- Write-time dedup yields **60% storage reduction, 22% retrieval precision improvement**.
- Quality saturates at **~7 well-structured memories per entity**.

---

## 1. Memory Scoping

### Problem

All memories sit in one pool. Dev work, business data, personal notes, and project context are intermixed. At 125 facts this is fine. At 1K+ the model retrieves plausible-but-wrong results from the wrong domain. Owner directive: "no dev memories until scoping is built."

### Design

Add a `surface_id` column to the `memories` table. Every memory is tagged with the surface that created it. All queries filter by surface.

**Schema change:**

```sql
ALTER TABLE memories ADD COLUMN surface_id TEXT NOT NULL DEFAULT 'global';
CREATE INDEX idx_memories_surface ON memories(surface_id);
-- Consider: ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
```

**Surface hierarchy:**

```
global          — shared across all surfaces (user profile, contacts)
local           — CC coding sessions (dev work, architecture decisions)
cloud           — Slack agent (business context, meeting notes, email)
cloud:sweep     — background sweep data (Gmail, Drive, Fireflies)
```

**Rules:**
- Every `store_fact` call MUST include `surface_id` (plugin enforces)
- Every `search_memory` / `retrieve_context` call filters by surface (mandatory WHERE clause)
- `surface_id = 'global'` is always included in results (shared knowledge)
- The `CLAWVATO_SURFACE` env var (already set in hooks) provides the default
- Cross-surface access is read-only via explicit `surfaces: ["cloud", "local"]` parameter
- The plugin enforces scoping — callers can't accidentally skip it

**Plugin tool changes:**

| Tool | Change |
|------|--------|
| `store_fact` | Add required `surface_id` parameter |
| `search_memory` | Add optional `surfaces` parameter (defaults to current + global) |
| `retrieve_context` | Add optional `surfaces` parameter (defaults to current + global) |
| `retire_memory` | Unchanged (operates by ID) |

**Migration:** Existing 125+ memories get `surface_id = 'cloud'` (they came from sweeps and Slack). Future coding sessions use `'local'`.

### Implementation

1. Schema migration in plugin (ALTER TABLE + index)
2. Update all plugin tool handlers to accept and enforce surface_id
3. Update `store_fact` to require surface_id
4. Update search/retrieval to filter by surface
5. Set `CLAWVATO_SURFACE` in all CC entry points (already done for hooks)
6. Migrate existing memories: `UPDATE memories SET surface_id = 'cloud' WHERE surface_id = 'global'`

---

## 2. Write-Time Dedup (ADD/UPDATE/DELETE/NOOP)

### Problem

Extraction is append-only. Every conversation produces new facts, many of which duplicate or contradict existing ones. Consolidation cleans up later, but the store grows unboundedly between consolidation runs. At scale, this creates noise that degrades retrieval.

### Design

After extraction produces candidate facts, each fact is compared against the top-k most similar existing memories. An LLM (Haiku — cheap, fast) decides:

- **ADD**: New information, store it
- **UPDATE**: Existing fact needs revision, supersede old + store new
- **NOOP**: Already known, skip
- **DELETE**: Old fact is now incorrect, retire it

```
Conversation
  → Extraction (Haiku): produces candidate facts
  → For each candidate:
      → search existing memories (hybrid search, top 5)
      → If similar found (cosine > 0.7):
          → Dedup LLM (Haiku): compare candidate vs existing → ADD/UPDATE/NOOP/DELETE
      → If no similar found:
          → ADD directly
  → Store results
```

**Cost:** One extra Haiku call per fact that has a potential duplicate. At ~$0.00025/call, this adds ~$0.001 per extraction with 4 duplicate candidates. Negligible.

**New prompt:** `config/prompts/memory-dedup.md`

```markdown
Compare this NEW fact against EXISTING memories. Decide what to do.

NEW FACT:
{{NEW_FACT}}

EXISTING MEMORIES:
{{EXISTING_MEMORIES}}

Return JSON: {"action": "ADD|UPDATE|NOOP|DELETE", "target_id": "id of memory to update/delete (if applicable)", "reason": "brief explanation"}

Rules:
- ADD: The new fact contains genuinely new information not covered by any existing memory
- UPDATE: The new fact is a more current/complete version of an existing memory (return target_id of the one to supersede)
- NOOP: The new fact is already captured by an existing memory (no action needed)
- DELETE: The new fact contradicts an existing memory and the new fact is more reliable (return target_id to retire)
- When in doubt between ADD and NOOP, prefer NOOP — don't accumulate near-duplicates
- Return ONLY valid JSON
```

### Implementation

1. Create `config/prompts/memory-dedup.md`
2. Add dedup prompt to `LoadedPrompts` and `loadPrompts()`
3. Modify `storeExtractionResult()` in `extractor.ts`:
   - After embedding each fact, search for similar existing memories
   - If cosine similarity > 0.7 on any result, call Haiku with dedup prompt
   - Execute the returned action (ADD/UPDATE/NOOP/DELETE)
4. Add dedup metrics logging (counts of each action per extraction)
5. Add `memory.dedupSimilarityThreshold` to config (default: 0.7)
6. Add `memory.dedupEnabled` feature flag (default: true)

---

## 3. Embedding Upgrade

### Problem

all-MiniLM-L6-v2 (384-dim) has **56% Top-5 accuracy** — among the lowest current models. The embedding model is the retrieval bottleneck. Upgrading to a modern model is the single cheapest improvement to retrieval quality.

### Options Evaluated

| Model | Dims | Top-5 Acc | Max Tokens | Speed | License |
|-------|------|-----------|------------|-------|---------|
| all-MiniLM-L6-v2 (current) | 384 | 56% | 256 | 14.7ms/1K | Apache 2.0 |
| nomic-embed-text-v1.5 | 768 | 86.2% | 8192 | ~20ms/1K | Apache 2.0 |
| Xenova/bge-small-en-v1.5 | 384 | 72% | 512 | ~15ms/1K | MIT |

**Recommendation: nomic-embed-text-v1.5**

- 30-point accuracy improvement
- 8192 max tokens (vs 256) — can embed entire conversation chunks
- Supports Matryoshka representation (truncate to 384d for backward compat during migration)
- Available via @huggingface/transformers (same as current model)
- Open source, Apache 2.0

### Migration Strategy

The schema currently has `embedding vector(384)`. Changing to `vector(768)` requires re-embedding all existing memories.

**Option A — Online migration (recommended):**
1. Add `embedding_v2 vector(768)` column
2. Deploy new model, write to both columns
3. Background task re-embeds all existing memories into `embedding_v2`
4. Switch retrieval to use `embedding_v2`
5. Drop old `embedding` column
6. Rename `embedding_v2` → `embedding`

**Option B — Matryoshka truncation:**
1. Use nomic at 384d (truncated) — drop-in replacement, no schema change
2. Get ~75% of the accuracy gain immediately
3. Upgrade to full 768d later when convenient

**Recommendation:** Start with Option B (zero-downtime, immediate benefit), plan Option A for a quiet maintenance window.

### Implementation

1. Swap model in `embeddings.ts`: `'Xenova/all-MiniLM-L6-v2'` → `'nomic-ai/nomic-embed-text-v1.5'`
2. If using Matryoshka truncation, truncate output to 384d
3. Update EMBEDDING_DIM constant if going to 768d
4. Test retrieval quality on existing memories
5. Add a config flag: `memory.embeddingModel` (default: `'nomic-ai/nomic-embed-text-v1.5'`)
6. Update the schema comment about embedding dimensions

---

## 4. Cross-Encoder Reranking

### Problem

After hybrid search (tsvector + pgvector), results are ranked by RRF score. This is good but not great — RRF treats all search signals equally and can't assess semantic relevance to the specific query. LLM reranking (our original plan) would work but is 60x more expensive and 48x slower than a purpose-built cross-encoder.

### Design

Add a cross-encoder reranking stage between hybrid search and context formatting:

```
Query
  → Hybrid search (BM25 + vector): 50-100 candidates (~100ms)
  → Cross-encoder rerank: 50 → top 15 (~10ms)
  → Token budget formatting: 15 → fits in budget
  → Return to model
```

**Model options:**
- `cross-encoder/ms-marco-MiniLM-L-6-v2` — 22MB, fast, good accuracy
- `BAAI/bge-reranker-base` — higher accuracy, larger
- `jinaai/jina-reranker-v1-turbo-en` — production-grade, 33M params

**Recommendation:** Start with `cross-encoder/ms-marco-MiniLM-L-6-v2` — small, fast, available via @huggingface/transformers. Upgrade if needed.

### Implementation

1. Add cross-encoder model loading in `retriever.ts` (lazy, like embeddings)
2. After `hybridSearch` or `searchMemories` returns candidates:
   - Pair each candidate with the original query
   - Score with cross-encoder
   - Sort by cross-encoder score
   - Take top N (configurable, default 15)
3. Replace the existing `rerankMemories` function (which uses Anthropic API) with cross-encoder
4. Add `memory.rerankModel` and `memory.rerankTopK` to config
5. Fallback: if cross-encoder fails to load, fall back to RRF ordering (no degradation)

---

## 5. Memory Usage Instructions

### Problem

The memory system can be perfect, but if the model doesn't know how to USE it, the value is wasted. Current prompts mention memory tools exist but don't teach effective patterns.

### Design

Three layers of instruction:

**Layer 1 — System prompt (always in context)**

Teach the four operations and when to use them:

```markdown
## Memory System

You have access to a persistent memory system via MCP tools. This is your long-term brain — it survives across sessions and surfaces.

### When to READ memory
- Before starting any task, search for relevant context
- When the user mentions a person, project, or topic — check what you know
- When making a decision that might have been made before
- When you need context about past interactions

### When to WRITE memory
- When you learn something new about a person, project, or decision
- When a fact changes or becomes outdated (use retire_memory on the old one, store the new one)
- When you discover a relationship between entities
- When the user tells you something they'll want remembered

### When NOT to write
- Ephemeral task details (use working context instead)
- Information derivable from code or git history
- Debugging steps or temporary state

### How to search effectively
- Use specific entity names: search for "Sarah Chen" not "the client"
- Combine entity + topic: entities=["Acorns"] query="contract renewal"
- Check multiple surfaces if the information might be from Slack vs coding sessions
- If first search returns nothing useful, try different terms — memory is keyword + semantic

### Memory quality
- One fact per memory — atomic, self-contained
- Include WHY, not just WHAT: "chose Postgres because pgvector" > "using Postgres"
- Include enough context to be useful months later
- High confidence (0.9+) for explicit statements, lower for inferences
```

**Layer 2 — Retrieval context formatting (at retrieval time)**

Format retrieved memories with XML tags (Claude is fine-tuned for these):

```xml
<memory surface="cloud" relevance="high">
  <fact type="relationship" importance="8" confidence="0.95">
    Sarah Chen is VP Marketing at Acorns (sarah@acorns.com), primary client contact
  </fact>
  <fact type="decision" importance="7" confidence="0.9">
    Chose Railway for deployment because of managed Postgres + auto-deploy from GitHub
  </fact>
</memory>
```

**Layer 3 — Extraction prompt improvements**

Enhance the extraction prompt to produce higher-quality facts:
- Add examples of good vs bad extractions
- Emphasize relationship extraction (A works with B, A reported to B)
- Add guidance on confidence calibration
- Teach the extractor about procedural memory (learned patterns/workflows)

### Implementation

1. Create `config/prompts/memory-instructions.md` with Layer 1 content
2. Inject into CC system prompts (both cc-native and deep-path)
3. Update `formatMemory()` in `retriever.ts` to use XML tags with metadata
4. Update `config/prompts/extraction.md` with improved guidance and examples
5. Add procedural memory type to extraction: "when X happens, do Y"

---

## Dependency Chain

```
1. Memory scoping        ← foundation, blocks everything
   ↓
2. Write-time dedup      ← needs scoping for surface-aware dedup
   ↓ (can partially overlap)
3. Embedding upgrade     ← independent, but dedup benefits from better embeddings
   ↓
4. Cross-encoder rerank  ← needs good embeddings to feed candidates
   ↓
5. Memory instructions   ← needs all the above working to teach effectively
```

Items 1 and 2 are the core. Items 3 and 4 are quality multipliers. Item 5 ties it together.

## What Changes Where

### Plugin (clawvato-memory repo)

| Change | Files |
|--------|-------|
| `surface_id` column + migration | Schema, all tool handlers |
| Surface filtering on all queries | search, retrieve, store handlers |
| `surfaces` parameter on search/retrieve tools | Tool definitions |
| New `memory-dedup` tool (optional — may keep dedup in main repo) | New tool |

### Main Repo (clawvato)

| Change | Files |
|--------|-------|
| Extraction dedup pipeline | `src/memory/extractor.ts` |
| Dedup prompt | `config/prompts/memory-dedup.md` |
| Embedding model swap | `src/memory/embeddings.ts` |
| Cross-encoder reranking | `src/memory/retriever.ts` |
| XML context formatting | `src/memory/retriever.ts` |
| Memory instructions prompt | `config/prompts/memory-instructions.md` |
| System prompt integration | `config/prompts/cc-native-system.md`, `config/prompts/deep-path.md` |
| Config additions | `src/config.ts`, `config/default.json` |

## Success Criteria

S10 is done when:
1. A coding session's memories never appear in Slack agent responses (scoping works)
2. Storing the same fact twice results in one memory, not two (dedup works)
3. Retrieval consistently returns the most relevant facts for a query (embeddings + reranking work)
4. CC proactively checks memory before starting tasks (instructions work)
5. The model can explain WHY it chose to store or not store a fact (understanding, not compliance)

## Deferred to S11 (Scheduler Sprint)

- **Sleep-time consolidation**: Background task during idle periods — reviews recent memories, synthesizes higher-level insights, merges duplicates, updates entity summaries. 18% accuracy gain documented. Requires the scheduler to fire it.
- **Reflection synthesis**: LLM generates 3 salient questions from top-100 recent memories, produces higher-level inferences stored as new memories with `reflection_source` flag.
- **Temporal decay scoring**: `score = relevance * recency_decay * importance`. Run as periodic maintenance task.
