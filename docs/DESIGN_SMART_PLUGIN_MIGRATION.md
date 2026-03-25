# Design: Smart Plugin Migration

> **Status**: Draft — awaiting owner approval
> **Date**: 2026-03-24
> **Sprint**: Replaces S11 as originally scoped
> **Decision**: Move memory intelligence from agent into plugin

## Context

The clawvato-memory plugin started as a thin Postgres gateway — raw CRUD over HTTP MCP. Meanwhile, the agent codebase accumulated sophisticated memory intelligence: embeddings, hybrid search, cross-encoder reranking, write-time dedup, entity-hop traversal, and soft-signal scoring.

**Problem**: The cloud agent (Railway/Slack) calls the plugin and gets "dumb" keyword search. The local agent talks directly to Postgres and gets "smart" hybrid retrieval. As memory intelligence improves, this gap widens.

**Decision**: Move memory intelligence INTO the plugin. The plugin becomes the smart brain. The agent becomes an executor that knows how to wield the brain's tools.

## Architectural Principles

1. **Intelligence at the storage layer** — embed at write time, dedup at write time, classify at write time. Every read benefits automatically.
2. **Extraction stays in the agent** — agents have LLM access and conversation context. They extract facts and call `store_fact`. The plugin handles everything after that (embed, dedup, store).
3. **Two schedulers, two concerns**:
   - **Memory scheduler (plugin)**: consolidation, reflection synthesis, temporal decay. Database maintenance. No Slack, no user interaction.
   - **Agent scheduler (agent-side)**: briefs, emails, webhooks, user-facing tasks. Needs Slack + Google + reasoning.
4. **Brain is agent-agnostic** — any agent framework (CC-native, hybrid, "OpenClaw", future SDK) can connect via HTTP MCP and get identical memory quality.

## Performance Budget

| Operation | Today (thin) | After (smart) | Acceptable? |
|-----------|-------------|---------------|-------------|
| `store_fact` | ~5ms | ~60-80ms | Yes — write path, not latency-sensitive |
| `retrieve_context` | ~10ms | ~80-120ms | Yes — still sub-second, much higher quality |
| `search_memory` | ~10ms | ~40-60ms | Yes — vector component adds quality |
| Cold start | ~1s | ~5-8s | Yes — one-time on deploy, models stay warm |
| Memory footprint | ~80MB | ~400-450MB | Yes — Railway Growth has headroom |

## What Moves to the Plugin

| Module | Source (agent) | Destination (plugin) |
|--------|---------------|---------------------|
| `embeddings.ts` | `src/memory/embeddings.ts` | `server/embeddings.ts` |
| `reranker.ts` | `src/memory/reranker.ts` | `server/reranker.ts` |
| `retriever.ts` (hybrid search + entity-hop + scoring) | `src/memory/retriever.ts` | Integrated into `retrieve_context` handler |
| `store.ts` (write-time dedup logic) | `src/memory/extractor.ts` (dedup portion) | Integrated into `store_fact` handler |
| `consolidation.ts` | `src/memory/consolidation.ts` | `server/consolidation.ts` |
| Memory scheduler | New | `server/scheduler.ts` |

## What Stays in the Agent

| Module | Why |
|--------|-----|
| `extractor.ts` (fact extraction) | Needs LLM + conversation context. Agents choose how to extract. |
| Agent-facing scheduler | Needs Slack, Google, user interaction. Swappable with agent framework. |
| `store.ts` (simple CRUD for local direct-DB use) | Local dev can still talk to DB directly for testing. Plugin is the production path. |

## Migration Phases

Each phase is independently deployable and tested before proceeding to the next.

### Phase 1: Embeddings at Write Time

**Goal**: `store_fact` generates vector embeddings. Stored in the `embedding` column.

**Changes**:
- Add `@xenova/transformers` dependency to plugin
- Port `embeddings.ts` (nomic-embed-text-v1.5, Matryoshka 384d, purpose-aware prefixes)
- Pre-load model on server startup (warm cache)
- `store_fact` handler: generate embedding → INSERT with vector
- New tool: `store_facts` (batch) — accepts array of facts, embeds all in one batch call, inserts in a transaction. Single round-trip for extraction pipelines.
- New tool: `embed_batch` for backfilling existing memories without embeddings

