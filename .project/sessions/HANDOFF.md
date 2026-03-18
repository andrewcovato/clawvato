# Session Handoff

> Last updated: 2026-03-18 | Session 12 | Sprint S2

## Quick Resume

```
Sprint: S2 — Integrations + Polish
Status: Tracks A-D complete, Fireflies integration shipped, major quality pass
Tests: 297/297 passing across 22 files
Tools: 33 total (7 Slack + 20 Google + 4 Fireflies + 2 memory/context)
Commits this session: ~28
```

## Current State

**Completion**: ~85%
**Working**: Full stack — all file types, Fireflies meetings, production UX, externalized prompts/config, high-resolution memory, cross-source queries (Slack + Drive + Fireflies + Gmail live).
**Cloud**: Railway with persistent volume. Google OAuth + Fireflies API key active.
**Trust level**: 1 (read-only auto-approved, writes require confirmation)

## Key Wins This Session

### Features
- **Drive file type expansion** (DRIVE-001 resolved) — PDF, images, docx, xlsx, pptx, HTML, CSV via mammoth/exceljs/htmlparser2/Claude-native
- **Fireflies.ai integration** — 4 tools: search, summary, deep read, sync. Three-tier model matching Drive.
- **Gmail thread reading** — `gmail_read` now fetches full thread (all replies), supports batch parallel (up to 10 threads)
- **Gmail background extraction** — reading an email thread automatically extracts facts into memory
- **Folder path filter** — `drive_list_known` supports folder_path queries
- **Drive search returns folder names + IDs** — no more misattributed file locations

### UX
- **Production reaction lifecycle** (DEBUG-001 resolved) — 👀→🧠→progress→response
- **20s progress delay** — quick responses stay clean, long tasks get real-time status
- **Slack markdown blocks** — native rendering for bold, headings, code (no tables — uses bulleted key-value pairs)
- **No more mid-loop thinking posted as responses** — only final turn text is captured

### Architecture
- **Externalized prompts** — 8 prompt files in config/prompts/*.md, editable without code changes
- **Consolidated config** — all tunables in config/default.json with Zod validation
- **Chunked extraction + Sonnet synthesis** — full document/meeting coverage at ~$0.04/file
- **drive_read_content returns actual content** — agent answers from source, not memory fragments
- **Source attribution required** — system prompt forbids answering doc questions from memory alone
- **Email always live** — no email sync (threads change too fast), always fresh search + read

### Security & Quality (from code review)
- **Training wheels enforced** — was always auto-approving, now actually blocks at trust level
- **Policy engine fixed** — prefixed tool names (google_*, fireflies_*) now correctly categorized
- **Drive ID validation** — folder_id/file_id checked against regex
- **Batch processing serialized** — prevents concurrent corruption of handler state
- **Drive sync DB writes sequential** — prevents double-insert race conditions
- **Reflection INSERT fixed** — was silently failing, causing runaway triggers
- **PDF extraction fixed** — was failing due to truncated JSON (max_tokens too low)
- **MAX_TURNS 15→30, timeout 5→10min** — bot can finish complex multi-file tasks

## Data Source Architecture

| Source | Query Pattern | Memory Pattern |
|---|---|---|
| **Drive** | Sync (Tier 1-3) + live search | Sync stores summaries + facts. Deep read returns content + background extraction. |
| **Fireflies** | Sync (Tier 1-2) + live search/read | Sync stores meeting summaries + commitments. Deep read returns transcript + background extraction. |
| **Gmail** | Always live search + thread read | Background extraction on read. No sync (threads change too fast). |
| **Slack** | Live (short-term context) + scan_channel_history | Conversation extraction after each interaction. Channel scan for backfill. |

## Known Issues / Backlog

### Medium (from security/quality review)
- TW-002: Real confirmation UX (currently blocks with error, needs Slack button/DM)
- SEC-001: FTS5 query injection — wrap in double-quotes
- SEC-002: HTML extractor skipContent nesting
- SEC-003: Google refresh token in output sanitizer
- SEC-004: Persist rate limiter to DB
- SEC-005: Post-tool sanitizer non-string outputs
- SEC-006: Trust-tag messages in scan_channel_history
- QUAL-001: Remove deprecated getFilePath from buildFolderPathMap
- QUAL-002: Cache hasVectorSupport probe
- QUAL-003: Add LIMIT to consolidation merge query

### Low (feature backlog)
- DEEPREAD-001: Skip re-read if file unchanged
- DRIVE-002: Folder scope allow-list
- OBSIDIAN-001: Obsidian integration layer
- Gmail webhooks (Pub/Sub) for proactive memory updates
- Fireflies webhooks for new meeting auto-sync
- Opus model integration (planner role — currently unused)

## Next Session Priority

1. **Track E: Workflow Engine + Scheduling** — durable state machines, async multi-step workflows
2. **Track G: GitHub + Web Research** integrations
3. **Cross-source intelligence polish** — "list everything outstanding by project" across all sources
4. **TW-002: Real confirmation UX** — Slack buttons or DM-based approval
5. **Webhook infrastructure** — Gmail Pub/Sub, Fireflies webhooks (needs Track E)

## Key Files

| File | Why It Matters |
|---|---|
| `config/prompts/system.md` | Main bot behavior — edit without code changes |
| `config/prompts/` | 8 prompt files: system, summary, extraction, doc-extraction, email-extraction, meeting-extraction, reflection, interrupt-classification |
| `config/default.json` | All tunable parameters |
| `src/agent/index.ts` | Agent loop, tool registration, context assembly |
| `src/google/drive-sync.ts` | Drive sync, chunked extraction, Sonnet synthesis |
| `src/google/file-extractor.ts` | Mime-type dispatch for arbitrary file types |
| `src/google/tools.ts` | 20 Google tools (Calendar 8, Gmail 6, Drive 5 + gmail_read override in agent) |
| `src/fireflies/api.ts` | Fireflies GraphQL client |
| `src/fireflies/tools.ts` | 4 Fireflies tools |
| `src/fireflies/sync.ts` | Meeting sync with chunked extraction |
| `src/prompts.ts` | Prompt loader with {{VARIABLE}} templates |
| `src/slack/handler.ts` | Reaction lifecycle, progress messages |
| `src/training-wheels/policy-engine.ts` | Trust level enforcement |
| `src/config.ts` | Zod config with all tunables + env var loading |

## Owner Preferences (confirmed this session)

- Memory should be HIGH RESOLUTION — invest in extraction quality, budget $1-2K/month
- Let the bot finish its work — don't force premature answers
- Always parallelize API fetches
- Email: always live search, never sync (threads change too fast)
- Prefers prompt-based fixes over scaffolding
- Don't over-engineer — pulled Gmail sync when it didn't make sense
- Wants Obsidian integration for memory visibility (future)
- Fireflies webhooks on roadmap after proactive behavior track
