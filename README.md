# Clawvato

An always-on personal AI agent that runs as your chief of staff. Manages Slack, Gmail, Google Calendar, Google Drive, and a structured long-term memory — all through natural conversation in Slack.

Built on the Anthropic API with a three-model architecture, deployed on Railway via Docker.

## What It Does

Talk to Clawvato in Slack like you'd talk to a capable assistant:

- "What's on my calendar this week?"
- "Find that email from Sarah about the budget"
- "Cancel my 3pm meeting and let attendees know"
- "Remember that we're pivoting Client X to a land-and-expand strategy because procurement is blocking the enterprise deal"
- "What was our strategy for Client X again?"

The bot listens to all messages in channels it's joined, decides when to respond (using a relevance gate), and automatically extracts facts, strategies, and people from every conversation into long-term memory.

## Architecture

### Three-Model Design

| Model | Role | Use |
|---|---|---|
| **Haiku** | Classifier | Fact extraction, importance scoring, interrupt classification, reflection |
| **Sonnet** | Executor | Responding to messages, tool calls, reasoning |
| **Opus** | Planner | Reserved for complex planning (not yet wired) |

### Memory System

Every interaction is automatically mined for structured information. No "remember this" needed.

```
Message arrives → Agent responds → Haiku extracts facts in background
                                         ↓
                                   Store in SQLite with:
                                   - FTS5 keyword index
                                   - Vector embeddings (384-dim MiniLM)
                                   - Importance score (1-10)
                                   - Confidence, entities, timestamps
                                         ↓
                              Next message arrives → retrieve relevant
                              memories via hybrid search (FTS5 + vector)
                              → inject into prompt as context
```

**Three memory tiers:**

| Tier | Source | Budget | Lifecycle |
|---|---|---|---|
| **Working context** | `agent_state` scratch pad | 1000 tokens | Active → sleeping (14 days) → wakes on query match. Never deleted. |
| **Short-term** | Slack messages (last 50) | 2000 tokens | Re-fetched each interaction. Channel name included for context. |
| **Long-term** | SQLite memories DB | 1500 tokens | Extracted facts, searched via hybrid FTS5 + vector (RRF). |

Working context tracks operational details (folder IDs, draft IDs, project status) that persist across messages and channels. After 14 days without update, entries sleep — they're excluded from prompts but remain searchable. When a query matches a sleeping entry, it automatically wakes and re-enters the active prompt. Summaries are promoted to long-term memory on sleep.

Each API call is a **fresh session** — no persistent conversation state. The three memory tiers provide continuity between interactions.

#### Memory Types

| Type | What it captures | Example |
|---|---|---|
| `fact` | Things true about the world | "Marcus is on the finance team" |
| `preference` | How the owner likes things | "Prefers meetings after 10am" |
| `decision` | Choices made, with reasoning | "Decided to delay launch because vendor wasn't ready" |
| `strategy` | Plans and approaches with rationale | "Pivoting Client X to land-and-expand because enterprise deal stalled" |
| `conclusion` | Insights and analyses | "Pipeline issue is that we're qualifying leads too late" |
| `commitment` | Promises and deadlines | "Told Client X we'd deliver the proposal by Friday" |
| `observation` | Patterns not yet confirmed | "Andrew tends to decline Friday afternoon meetings" |
| `reflection` | Synthesized insights | Auto-generated when cumulative importance exceeds threshold |

#### Consolidation

Runs on startup if >24 hours since last run:
- **Merge duplicates** (content similarity > 85%)
- **Decay stale memories** (importance *= 0.9 after 30 days, *= 0.7 after 90 days)
- **Archive** memories with importance ≤ 1
- Preferences and commitments are never auto-archived

#### Reflection

When cumulative importance of new memories exceeds 50, Haiku synthesizes 3-5 high-level insights stored as `reflection` type. These surface patterns the agent wouldn't catch from individual facts.

### Slack Interaction Model

The bot listens to all messages in joined channels like a human would.

