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

**Short-term memory**: Last 50 Slack messages from the channel (re-fetched each time).
**Long-term memory**: SQLite database with extracted facts, searched via hybrid Reciprocal Rank Fusion.

Each API call is a **fresh session** — no persistent conversation state. Memory DB + Slack history provide continuity between interactions.

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

**Debug reactions** (temporary, will be removed):
- 👀 = message received by handler
- 🧠 = agent decided to act

**Message accumulation**: Messages are buffered with a 4-second debounce window before processing, to handle multi-message inputs.

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
| `google_gmail_read` | Read full email content |
| `google_gmail_draft` | Create draft (safe — doesn't send) |
| `google_gmail_send_draft` | Send after owner confirmation |
| `google_gmail_reply` | Reply/reply-all (creates draft first) |
| `google_gmail_label` | Star, archive, mark read, label |

#### Google Drive (2 tools)
| Tool | Action |
|---|---|
| `google_drive_search` | Find files by name/type |
| `google_drive_get_file` | Metadata, sharing, permissions |

## Tunable Parameters

All context limits are centralized as named constants in `src/agent/index.ts`:

| Parameter | Default | Purpose |
|---|---|---|
| `AGENT_TIMEOUT_MS` | 120000 | Max time per agent interaction (ms) |
| `SHORT_TERM_MESSAGE_LIMIT` | 50 | Slack messages fetched per interaction |
| `SHORT_TERM_MSG_CHAR_LIMIT` | 1000 | Max chars per Slack message |
| `SHORT_TERM_TOKEN_BUDGET` | 2000 | Token cap for Slack context (drops oldest first) |
| `LONG_TERM_TOKEN_BUDGET` | 1500 | Token cap for DB memory retrieval |
| `MAX_TURNS` | 15 | Max tool-call turns per interaction |
| `NO_RESPONSE` | `[NO_RESPONSE]` | Sentinel the agent outputs to stay silent |

Memory system parameters in their respective files:

| Parameter | Default | File | Purpose |
|---|---|---|---|
| `REFLECTION_THRESHOLD` | 50 | `src/memory/reflection.ts` | Cumulative importance to trigger reflection |
| `CONSOLIDATION_INTERVAL_HOURS` | 24 | `src/memory/consolidation.ts` | Hours between consolidation runs |
| `MERGE_SIMILARITY_THRESHOLD` | 0.85 | `src/memory/consolidation.ts` | Content similarity for merging duplicates |
| `DECAY_THRESHOLD_DAYS_30` | 30 | `src/memory/consolidation.ts` | Days before 10% importance decay |
| `DECAY_THRESHOLD_DAYS_90` | 90 | `src/memory/consolidation.ts` | Days before 30% importance decay |
| `ARCHIVE_THRESHOLD` | 1 | `src/memory/consolidation.ts` | Importance at or below this → archived |
| `DEFAULT_TOKEN_BUDGET` | 1500 | `src/memory/retriever.ts` | Default retrieval budget |
| `EMBEDDING_DIM` | 384 | `src/memory/embeddings.ts` | all-MiniLM-L6-v2 dimensions |

Slack interaction parameters:

| Parameter | Default | File | Purpose |
|---|---|---|---|
| Accumulation window | 4s | `src/slack/event-queue.ts` | Debounce before processing |
| Slow task threshold | 60s | `src/slack/handler.ts` | When to show ⏳ status |
| Startup crawl skip | 5 min | `src/cli/start.ts` | Skip crawl if offline less than this |

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
npm test          # 259 tests across 20 files
npm run build     # TypeScript compile
npm run lint      # Type-check without emitting
```

## Project Structure

```
src/
  agent/          # Agent orchestration, system prompt, tool loop
  cli/            # Commander.js CLI (setup, start, status)
  db/             # SQLite + sqlite-vec, schema
  google/         # Google Workspace auth + 16 tools
  hooks/          # PreToolUse / PostToolUse security hooks
  memory/         # Extraction, retrieval, embeddings, reflection, consolidation
  mcp/slack/      # Slack tool definitions + handlers
  security/       # Sender verify, output sanitizer, path validator, rate limiter
  slack/          # Event queue, handler, interrupt classifier, Socket Mode
  training-wheels/ # Trust level policy + pattern graduation
  config.ts       # Zod-validated config
  credentials.ts  # Keychain (macOS) + env var fallback
  logger.ts       # Pino structured logging
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

## License

Private — not open source.