**Tests**:
- Unit: embedding generation produces 384-dim vector
- Unit: purpose prefixes applied correctly (document vs query)
- Unit: batch embedding produces same vectors as sequential
- Integration: store_fact round-trip — store with embedding, verify vector in DB
- Integration: store_facts batch — 10 facts in one call, all stored with embeddings
- Integration: cold start time with model loading < 8s
- Performance: embedding latency < 100ms per fact
- Performance: store_facts(10) < 300ms (batch embedding amortizes overhead)

**Acceptance**: Every new fact stored via plugin has a vector embedding. Batch path available for extraction pipelines.

---

### Phase 2: Hybrid Search + Reranking

**Goal**: `retrieve_context` and `search_memory` use hybrid tsvector + pgvector search. Cross-encoder reranks top candidates.

**Changes**:
- Port hybrid search logic: tsvector + pgvector CTE with RRF scoring
- Add cross-encoder model (`@xenova/transformers`, ms-marco-MiniLM-L-6-v2)
- Pre-load cross-encoder on startup alongside embedding model
- `retrieve_context`: hybrid search → cross-encoder top-K → token budget → format
- `search_memory`: optional hybrid mode (when query provided), falls back to tsvector-only when no embedding exists
- Soft-signal boosting (domain 1.3x, surface 1.1x, importance 1.2x) applied after reranking

**Tests**:
- Unit: RRF scoring produces correct rank fusion
- Unit: cross-encoder scores correlate with semantic relevance
- Integration: retrieve_context returns vector-matched results that keyword search would miss
- Integration: search_memory with query uses hybrid, without query uses importance sort
- Performance: full retrieve pipeline < 150ms for 30 candidates
- Quality: manual test — 10 known queries, verify top-3 results are semantically correct

**Acceptance**: Cloud agent retrieval quality matches local agent.

---

### Phase 3: Write-Time Dedup

**Goal**: `store_fact` detects near-duplicates and makes ADD/UPDATE/NOOP/DELETE decisions.

**Changes**:
- Port dedup logic from `extractor.ts`: vector similarity search (cosine > 0.7) → find candidates
- New tool parameter: `store_fact` gains optional `dedup: boolean` (default true)
- Dedup judgment options:
  - **Option A**: Call Haiku API from plugin (requires ANTHROPIC_API_KEY on plugin service)
  - **Option B**: Use heuristic scoring (vector similarity + entity overlap + content length comparison)
  - **Recommended**: Option A with Option B as fallback when API unavailable
- On UPDATE: soft-delete old memory, insert new with `superseded_by` reference
- On NOOP: return the existing memory ID, don't insert
- On DELETE: soft-delete the existing memory (correction case)

**Tests**:
- Unit: vector similarity threshold correctly identifies near-duplicates
- Unit: UPDATE creates superseded_by chain
- Unit: NOOP returns existing ID without inserting
- Integration: store same fact twice → second call returns NOOP
- Integration: store enriched version → UPDATE with superseded_by
- Integration: store contradicting fact → DELETE old + ADD new
- Edge case: dedup disabled → always INSERT (backward compatible)

**Acceptance**: Duplicate facts no longer accumulate. Memory count stabilizes over time.

---

### Phase 4: Entity-Hop Traversal

**Goal**: `retrieve_context` discovers connected memories through shared entities.

**Changes**:
- Port entity-hop logic from `retriever.ts`
- After initial retrieval, extract entities from top results
- Query `memory_entities` junction table for memories sharing those entities
- One hop depth (configurable): prevents explosion
- Deduplicate against already-retrieved memories
- Apply same scoring/reranking to hop results

**Tests**:
- Unit: entity extraction from memory set
- Unit: hop query returns connected memories not in original set
- Integration: "Acorns" query → finds Sarah Chen → finds her SaaStr meeting notes
- Performance: entity-hop adds < 30ms to retrieval pipeline
- Edge case: no shared entities → graceful no-op (no extra results)