**When it responds:**
- Owner is talking to it (directly, by @mention, or contextually)
- Follow-up to a conversation it was part of
- Outstanding requests after coming back online

**When it stays silent:**
- People talking to each other
- General announcements or social chatter
- Everything already handled

**Reaction lifecycle** (production UX):
- 👀 = message received (removed when processing starts)
- 🧠 = agent is processing (removed when response is posted)
- Progress message appears after 20s with real tool-call descriptions (e.g., "Checking your calendar...")
- Progress auto-refreshes every 60s if a single tool call is slow

**Message accumulation**: Messages are buffered with a configurable debounce window (default 4s) before processing, to handle multi-message inputs.

**Startup crawl**: On boot (if offline >5 minutes), checks joined channels for missed messages.

### Tools

#### Slack (7 tools)
| Tool | Action |
|---|---|
| `slack_search_messages` | Search across channels (uses user token) |
| `slack_post_message` | Post to channel or thread |
| `slack_get_thread` | Read a thread |
| `slack_get_user_info` | Look up a Slack user |
| `slack_get_channel_history` | Read recent channel messages |
| `search_memory` | Deep search long-term memory |
| `scan_channel_history` | Backfill: scan channel and extract to memory |

#### Google Calendar (8 tools)
| Tool | Action |
|---|---|
| `google_calendar_list_events` | List upcoming events (with IDs) |
| `google_calendar_create_event` | Create with attendees, location |
| `google_calendar_delete_event` | Cancel + notify attendees |
| `google_calendar_update_event` | Reschedule, rename, add attendees |
| `google_calendar_find_free` | Find free time slots |
| `google_calendar_rsvp` | Accept/decline/tentative invites |
| `google_calendar_freebusy` | Check others' availability |
| `google_calendar_get_event` | Full event details |

