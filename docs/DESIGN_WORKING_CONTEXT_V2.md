# Design: Working Context v2 — Surface-Scoped Handoffs

> Status: Proposed | Priority: High | Depends on: HTTP memory plugin (deployed)

## Problem

Working context v1 stores fragmented key-value pairs scoped to session IDs (`wctx:SESSION_ID:key`). This creates three problems:

1. **Dead sessions accumulate** — no cleanup when sessions end. 9 stale sessions visible right now.
2. **Shallow content** — key-value pairs can't capture rich handoff state. Sessions write "status: standing by" instead of comprehensive context.
3. **No automation** — handoffs require CC to remember to do them. Crashes and force-quits lose state entirely.

## Goals

1. **Infinite coding sessions** — context pressure triggers automatic handoff, context clears, session resumes seamlessly. From the user's perspective: a 3-5 minute delay, then back to work.
2. **Cross-surface awareness** — any CC instance can see what other surfaces are working on (briefing-level, not full context).
3. **Same-surface continuity** — a new session on the same surface picks up exactly where the last left off.
4. **Zero user intervention** — handoffs happen automatically. The user never has to ask for them.

## Concepts

### Surfaces (not sessions)

A **surface** is a durable identity for where CC runs. Sessions come and go; surfaces persist.

| Surface | Identity | Lifecycle |
|---|---|---|
| `cloud` | Railway CC instance | Always-on, auto-respawns |
| `local` | Local CC coding session | Started/stopped by user |
| `cowork` | Cowork / browser CC | Ad-hoc |

CC knows its surface via environment or prompt injection. Cloud gets it from the system prompt. Local/cowork infer it (default: `local`).

### Two layers per surface

**Brief** — Cross-surface awareness. Short (a few paragraphs). "What I'm working on, what's pending, key decisions." Any surface can read any other surface's brief.

**Handoff** — Same-surface continuity. Rich (HANDOFF.md-scale). "Everything the next session on this surface needs to pick up where I left off." Only read by the same surface.

### Decay model

Not time-based — **activity-based**.

- **Briefs**: Overwritten each time. The latest brief for a surface persists until that surface writes a new one. No TTL.
- **Handoffs (coding/cowork)**: Overwritten entirely when a new session on that surface writes its handoff. The last handoff persists indefinitely until replaced.
- **Handoffs (cloud)**: Rolling window. The plugin stores the last N entries (interactions/tasks). New entries push in at the top, oldest entries fall off the bottom. Not time-decayed — if you leave for 3 days, the last N interactions are still there.

### What goes where

| Information | Where it goes |
|---|---|
| "I'm working on the HTTP memory transport" | Brief (cross-surface) |
| Full implementation state, files changed, architecture decisions, next steps | Handoff (same-surface) |
| "Acorns reported 16% CAC improvement" | Long-term memory (`store_fact`) |
| "Owner prefers plan-before-code" | Long-term memory (`store_fact`) |

Rule of thumb: if it's useful in 2 weeks to a different surface, it's a `store_fact`. If it's useful in 2 hours to the same surface, it's a handoff. If it's useful right now to any surface, it's a brief.

## Plugin Tool Changes

Replace `update_working_context` and `list_working_contexts` with:

### `update_brief`

Write the cross-surface summary for your surface.

```
update_brief(surface: string, content: string)
```

- Overwrites the previous brief for this surface
- Content should be concise: what you're working on, what's pending, key context
- Stored as `brief:<surface>` in `agent_state`

### `update_handoff`

Write or append to the same-surface handoff document.

```
update_handoff(surface: string, content: string, mode: "replace" | "append")
```

- `replace`: Overwrites the entire handoff (used by coding/cowork sessions on exit)
- `append`: Adds an entry to the rolling window (used by cloud session after each interaction)
- For `append` mode, the plugin manages the window: prepends the new entry, trims entries beyond `max_entries` (default 50)
- Each appended entry is timestamped by the plugin
- Stored as `handoff:<surface>` in `agent_state`

### `get_briefs`

Read all surfaces' briefs for cross-surface awareness.

```
get_briefs() → { surface: string, content: string, updated_at: timestamp }[]
```

- Returns the latest brief from every surface
- This is what a session reads on startup to understand what's happening elsewhere

### `get_handoff`

Read the deep handoff for a specific surface.

```
get_handoff(surface: string) → { content: string, updated_at: timestamp }
```

- Used on session startup to resume same-surface work
- Cloud: returns the rolling window (last N interactions)
- Coding: returns the last session's full handoff document

### Deprecation

- `update_working_context` — deprecated, replaced by `update_brief` + `update_handoff`
- `list_working_contexts` — deprecated, replaced by `get_briefs`

Keep the old tools functional for a transition period (the Railway CC may still use them until the next deploy), but new prompts should reference the new tools only.

## The Infinite Coding Session

The flagship UX: coding sessions that never end from the user's perspective.

### Flow