**Acceptance**: retrieve_context surfaces non-obvious connections.

---

### Phase 5: Memory Scheduler

**Goal**: Plugin runs background memory maintenance — consolidation, reflection, temporal decay.

**Changes**:
- New `server/scheduler.ts`: interval-based job runner within the plugin process
- Jobs:
  - **Consolidation** (every 6h): find near-duplicate clusters, merge, clean entities
  - **Reflection synthesis** (every 12h): LLM generates higher-level inferences from accumulated facts. Requires ANTHROPIC_API_KEY.
  - **Temporal decay** (daily): score = recency × importance × access_frequency. Archive low-score memories.
  - **Embedding backfill** (on-demand): find memories with NULL embedding, generate vectors
- New tools exposed via MCP:
  - `run_consolidation`: trigger manual consolidation run
  - `get_memory_stats`: count by domain/surface/type, embedding coverage, staleness distribution
- Config via environment variables (intervals, thresholds, enable/disable per job)

**Tests**:
- Unit: temporal decay scoring formula
- Unit: consolidation identifies correct merge candidates
- Integration: reflection synthesis produces valid higher-level facts
- Integration: scheduler runs jobs at configured intervals
- Integration: `get_memory_stats` returns accurate counts
- Edge case: concurrent consolidation runs don't corrupt data (row-level locking)

**Acceptance**: Memory self-maintains. Duplicate count trends toward zero. Reflection facts appear automatically.

## Tool Interface (Post-Migration)

```
store_fact(type, content, source, importance?, confidence?, entities?, surface_id?, domain?, dedup?)
  → Embeds, dedup-checks, stores. Returns {id, action: ADD|UPDATE|NOOP|DELETE}

store_facts(facts[]: {type, content, source, importance?, confidence?, entities?, surface_id?, domain?}, dedup?)
  → Batch version of store_fact. Single round-trip for extraction pipelines that produce 5-15 facts.
  → Embeds all facts in one batch (much faster than sequential), dedup-checks each, returns [{id, action}].
  → Introduced in Phase 1 alongside embeddings — batch embedding is a natural fit.

search_memory(query?, type?, source_filter?, limit?, min_importance?, surface_id?, domain?)
  → Hybrid tsvector + pgvector search when query provided. Soft-signal boosted.

retrieve_context(message, token_budget?, surface_id?, domain?)
  → Hybrid search → cross-encoder rerank → entity-hop → soft boost → token budget

retire_memory(id, reason?)
  → Soft-delete (unchanged)

run_consolidation()
  → Trigger manual consolidation pass

get_memory_stats()
  → Counts, coverage, health metrics

# Existing tools unchanged:
update_working_context, list_working_contexts, update_brief, update_handoff, get_briefs, get_handoff
```

## Migration Strategy

- Sequential phases, each tested before proceeding
- Plugin repo gets a proper `server/` module structure (not monolithic index.ts)
- Each phase is a separate PR with tests
- Deploy to Railway after each phase — cloud agent immediately benefits
- Agent-side code is NOT removed during migration — it degrades gracefully to "direct DB" mode for local dev/testing. Can be removed once plugin is proven stable.
- Rollback: each phase can be feature-flagged via env var (e.g., `ENABLE_EMBEDDINGS=true`)

## Open Questions

1. **Anthropic API key on plugin**: Phases 3 (dedup judgment) and 5 (reflection synthesis) need Haiku/Sonnet API access. The plugin currently has no API key. Decision: add `ANTHROPIC_API_KEY` to plugin Railway service.
2. **Plugin repo structure**: Current monolithic `server/index.ts` (748 lines) needs to be split into modules before adding 1000+ lines of intelligence. Suggest: `server/index.ts` (HTTP/MCP), `server/tools.ts` (handlers), `server/embeddings.ts`, `server/reranker.ts`, `server/retriever.ts`, `server/consolidation.ts`, `server/scheduler.ts`.
3. **Model storage on Railway**: Transformer models (~340MB total) need persistent storage or will re-download on each deploy. Use Railway volume mount or rely on `@xenova/transformers` cache in `node_modules/.cache`.
