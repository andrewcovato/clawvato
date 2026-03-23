# Design: CC-Native Engine via Channels

> Status: In Progress | Author: Andrew + Claude | Date: 2026-03-22

## Problem Statement

Clawvato's current architecture builds a sophisticated orchestration layer (~2,250 lines) that mimics what Claude Code already does natively: tool loops, context management, routing, multi-step reasoning. This was necessary when cost optimization mattered (Haiku/Sonnet for simple queries), but on Max plan all paths cost $0. We're maintaining a worse version of CC's native capabilities.

Meanwhile, Anthropic shipped **Channels** — MCP servers that push external events into a running CC session. This enables CC as the always-on core engine with Slack flowing directly into it.

## Design Principles

1. **CC is the brain.** Stop rebuilding CC's capabilities. Let it handle tool orchestration, context management, and reasoning natively.
2. **Memory is the persistence layer.** CC sessions are ephemeral. Postgres (via Memory MCP) is the durable brain that survives restarts.
3. **Seamless restarts.** The user should never feel like they're talking to a "new" session. Verified handoff protocol ensures continuity.
4. **Build for the future.** Channels, plugins, `--session`, compacting — these are evolving fast. Build layers that adopt new capabilities as they land.

## Architecture

```
Railway container:

  Supervisor (bash restart loop)
    ├── claude (interactive, long-lived, Max plan = $0)
    │     ├── Slack Channel MCP server (spawned by CC)
    │     │     ├── Socket Mode → pushes messages as <channel> events
    │     │     ├── slack_reply tool → posts to Slack
    │     │     ├── slack_react tool → manage reactions
    │     │     └── Owner-only gate + debounce (4s)
    │     ├── Memory MCP server (already built)
    │     │     ├── search_memory, store_fact, retrieve_context
    │     │     ├── update_working_context
    │     │     └── list/create/update/delete_task
    │     └── CC calls Google/Fireflies via Bash
    │           ├── gws gmail/calendar/drive CLI
    │           └── npx tsx tools/fireflies.ts
    │
    └── Task Scheduler (background Node.js process)
          ├── Polls scheduled_tasks table
          └── Posts to Slack when tasks fire → CC receives as channel event

  Session lifecycle:
    CC runs continuously, handling messages via channel
    → After idle timeout: CC runs verified handoff → exits
    → Supervisor restarts CC
    → New session loads working context + startup crawl → seamless
```

## Component Design

### 1. Slack Channel MCP Server (`src/cc-native/slack-channel.ts`)

MCP server with `claude/channel` capability. Spawned by CC as a subprocess.

**Responsibilities:**
- Connect to Slack via Socket Mode (`@slack/bolt`)
- Filter: only forward messages from owner (`OWNER_SLACK_USER_ID`) or @mentions
- Debounce: accumulate multi-message bursts in a 4s window
- Push messages as channel events with metadata
- Expose tools for CC to interact with Slack

**Channel event format:**
```xml
<channel source="slack" channel_id="C0AMELZCDLP" thread_ts="1234.5678"
         user_id="U123ABC" channel_name="general" message_ts="1234.5679">
Hey Clawvato, what's on my calendar today?
</channel>
```

**Tools exposed:**
- `slack_reply` — Post a message to a channel/thread
  - `channel_id` (required), `text` (required), `thread_ts` (optional)
- `slack_react` — Add or remove a reaction
  - `channel_id` (required), `timestamp` (required), `emoji` (required), `action` ("add" | "remove")