```
User starts CC session
  → CC reads get_handoff("local") + get_briefs()
  → If handoff contains recent_interactions, replay them into the conversation
  → Resumes work seamlessly — user sees their recent messages in the thread
  → ... works for a while ...

Context reaches ~70%
  → CC proactively initiates handoff (prompt-driven, not waiting for PreCompact)
  → CC writes comprehensive handoff:
      1. update_handoff("local", full_state, "replace")
         - Includes recent_interactions: last 3-5 exchanges verbatim
      2. update_brief("local", summary)
      3. store_fact() for any durable learnings
      4. If .project/ exists: update HANDOFF.md, state.json, memory files
  → Blind subagent verifies handoff (max 3 rounds, updates handoff to close gaps)
  → Context clears
  → CC re-reads handoff + replays recent_interactions
  → Continues working — picks up mid-thought

User experiences: 3-5 minute pause, then seamless continuation.
User never types "get up to speed." Ever.
```

### PreCompact hook (safety net, not primary trigger)

The PreCompact hook is the backstop in case CC doesn't initiate handoff early enough. The primary trigger is CC's own awareness of context pressure (~70%), driven by the prompt. PreCompact fires at ~85-90% as a last-resort checkpoint.

### What's in the coding handoff

```markdown
## Current Task
[What we're building, the goal, acceptance criteria]

## Implementation State
[Files created/modified, what's done, what's in progress, what's next]

## Key Decisions Made
[Architecture choices, tradeoffs, owner preferences expressed this session]

## Recent Interactions (last 3-5)
[Verbatim or near-verbatim recent exchanges for conversational continuity]

## Open Questions
[Anything unresolved that needs owner input]

## Gotchas Discovered
[Bugs, surprises, things to watch out for]
```

### What's in the cloud rolling window

Each entry in the window:

```markdown
### [timestamp]
**Topic**: [what was discussed]
**Request**: [what the owner asked]
**Outcome**: [what was done/decided]
**Pending**: [any follow-up needed]
```

The plugin stores the last 50 of these. CC appends after each substantive interaction.

## Automation Triggers

### PreCompact Hook (context pressure)

```json
{
  "hooks": {
    "PreCompact": [{
      "matcher": "auto",
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST $MEMORY_URL/mcp -H 'Authorization: Bearer $MCP_AUTH_TOKEN' -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"update_brief\",\"arguments\":{\"surface\":\"local\",\"content\":\"Session hit context pressure — auto-checkpoint triggered. Handoff may be incomplete.\"}}}'"
      }]
    }]
  }
}
```

This is the safety net — a minimal checkpoint if context fills up before CC gets to write a proper handoff. The real handoff should happen earlier, driven by the prompt instruction to offer handoff at ~70% context.

### SessionEnd Hook (crash safety net)

```json
{
  "hooks": {
    "SessionEnd": [{
      "hooks": [{
        "type": "command",
        "command": "./scripts/session-end-handoff.sh"
      }]
    }]
  }
}
```

The script curls the memory plugin with whatever state it can capture. This is last-resort — the brief may just say "session ended without graceful handoff, check long-term memory for recent facts."

### Cloud Idle Timeout (existing)

Already exists in `slack-channel.ts`. The system event tells CC to run the handoff protocol. Update the prompt to use `update_handoff("cloud", ..., "append")` + `update_brief("cloud", ...)` instead of the old `update_working_context`.

### Session Startup (all surfaces)

On startup, CC:
1. Reads `get_handoff(my_surface)` — same-surface continuity
2. Reads `get_briefs()` — cross-surface awareness
3. Resumes naturally

## DB Schema

No schema changes needed. The `agent_state` table already supports this:

| Key | Value |
|---|---|
| `brief:cloud` | Short cross-surface summary |
| `brief:local` | Short cross-surface summary |
| `handoff:cloud` | JSON: `{ entries: [...], max_entries: 50 }` |
| `handoff:local` | Full markdown handoff document |

The rolling window for cloud is stored as a JSON array in the `value` column. The plugin manages append + trim.

## Migration Path

### Phase 1: Build new tools
- Add `update_brief`, `update_handoff`, `get_briefs`, `get_handoff` to the plugin
- Keep old tools (`update_working_context`, `list_working_contexts`) functional
- Deploy plugin update

### Phase 2: Update prompts
- Update `cc-native-system.md` to use new tools + teach cloud rolling window behavior
- Update coding session prompts to teach handoff discipline
- Add PreCompact + SessionEnd hooks

### Phase 3: Cleanup
- Delete old `wctx:*` entries from `agent_state`
- Remove old tools from plugin (or keep as aliases)

### Phase 4: Infinite session
- Implement the full PreCompact → handoff → clear → resume flow
- Blind agent verification as part of the automated handoff
- Last 3-5 interactions captured for conversational continuity

## Resolved Design Decisions

1. **Max entries for cloud rolling window** — 50 entries. ~10K chars. Sufficient for a week+ of moderate Slack activity.
2. **Last 3-5 interactions for coding continuity** — CC self-summarizes AND captures the last 3-5 interactions verbatim as part of the handoff. After context clears, the startup flow **replays them into the new session** so recent messages appear in the conversation thread. This is what makes it feel seamless — you see your recent exchanges, CC responds with full continuity.
3. **Blind agent** — always run, even for automated handoffs. The 3-5 minute delay is acceptable. What's NOT acceptable is the user having to manually re-establish context ("get up to speed and tell me what's next"). The blind agent ensures the handoff is complete enough that the resumed session continues naturally.
4. **`get_handoff` returns raw entries** — CC formats as needed for context.
5. **Project doc updates** — for managed projects (`.project/` directory), the handoff protocol MUST update HANDOFF.md, state.json, and relevant memory files before context clears. The blind agent reads these as part of verification.