#### Gmail (6 tools)
| Tool | Action |
|---|---|
| `google_gmail_search` | Search with Gmail syntax (with IDs) |
| `google_gmail_read` | Read full email thread (all replies). Batch: accepts array of message_ids for parallel fetch. Background fact extraction. |
| `google_gmail_draft` | Create draft (safe — doesn't send) |
| `google_gmail_send_draft` | Send after owner confirmation |
| `google_gmail_reply` | Reply/reply-all (creates draft first) |
| `google_gmail_label` | Star, archive, mark read, label |

**Email philosophy**: Always search and read live — never sync. Email threads evolve too fast for a sync pattern. Memories accumulate naturally as the bot reads threads (background extraction on every read).

#### Google Drive (5 tools)
| Tool | Action |
|---|---|
| `google_drive_search` | Find files by name/type (returns folder name + file ID) |
| `google_drive_get_file` | Metadata, sharing, permissions |
| `google_drive_sync` | Scan Drive/folder, index files, generate summaries |
| `google_drive_read_content` | Read file content (returns text to agent) + background fact extraction |
| `google_drive_list_known` | Browse indexed files by folder path or name |

#### Fireflies.ai (4 tools)
| Tool | Action |
|---|---|
| `fireflies_search_meetings` | Find meetings by keyword, date, participant |
| `fireflies_get_summary` | Meeting overview, action items, participants (Tier 2) |
| `fireflies_read_transcript` | Full transcript with speaker labels + timestamps (Tier 3). Background extraction. |
| `fireflies_sync_meetings` | Sync recent meetings into memory (parallel batch fetch) |

### Drive Knowledge Sync

The bot maintains a living map of your Drive files using a three-tier model:

- **Tier 1 (File Index)**: Metadata — name, type, owner, modified time. Stored in `documents` table.
- **Tier 2 (Summaries)**: Haiku-generated conclusions about each file, stored as memories. Folder path used as evidence for categorization ("Acme Corp is a client" not "File is in Clients folder").
- **Tier 3 (Deep Read)**: Full content export + fact extraction into memory. On-demand.

Sync uses hash-based delta detection — unchanged files are skipped. Self-healing checks that every file summary memory matches the expected content; if the format evolves, stale memories are automatically superseded on next sync.

**Conflict resolution**: Owner's direct Slack statement > recent document > old document > inference. When a document contradicts a recent owner statement, the owner's version is preserved.

**File type support**: All common formats — Google-native (Docs, Sheets, Slides) via export, PDF and images via Claude-native document/image blocks, Office formats (docx/xlsx/pptx) via mammoth/exceljs/jszip, HTML via htmlparser2, CSV/TSV/text/JSON via direct read.

**Extraction pipeline**: Long documents are split into 8K overlapping chunks, each extracted by Haiku independently, then refined by a Sonnet synthesis pass that deduplicates, resolves conflicts, and enriches context. Cost: ~$0.04/file for full coverage.

## Configuration

### Prompts

All prompts are externalized in `config/prompts/*.md` — edit without code changes, restart to apply:

| File | Purpose |
|---|---|
| `system.md` | Main bot personality, behavior, guidelines |
| `summary.md` | Drive file summary generation |
| `doc-extraction.md` | Fact extraction from documents |
| `extraction.md` | Fact extraction from Slack conversations |
| `reflection.md` | Memory consolidation insights |
| `interrupt-classification.md` | Interrupt type classification |

Template variables use `{{VARIABLE}}` syntax. See `config/prompts/README.md` for the glossary.

### Tunable Parameters

All operational tunables live in `config/default.json` (override via `~/.clawvato/config.json` or env vars):

**Agent:**
| Parameter | Default | Purpose |
|---|---|---|
| `agent.maxTurns` | 30 | Max tool-call turns per interaction |
| `agent.timeoutMs` | 600000 | Max time per interaction (10 min) |

**Context budgets:**
| Parameter | Default | Purpose |
|---|---|---|
| `context.shortTermMessageLimit` | 50 | Slack messages fetched per interaction |
| `context.shortTermMsgCharLimit` | 1000 | Max chars per Slack message |
| `context.shortTermTokenBudget` | 2000 | Token cap for Slack context |
| `context.longTermTokenBudget` | 1500 | Token cap for DB memory retrieval |
| `context.workingContextTokenBudget` | 1000 | Token cap for working context |

**Slack:**
| Parameter | Default | Purpose |
|---|---|---|
| `slack.progressDelayMs` | 20000 | Delay before showing progress message |
| `slack.progressStaleIntervalMs` | 60000 | Refresh progress if no tool-call update |
| `slack.accumulationWindows.patient` | 4000 | Default debounce window (ms) |

**Memory:**
| Parameter | Default | Purpose |
|---|---|---|
| `memory.consolidationIntervalHours` | 24 | Hours between consolidation runs |
| `memory.mergeSimilarityThreshold` | 0.85 | Content similarity for merging duplicates |
| `memory.reflectionThreshold` | 50 | Cumulative importance to trigger reflection |
| `memory.workingContextArchiveDays` | 14 | Days before working context sleeps |

**Drive:**
| Parameter | Default | Purpose |
|---|---|---|
| `drive.maxExtractedChars` | 50000 | Max chars extracted from files |
| `drive.syncBatchSize` | 10 | Parallel file processing batch size |
| `drive.maxFileSizeBytes` | 52428800 | Max file size to download (50 MB) |

## Epistemology

The bot operates as a humble scientist — persistently skeptical of its own knowledge:

- **Source tracing**: When retrieving a memory or fact, considers the source. A direct owner statement is stronger than an inference from a file name. If a belief can't be traced to a specific, reliable source, the bot says so.
- **Owner authority**: When memories conflict with what the owner is saying now, trusts the owner.
- **Transparent reasoning**: When making categorizations or judgments (like "X is a client"), shows its reasoning and invites correction.
- **Named assumptions**: If an answer depends on an assumption, names the assumption.
- **Anti-echo-chamber**: Doesn't reinforce weak memories by repeating them. If something is uncertain, flags it and offers to verify.

This was added after discovering the bot was "laundering memory assumptions as ground truth" — confidently presenting low-quality early extractions as authoritative facts. The epistemology section ensures the bot is honest about what it knows vs what it's guessing.

**Working context philosophy**: The scratch pad stores human-meaningful state ("synced GBS folder, confirmed clients: Vail, Coles"), not implementation details (raw IDs, API responses). The agent can always look up IDs by name — storing them clutters context and they can go stale.

## Security Model

**Single-principal authority**: Only the owner (identified by `OWNER_SLACK_USER_ID`) can instruct the bot. This is **required** — the bot will not start without it configured. If unset, startup fails hard.

**Trust boundaries**: Messages from non-owner Slack users are tagged `[EXTERNAL]` in all contexts. The memory extraction pipeline extracts factual information from all messages but only extracts preferences, decisions, strategies, and commitments from `[TRUSTED]` (owner) messages. This prevents prompt injection via crafted Slack messages.

**External content labels**: Email bodies returned by Gmail tools are wrapped in `[EXTERNAL CONTENT]` markers. The system prompt instructs the agent to treat tool results as data to report, not instructions to follow.

**Secret scanning**: All tool outputs are scanned for credential patterns (API keys, OAuth tokens, etc.) *before* being written to the audit log. Secrets never hit disk.

**Training wheels** (trust levels 0-3):
- Level 0: All actions require confirmation (current default — logs but allows for MVP)
- Level 1: Read-only actions auto-approved
- Level 2: Graduated patterns auto-approved
- Level 3: Most actions auto-approved

**Gmail safety**: Email sending always goes through a draft-then-send flow. The bot creates a draft and asks for confirmation before sending.

**Drive query sanitization**: Search queries are stripped of special characters that could be interpreted as Drive API query operators.

## Setup

### Prerequisites
- Node.js ≥ 22.12.0
- A Slack workspace with a Socket Mode app
- (Optional) Google Workspace account for Calendar/Gmail/Drive

### First-Time Setup

```bash
git clone https://github.com/andrewcovato/clawvato.git
cd clawvato
npm install
npx tsx src/cli/index.ts setup   # Interactive wizard
```

### Google Workspace Setup

```bash
npm install -g @googleworkspace/cli
brew install --cask google-cloud-sdk

# Create GCP project and OAuth credentials
gcloud auth login
gcloud projects create clawvato-agent --name="Clawvato Agent"
gcloud config set project clawvato-agent
gcloud services enable gmail.googleapis.com calendar-json.googleapis.com drive.googleapis.com

# Create OAuth client in Cloud Console:
# https://console.cloud.google.com/apis/credentials?project=clawvato-agent
# → Create Credentials → OAuth client ID → Desktop app

# Login with gws
export GOOGLE_WORKSPACE_CLI_CLIENT_ID="<your-client-id>"
export GOOGLE_WORKSPACE_CLI_CLIENT_SECRET="<your-client-secret>"
gws auth login -s gmail,calendar,drive

# Export tokens
gws auth export --unmasked
# Copy client_id, client_secret, refresh_token
```

### Running Locally

```bash
npx tsx src/cli/index.ts start
```

### Deploying to Railway

```bash
npm install -g @railway/cli
railway login
railway init --name clawvato
railway volume add --mount-path /data

# Set environment variables in Railway dashboard:
# ANTHROPIC_API_KEY, SLACK_BOT_TOKEN, SLACK_APP_TOKEN, SLACK_USER_TOKEN,
# OWNER_SLACK_USER_ID, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN

railway up --detach -m "deploy"
```

### Running Tests

```bash
npm test          # 297 tests across 22 files, 33 tools
npm run build     # TypeScript compile
npm run lint      # Type-check without emitting
```

## Project Structure

```
src/
  agent/          # Agent orchestration, tool loop, context assembly
  cli/            # Commander.js CLI (setup, start, status)
  db/             # SQLite + sqlite-vec, schema
  fireflies/      # Fireflies.ai — GraphQL client, 4 tools, meeting sync
  google/         # Google Workspace auth + 20 tools + file extractor
  hooks/          # PreToolUse / PostToolUse security hooks
  memory/         # Extraction, retrieval, embeddings, reflection, consolidation
  mcp/slack/      # Slack tool definitions + handlers
  security/       # Sender verify, output sanitizer, path validator, rate limiter
  slack/          # Event queue, handler, interrupt classifier, Socket Mode
  training-wheels/ # Trust level policy + pattern graduation
  config.ts       # Zod-validated config with all tunables
  credentials.ts  # Keychain (macOS) + env var fallback
  logger.ts       # Pino structured logging
  prompts.ts      # Prompt loader with {{VARIABLE}} template resolution
config/
  default.json    # All tunable parameters
  prompts/        # Externalized prompts (system, extraction, summary, etc.)
tests/            # Vitest — mirrors src/ structure
Dockerfile        # Railway deployment (node:22-slim)
```

## Design Decisions

| Decision | Rationale |
|---|---|
| Direct API, not Agent SDK | Eliminated 1-3s subprocess spawn per message |
| `node:sqlite`, not better-sqlite3 | Avoids native compilation, works everywhere |
| sqlite-vec for vectors | Prebuilt binaries for macOS + Linux, fast k-NN |
| Local embeddings (MiniLM) | $0 cost, no network latency, ~1ms per text |
| Hybrid search (FTS5 + vector) | Keywords catch exact matches, vectors catch semantic |
| Extract facts, not chunks | 5-10x more token-efficient than raw RAG |
| 8 memory types | Richer than fact/preference — captures strategy, reasoning, commitments |
| Fresh API session per message | No context bloat, flat costs, memory DB provides continuity |
| Gmail draft-then-send | Safety — never auto-sends email without confirmation |
| keytar optional | Enables headless/Linux deployment via env vars |
| gws CLI for OAuth, googleapis for runtime | Best of both — easy setup, fast execution |
| File summaries as memories, not separate table | Unified retrieval — one pipeline searches everything |
| Conclusion-style summaries | "Acme is a client" not "File contains proposal" — agent reasons better |
| Self-healing content comparison | Format improvements auto-propagate on next sync |
| Folder path as evidence, not gospel | Files can be misfiled — content wins over structure |
| Sleep/wake working context | Never loses operational details — sleeps after 14 days, wakes on query match |
| Three memory tiers | Working context (active ops) + Slack (short-term) + DB (long-term) |
| Epistemological humility | Bot traces beliefs to sources, flags uncertainty, invites correction |
| Folder path map (BFS) | Builds complete folder→path map upfront instead of per-file API calls |
| Externalized prompts | Edit behavior without code changes — prompts are Markdown files |
| Consolidated config | All tunables in one JSON file with Zod validation |
| Chunked extraction + Sonnet synthesis | Full document coverage at ~$0.04/file — Haiku chunks + Sonnet refinement |
| Claude-native PDF/image handling | No parsing libraries needed — send raw bytes to Claude vision/document API |
| Return content to agent | drive_read_content returns file text, not just "facts extracted" — agent answers from source |
| Document tasks require file reads | System prompt forbids answering document questions from memory alone |
| 20s progress message delay | Quick responses (<20s) show only 🧠 reaction — no flashing status messages |
| Fireflies native (no MCP) | Direct GraphQL client — same pattern as Google tools, memory integration |
| Email: live search, no sync | Threads evolve too fast for sync. Memories accumulate from reads. |
| Gmail thread reading | `gmail_read` fetches full thread (all replies), supports batch parallel |
| Parallel everywhere | API fetches parallelized (5-10 concurrent), DB writes sequential |
| Training wheels enforced | Policy engine actually blocks non-approved tools (was bypassed as MVP) |
| Prefixed tool name matching | Policy regexes use `(?:^|_)` to match google_*, fireflies_* tool names |

## License

Private — not open source.