**Instructions (injected into CC's system prompt via MCP):**
Tells CC how to interpret channel events, when to respond, how to use the reply/react tools, and the reaction lifecycle pattern (🧠 on receipt → respond → remove 🧠).

### 2. System Prompt (`config/prompts/cc-native-system.md`)

Adapted from existing `system.md` + `deep-path.md`. Key additions:

- **Channel interaction model**: How to read `<channel source="slack">` events and respond via tools
- **Session handoff protocol**: Verified handoff with subagent before shutdown
- **Working context discipline**: Periodically update working context during conversations
- **Startup behavior**: On first activity, check working context for handoff notes
- **Tool access**: Memory MCP for persistence, `gws` CLI for Google, `tools/fireflies.ts` for meetings
- **Idle awareness**: After receiving a shutdown signal, run the handoff protocol

### 3. Verified Handoff Protocol

When CC decides to shut down (idle timeout, context getting large, or explicit signal):

**Step 1: Write comprehensive handoff**
CC calls `update_working_context` with current state: active conversations, pending actions, recent decisions, in-progress work.

**Step 2: Spawn blind subagent**
CC spawns a subagent with NO conversation context — only working context from Memory MCP and long-term memory. The subagent is asked:

> "You are resuming as Clawvato after a session restart. Using only the working context and memory available to you, demonstrate that you can seamlessly continue. What is the current state? What would you do next? What questions would you ask the owner if they appeared right now?"

**Step 3: Evaluate and iterate**
CC evaluates the subagent's understanding against actual state. Focuses on gaps that would cause a visible seam — things that would make the owner feel like a new session. Updates working context to close gaps. Max 3 rounds.

**Step 4: Exit**
CC exits cleanly. Supervisor restarts it. New session loads working context and resumes.

### 4. Supervisor (`scripts/cc-native-entrypoint.sh`)

Simple bash script:
- Restart loop: when CC exits, wait 5s, restart
- Passes channel flags, MCP config, system prompt
- Clean environment (allowlist pattern)
- Starts task scheduler as background process
- Handles graceful shutdown (SIGTERM → forward to CC)

### 5. Idle Timeout & Session Reset

CC monitors its own activity. After N minutes of no channel events (configurable, default 30min):
1. Channel server sends a system event: `<channel source="system">Idle timeout. Run handoff protocol.</channel>`
2. CC runs verified handoff
3. CC exits
4. Supervisor restarts

This prevents unbounded context growth and ensures regular handoff verification. The user never notices — next message wakes CC with fresh context from the handoff.

**Planned resets**: Could also trigger on context size (if CC reports high token usage) or on a schedule (every N hours regardless of activity).

### 6. Task Scheduler (Sidecar)

Lightweight Node.js process running alongside CC:
- Polls `scheduled_tasks` table every 60s
- When a task fires: posts to Slack (e.g., DMs the bot or posts to #clawvato-tasks)
- CC picks this up as a regular channel event
- CC handles the task using its full tool access
- If CC is mid-conversation: CC naturally prioritizes (channel events are sequential)

The scheduler doesn't need agent logic — it just triggers. CC does the thinking.

### 7. Fact Extraction (Future: Plugin)

For the prototype, CC stores facts directly via Memory MCP (`store_fact`) during conversations. CC knows what's important — it doesn't need a separate extraction step.

Future enhancement: a Claude Code plugin with a PostToolUse hook that watches conversations and extracts facts automatically. This plugin installs on both Railway CC AND the owner's local CC, enabling the shared brain pattern (both write to the same Postgres via Memory MCP).

## Startup Crawl (Gap Recovery)

When CC starts, before processing new channel events:
1. Load working context from Memory MCP (handoff notes)
2. The Slack channel server connects and receives any buffered events
3. For any gap > 30s, CC reads recent Slack history via the channel server's tools
4. CC processes anything that arrived during the restart window

This covers both planned restarts (handoff notes available) and crashes (no handoff, but Slack history fills the gap).

## What Changes vs Current Architecture

### Deleted (~2,250 lines):
- `agent/hybrid.ts` — CC is the orchestrator
- `agent/fast-path.ts` — CC handles tool loops natively
- `agent/deep-path.ts` — CC IS the deep path
- `agent/router.ts` — no routing needed (everything is Opus, $0)
- `agent/context.ts` — CC gets context via MCP + compacting
- `agent/context-planner.ts` — CC plans its own context gathering
- `slack/handler.ts` — channel server replaces this
- `slack/event-queue.ts` — debounce moves to channel server
- `slack/interrupt-classifier.ts` — CC handles naturally

### Kept (unchanged):
- Memory system (store, retriever, extractor, embeddings, consolidation)
- MCP memory server (`src/mcp/memory/`)
- Sweep system (all collectors, executor, synthesis)
- Google tools (`gws` CLI)
- Fireflies tools (`tools/fireflies.ts`)
- Security (output sanitizer, path validator)
- Database schema

### New:
- `src/cc-native/slack-channel.ts` — Slack Channel MCP server (~300 lines)
- `config/prompts/cc-native-system.md` — System prompt (~150 lines)
- `scripts/cc-native-entrypoint.sh` — Supervisor (~30 lines)
- `.cc-native-mcp.json` — MCP config (~15 lines)
- `src/cc-native/task-scheduler-standalone.ts` — Standalone task scheduler (~100 lines)

### Modified:
- `src/cli/start.ts` or new entry point for `ENGINE=cc-native` mode
- `config/default.json` — add `engine` and `ccNative` config section
- Docker entrypoint — support cc-native mode

## Performance Comparison

| Scenario | Current (hybrid) | CC-native |
|----------|------------------|-----------|
| Simple lookup ("calendar today?") | ~3s (Sonnet fast path) | ~2-3s (CC already running, channel event) |
| Memory search | ~2-3s (Sonnet) | ~2-3s (CC + MCP) |
| Multi-step research | ~1-5min (deep path spawn + MCP) | ~1-5min (CC native, no spawn overhead) |
| First message after restart | ~3s | ~10-30s (CC startup + channel reconnect) |
| Subsequent messages | ~3s | ~1-2s (CC already running, no spawn) |

Key insight: CC-native is **faster for sustained conversations** (no per-message spawn overhead) but **slower on cold start**. The idle timeout + verified handoff minimizes cold starts.

## Deployment

### Railway
- `ENGINE=cc-native` env var triggers the new mode
- Same Docker image, different entrypoint path
- Same `DATABASE_URL`, same Postgres
- Same `CLAUDE_CODE_OAUTH_TOKEN` for Max plan
- Additional: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` passed to CC env (channel server needs them)
- Flag: `--dangerously-load-development-channels server:slack-channel` (research preview)

### Headless Considerations
CC needs to run interactively (not `--print`) to receive channel events. On Railway (no TTY):
- Test if `claude` runs headless without a TTY
- If not: wrap with `script -qfc "claude ..." /dev/null` for pseudo-TTY
- This is a test item, not a blocker

### Testing Locally
1. Push branch to Railway, set `ENGINE=cc-native`
2. Or run locally: `./scripts/cc-native-entrypoint.sh`
3. Same Slack app, same bot tokens, same memory database
4. Compare side-by-side with current engine on `main`

## Open Questions

1. **Idle timeout duration**: 30 min default? Configurable? Should it also trigger on context size?
2. **Sweep orchestration**: Sweeps currently run inside the Node.js process. In cc-native, the task scheduler sidecar triggers them via Slack. Is this sufficient, or do sweeps need their own mechanism?
3. **Permission prompts**: CC will ask for tool approval. Options: aggressive `--allowedTools`, permission relay via Slack channel, or pre-approved settings. Start with broad `--allowedTools`.
4. **Multiple simultaneous conversations**: CC processes channel events sequentially. If the owner messages in two channels quickly, the second waits. Is this acceptable? (Current system has the same behavior for deep path.)
