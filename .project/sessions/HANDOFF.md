# Session Handoff

> Last updated: 2026-03-19 | Session 15 | Sprint S4

## Quick Resume

```
Sprint: S4 — Memory Refactor + UX Overhaul (COMPLETE)
Status: Dynamic memory, LLM pre-flight, async findings, PDF reading all deployed
Tests: 297/297 passing across 22 files
Build: Clean
Commits this session: 20
NEXT: Daily briefing, plugin adapter, --session support, commitment tracking
```

## What Was Built (Session 15)

**20 commits** — memory refactor, UX overhaul, security hardening:

### Dead Code + Externalization
- Deleted 9 dead files (-2,980 lines): old agent/index.ts, search/, email-scan.ts
- Externalized 3 hardcoded prompts → config/prompts/ (router, fact-synthesis, email-extraction removed)
- Moved 12 hardcoded tunables → config/default.json
- Fixed 3 Zod schema/default.json mismatches (timeoutMs, shortTermTokenBudget, maxExtractedChars)
- Added CLAUDE.md directives: never hardcode prompts/tunables, bug fixing protocol, engineering philosophy

### Rename heavy→deep + Fast Path Expansion
- Global rename: heavy-path → deep-path across all files, types, configs
- Fast path expanded from 3 → 12 tools: gmail read, drive read (with PDF/doc content), freebusy, drive search, fireflies search/summary, slack search
- Fast path limits: 10→30 turns, 60s→5min timeout
- Router prompt updated: fast handles much more, deep only for cross-source synthesis

### UX Overhaul
- Pre-flight for deep path: LLM-driven conversation (Sonnet), not regex matching
- Pre-flight never auto-proceeds — must always engage user first
- Normal reaction lifecycle during pre-flight (:eyes: → :brain: → cleared per message)
- Stale progress shows last real tool activity, not user's original message
- Interrupt buffer: re-enqueue after completion, 🔜 for deep path queue
- Configurable pre-flight reminder (5 min default)

### Memory Refactor (5 phases)
- **Phase 1**: Dynamic categories — `memory_categories` table (16 seeds + discovered), entity junction table (O(n)→O(log n))
- **Phase 2**: Dynamic extraction — {{CATEGORIES}} injected at runtime, configurable content cap (500→2000), auto-discovery
- **Phase 3**: Path-aware budgets — fast: 1500 tokens, deep: 50000 tokens
- **Phase 4**: Retriever rebalance — removed hardcoded preference/decision pulls, semantic search limit 10→20
- **Phase 5**: FTS5-based consolidation (O(n²)→O(n×5)), configurable decay/archive exemptions, weekly category reorg

### Findings File System
- Deep path Opus writes findings to UUID-stamped temp file in ONE Bash call at end
- Background processor: parse JSONL, dedup, normalize categories, bulk insert + embed
- Zero overhead during research (was 60-150s with per-finding store_fact calls)
- Granularity enforced: one atomic fact per finding, explicit good/bad examples in prompt

### File Content Reading
- `google_drive_get_file` now reads actual file content (PDFs, docs, sheets, images)
- Uses existing file-extractor.ts — PDFs as Claude-native document blocks, Office files extracted
- Fast path can answer "what's in this PDF?" without deep path

### Security Hardening
- Subprocess env: allowlist only (Slack tokens excluded)
- Write tool removed from deep path allowed tools
- Final response sanitized via scanForSecrets() before Slack post
- Findings file: UUID-stamped per invocation (no race conditions)
- Full mitigation plan at docs/MITIGATION_PLAN.md

### Design Docs
- `docs/DESIGN_PLUGIN_ADAPTER.md` — plugin adapter + unified memory bridge
- `docs/MITIGATION_PLAN.md` — security + quality mitigation plan

---

## Architecture After Session 15

### Fast Path (Sonnet, ~$0.01, ~2s)
- Direct `messages.create` loop
- 12 tools: memory (search/browse, update working ctx), calendar (list/get/freebusy), gmail (search/read), drive (search/get with PDF+doc content), fireflies (search/summary), slack (history/search)
- 30 max turns, 5 min timeout
- search_memory works without query (browse by importance/recency)

### Deep Path (Opus, $0 on Max, ~3-5min)
- `claude --print --verbose --output-format stream-json` subprocess
- Pre-flight: LLM-driven conversation to refine scope before launch
- Memory reads via MCP (search, retrieve, list) — no writes during execution
- Findings written to temp file in one Bash call at end → background processor stores
- Subprocess env allowlisted (no Slack tokens)
- Configurable pre-flight reminder interval

### Memory System
- Dynamic categories (16 seed + organic discovery, normalize-on-add)
- Entity junction table for O(log n) entity lookups
- Path-aware budgets: 1500 tokens (fast) vs 50000 tokens (deep)
- Relevance-based retrieval (no hardcoded type pulls)
- Async findings file: zero overhead during deep path research
- FTS5-based consolidation with configurable decay/archive exemptions
- Weekly category reorganization

---

## Backlog (priority order)

1. **PROACTIVE-001**: Daily/weekly briefing — proactive morning summary
2. **PLUGIN-001**: Plugin adapter + unified memory bridge — CC↔Slack memory sharing
3. **SESSION-001**: --session support for deep path thread continuity
4. **COMMIT-001**: Commitment tracking + follow-up reminders
5. **GITHUB-001**: GitHub integration
6. **FINANCE-001**: Finance integration (invoicing, bookkeeping, A/P)
7. **MITIGATION-P2**: Security Priority 2-3 fixes
8. **OBSIDIAN-001**: Obsidian integration for memory visibility
