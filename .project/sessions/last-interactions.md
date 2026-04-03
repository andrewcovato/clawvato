# Last Interactions — Session 31

### MemoryOS Comparison
**User**: Shared BAI-LAB/MemoryOS GitHub repo, asked for comparison to what we built.
**Assistant**: Deep analysis — MemoryOS is academic chatbot personalization (3-tier memory, 90-dimension profiling). Clawvato is a business OS. Different problems entirely. User confirmed v3 is right for their use case.

### Scanner Stabilization (Major)
**User**: Scanner was burning through Max plan session limits — $2.70/call, 1.8M input tokens on Coles.
**Assistant**: Found and fixed compounding bugs:
1. In-memory scan times reset on every deploy → persisted in DB via new MCP tools
2. Gmail `after:YYYY-MM-DD` had day-level granularity → switched to epoch seconds
3. `setInterval` caused overlapping scan cycles → sequential while loops
4. `growthbyscience.com` in domain list matched ALL email → owner domain filtering
5. CLAWVATO_MEMORY_INTERNAL_URL pointed to /mcp instead of /api/tool → fixed
6. CoS MCP tools down for 4 sessions → separate URLs for CoS (StreamableHTTP) vs scanner (legacy JSON)
7. Scanner errors silently swallowed → added logging
8. Added token monitoring → posts to #clawvato-monitoring
9. Implemented Fireflies scanning
10. Two-phase catchall (metadata triage → deep read)
11. Post-brief Haiku reconciliation
12. Auto-apply alterations + Slack canvas for todo list
**Decisions**: Multiple architecture decisions, ultimately leading to v4 proposal.

### Todo List Accuracy Problems
**User**: Todo list was ~70% accurate — stale items, missing items, duplicate proposals spamming Slack.
**Assistant**: Did manual full audit — completed 15+ stale items, cancelled superseded ones, created 15+ missing items from fresh email/Slack/Fireflies crawl. Exposed fundamental weakness: keyword/domain-based filtering misses things that require contextual understanding.

### v4 Master Crawl Proposal
**User**: "Discrete todos are what's messing this up. Think of what an admin would say to an exec."
**Assistant**: Iterated through ~10 design rounds arriving at v4 architecture:
- Kill per-workstream scanner, replace with single Opus master crawl 2x/day
- Read ALL email (no domain filter), Opus routes by understanding
- Action brief in admin voice (human-readable + agent-parseable)
- Workstreams defined by people + purpose, not domains
- Direct apply, no proposal flow
- Untracked activity section catches things outside workstreams
**Decision**: Owner approved direction. Design doc written at docs/DESIGN_V4_MASTER_CRAWL.md. Pending detailed review before implementation.
**Pending**: Owner needs to review design doc and confirm before building.
