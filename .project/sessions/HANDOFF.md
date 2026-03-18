# Session Handoff

> Last updated: 2026-03-18 | Session 12 | Sprint S2

## Quick Resume

```
Sprint: S2 — Integrations + Polish
Status: Tracks A-D complete, major quality + UX improvements this session
Tests: 297/297 passing across 22 files
Tools: 29 total (7 Slack + 19 Google + 3 memory/context)
Deploys: 14 commits shipped this session
```

## Current State

**Completion**: ~80%
**Working**: Full stack — all file types readable, production reaction lifecycle, real-time progress, externalized prompts, configurable tunables, chunked extraction with Sonnet synthesis, source-attributed responses.
**Cloud**: Railway with persistent volume. Google OAuth active.

## Key Wins This Session

- **Drive file type expansion** (DRIVE-001 resolved) — PDF, images, docx, xlsx, pptx, HTML, CSV all readable
- **Production reaction lifecycle** (DEBUG-001 resolved) — 👀→🧠→progress→response, 20s delay on progress message
- **Mid-loop text bug fixed** — bot no longer posts "thinking out loud" as the final response
- **MAX_TURNS 15→30, timeout 5→10min** — bot can finish complex multi-file tasks
- **Folder path filter** — google_drive_list_known supports folder_path queries
- **Drive search returns folder names + IDs** — no more "file is in root" when it's in a subfolder
- **Source attribution** — system prompt requires file reads for document tasks, citation of sources
- **Slack mrkdwn formatting** — native markdown block + no-tables prompt
- **Externalized prompts** — 6 prompts in config/prompts/*.md, editable without code changes
- **Consolidated config** — all tunables in config/default.json with Zod validation
- **Chunked extraction + Sonnet synthesis** — full document coverage, high-resolution memory
- **File content returned to agent** — drive_read_content returns actual text, not just "facts extracted"
- **PDF extraction fixed** — was failing due to truncated JSON (max_tokens too low)

## Architecture Changes

### Prompts externalized
All 6 prompts moved from code to `config/prompts/*.md`. Template syntax `{{VARIABLE}}` with startup validation. Edit prompts without code changes.

### Config consolidated
All operational tunables in `config/default.json` — agent (maxTurns, timeout), context (token budgets), slack (progress timing, accumulation windows), memory (consolidation, decay, reflection), drive (batch size, file limits).

### File extraction pipeline
New `src/google/file-extractor.ts` — mime-type dispatch for arbitrary files. PDF/images → Claude-native blocks. Office formats → mammoth/exceljs/jszip. HTML → htmlparser2. CSV/text → direct.

### Reaction lifecycle
Handler owns full lifecycle: 👀 on receipt → remove 👀 + add 🧠 on process → progress message after 20s delay → remove 🧠 + delete progress on response.

### Memory extraction pipeline
Documents → split into 8K overlapping chunks → Haiku extracts from each → Sonnet deduplicates/enriches/re-scores → store with embeddings. ~$0.04/file, full coverage.

### drive_read_content returns content
Tool now returns actual file text to the agent (not just "facts extracted"). Background extraction runs fire-and-forget for long-term memory.

## Known Issues

| ID | Severity | Description |
|---|---|---|
| TW-001 | Medium | Training wheels confirmation gate is MVP (logs but allows) |
| DEEPREAD-001 | Low | Optimize deep reading — skip re-read if file unchanged |
| DRIVE-002 | Low | Drive folder scope — allow-list of folder IDs in config |
| OBSIDIAN-001 | Low | Obsidian integration — human visibility layer for agent memory |

## Next Session Priority

1. **Cross-source intelligence** — auto to-do, CRM, project management from Slack+email+meetings
2. **Claude Code orchestration** — agent as PM directing coding sessions
3. **Track E: Workflow Engine + Scheduling** — durable state machines, async workflows
4. **TW-001: Training wheels confirmation gate** — wire up real confirmation flow
5. **OBSIDIAN-001** — Obsidian export/sync layer for memory visibility

## Key Files

| File | Why It Matters |
|---|---|
| `config/prompts/system.md` | Main bot behavior prompt — edit without code changes |
| `config/default.json` | All tunable parameters — edit without code changes |
| `src/agent/index.ts` | Agent loop, tool registration, context assembly |
| `src/google/drive-sync.ts` | Drive sync, chunked extraction, Sonnet synthesis |
| `src/google/file-extractor.ts` | Mime-type dispatch for arbitrary file types |
| `src/google/tools.ts` | 19 Google tools (Calendar, Gmail, Drive) |
| `src/prompts.ts` | Prompt loader with template resolution |
| `src/slack/handler.ts` | Reaction lifecycle, progress messages |
| `src/memory/store.ts` | Memory + People CRUD, FTS5, vector search |
| `src/memory/extractor.ts` | Haiku extraction from conversations |

## Owner Preferences (confirmed this session)

- Memory should be HIGH RESOLUTION — invest in extraction quality, budget allows $1-2K/month
- Let the bot finish its work — don't force premature answers
- Prefers prompt-based fixes over scaffolding
- Don't over-engineer
- Likes freedom/flexibility (search all of Drive) but wants option to scope later
- Wants Obsidian integration for human visibility into agent memory
