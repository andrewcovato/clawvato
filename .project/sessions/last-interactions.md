# Last Interactions — Session 32

### v4 Design Refinement — Three-Layer Data Model
**User**: Pointed out entity BoB contexts were contaminated with engagement details. Asked for audit of all 18 entities. Led to discovery that "why they matter" in tool description invited engagement content.
**Assistant**: Audited all entities, found 10/18 contaminated. Root cause: ambiguous tool description + no separation guidance + context window contamination when entities were created. Added three-layer data model (entity BoB / workstream BoB / brief) to design doc with enforcement rules.
**Decision**: Entity context = static company profile only. Workstream context = engagement structure. Brief = what's happening now. Crawl agent flags drift but doesn't write Layers 1-2.

### Agent Architecture — Ephemeral Crawl Agent
**User**: Debated always-on vs ephemeral crawl agent. Key insight: CoS can be sloppy on facts because owner corrects in real-time, but crawl agent's output IS the system of record with no human in the loop.
**Assistant**: Concluded ephemeral is correct because autonomous writers can't trust volatile context (Memento analogy). Added crawl_notes as durable attention between runs.
**Decision**: Crawl agent is ephemeral `claude --print`, spawned by sidecar on cron. CoS writes nothing proactively.

### Tracked Items — Structured Anchors
**User**: Worried about brief-to-brief comparison being lossy. Asked for durability of stored items without going back to granular todo paradigm.
**Assistant**: Designed tracked items — coarser than v3 todos, semantic keys (e.g., "vail/msa-execution"), 5 types (milestone/action/inbound/commitment/monitor), 6 statuses. Brief is rendered FROM tracked item status changes. Built in brain-platform: table + types + engine + 5 MCP tools.
**Decision**: Tracked items replace todos as the structured anchor. Brief is the view, tracked items are the table.

### Build + Deploy + Debug
**User**: Asked to build, push, test. Deployed to Railway. Crawl failed — timed out after 15 min with zero output.
**Assistant**: Found bugs: MCP_CONFIG not exported (critical), gws GLIBC mismatch in urgency check, missing env vars. Fixed MCP_CONFIG export, disabled urgency check temporarily, added RUN_CRAWL_NOW trigger, file-based prompt. Three crawls started, none completed.
**User**: "We're all over the place. Find all failure modes first, then present solutions." Corrected the whack-a-mole debugging approach.
**Decision**: Need separate Railway service for crawl agent (isolated logs, no CoS interference). Test from cloud, not local.
**Pending**: Set up separate Railway service for crawl agent. Crawl has never successfully completed.

### Entity Data Cleanup
**Assistant**: Cleaned all 11 entity contexts — removed engagement details, wrote pure company profiles. Verified via MCP reads.
**Decision**: Done. All entities now Layer 1 only.
