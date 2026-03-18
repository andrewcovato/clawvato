# Feature Backlog

> Priority: P0 = blocker, P1 = next sprint, P2 = soon, P3 = later
> Last updated: 2026-03-18

## P0 — Blockers

- [ ] **DRIVE-001: Expand file type support** — Currently only exports Google-native formats (Docs/Sheets/Slides). Need to handle:
  - `.docx` — download + parse with a library (e.g., mammoth)
  - `.pdf` — download + extract text (e.g., pdf-parse)
  - `.xlsx` / `.csv` — download + parse (e.g., xlsx or csv-parser)
  - `.txt` / `.md` — download raw content directly
  - `.pptx` — download + extract text
  - Fallback: for unsupported types, generate summary from file name + folder path alone
  - Consider: should we store the raw content or just the extraction? (extraction only — cheaper, smaller)

## P1 — Current Sprint

- [ ] **Training wheels confirmation gate (TW-001)** — Actually block destructive tools until owner confirms via Slack Block Kit
- [ ] **Remove debug reactions (DEBUG-001)** — Remove 👀/🧠 reactions
- [ ] **Summary from name+path fallback** — When file content can't be exported, generate a basic summary from just the file name and folder structure. "Acme Corp is likely a client (inferred from folder: Clients/Acme Corp)" with lower confidence.
- [ ] **Folder exclusion patterns** — Allow excluding folders like "Test Data", "Archive", "Trash" from sync. Store in config.
- [ ] **Drive file sharing tools** — share/unshare files with people, the most common Drive ask after search

## P2 — Next Sprint

- [ ] **Track E: Workflow engine** — SQLite-backed state machine, checkpoint/recovery
- [ ] **Track E: Scheduling workflow** — finding_slots → proposing_times → waiting_reply → booking
- [ ] **Track G: GitHub integration** — Direct API (same pattern as Google tools)
- [ ] **Track G: Web research** — Playwright or built-in WebSearch/WebFetch tool
- [ ] **Track H: Daily briefing** — Morning DM with calendar, pending items, flagged memories
- [ ] **Track H: Proactive pattern detection** — Recurring pattern analysis from memory + action log
- [ ] **One-click deploy flow** — Automate gws auth + railway setup into a single command
- [ ] **Create/move/copy Drive files** — Full file management (lower priority than read/share)

## P3 — Later / Multi-Agent Prep

- [ ] **Multi-principal support** — Replace single `OWNER_SLACK_USER_ID` with a `principals` table mapping users to permission levels
- [ ] **Per-user OAuth tokens** — Replace singleton `google/auth.ts` with a token registry keyed by user ID
- [ ] **Structured source tracking** — Migrate `source` free-text field to structured columns: `source_type`, `source_id`, `source_agent`, `source_user`
- [ ] **PostgreSQL migration path** — SQLite works for single-agent. Multi-agent concurrent writes may need PostgreSQL
- [ ] **Parameterized system prompt** — Template per-agent or per-conversation for multi-user
- [ ] **Track F: Undo system** — 5-minute undo window, reverse-action registry
- [ ] **Track G: Plugin manager** — CLI add/remove/list, manifest storage
- [ ] **Track H: Context bridge** — Cross-source intelligence (Slack + email + calendar + Drive)
- [ ] **Track H: Suggestion engine** — "What Would You Do?" mode with feedback learning
- [ ] **Fireflies integration** — Extract facts from meeting transcripts into memory
- [ ] **Embedding-based change detection** — Compare old vs new document embeddings to detect meaningful changes without full re-read
- [ ] **Claude Code orchestration** — Clawvato as product manager, Claude Code as coder. Agent assembles rich business context (memories, files, decisions, working context) into a Claude Code prompt, spawns a session, reviews output, reports back via Slack. Solves cold-start problem — every Claude Code session starts with full business context. Can be used for:
  - Building/maintaining external projects (agent knows the business, directs the coding)
  - Self-improvement (agent identifies its own gaps, spawns Claude Code to fix them, runs tests, deploys via Railway)
  - Requires: filesystem tools (read/write/grep), git tools (branch/commit/push/PR), shell execution (npm test/build), Claude Code CLI or direct API with coding system prompt
  - Key insight: Clawvato is the context bridge between business knowledge and coding capability

## Completed

- [x] Track A: Core Foundation
- [x] Track B: Slack + Agent Core (direct API, no subprocess)
- [x] Track C: Google Workspace (19 tools — Calendar, Gmail, Drive)
- [x] Track D: Memory + Embeddings (all 5 phases)
- [x] Railway deployment + persistent volume
- [x] Security hardening (30 issues fixed)
- [x] Code quality sweep (all audit items resolved)
- [x] Drive knowledge sync architecture (3-tier, conflict resolution, self-healing)
