# Last Interactions — Session 26

### Brain Platform Architecture Discussion
**User**: I want to keep kicking the tires on the brain platform design. Gut check it with fresh context.
**Assistant**: Deep assessment: /ingest contract is the best decision, intelligence-not-content principle is right, decay-as-curation is novel. Gaps: entity resolution unbuilt, HDBSCAN quality unvalidated, multi-brain split premature at current scale.
**Decision**: Architecture is sound. Entity resolution and clustering spike needed before investing in hierarchy.

### Multi-Brain Motivation
**User**: My email is thousands of messages with LOW signal to noise. I don't want to pollute the 228-mem curated brain with email noise.
**Assistant**: This changes things — corpus pollution is a concrete problem. Proposed logical brain separation (brain_id column in same DB, not separate services). One process, one DB, but isolated clustering/reflection/decay per brain.
**Decision**: Logical brain separation. brain_id column. Default brain changed from 'dev' to 'primary' after analyzing 60% of memories are business intelligence.

### Configurable Brain Concepts
**User**: Is there a way to generalize concepts (commitments, etc.) rather than hardcode them? Also the dev brain is very different from comms.
**Assistant**: Hybrid approach — concepts defined in brain.yaml per brain, extraction prompts generated from concept definitions. General facts still extracted alongside. Each brain has genuinely different understanding of the world.
**Decision**: Concepts are per-brain YAML config. Extraction prompts auto-generated. Engine is generic, config makes it specific.

### Channel Ownership + Flow Types
**User**: Should channels be shared or exclusive per brain? And subordinate brains need strategic context from GBS.
**Assistant**: Exclusive ownership — each raw source has one brain. Three flow types: feeds UP (raw concepts), context DOWN (synthesized digests), drill-downs (any direction, ephemeral).
**Decision**: Comms owns all Slack/Gmail/Fireflies/Drive. Dev owns CC journals. Primary/GBS receives feeds.

### Recursive Clustering
**User**: I did a spike in newmail and clustering was terrible — merged Acorns+Coles, duplicate clusters, noise.
**Assistant**: Built recursive concept-aware HDBSCAN: composite embeddings ([concept_type] entities: content), adaptive depth per branch (HDBSCAN decides when to stop), cluster identity preservation across re-runs, incremental rebalance with dirty flags.
**Decision**: Recursive + concept-aware clustering. Sparse data stays flat naturally.

### Cutover + Migration State
**User**: Let's do the cutover! Then: we're in a messy mid-state, need a plan to finish migration.
**Assistant**: Cutover done — clawvato now points to brain-platform. But sidecar still runs in clawvato, old npm package distributes hooks, comms brain doesn't exist yet. Plan: 6 steps to clean state.
**Decision**: Stay in clawvato directory for sessions. Next: build comms brain + move sidecar to brain-platform, then thin clawvato.
**Pending**: Step 1 of migration plan (comms brain + sidecar wiring), then steps 2-5 (thin clawvato, npm migration, cleanup).
