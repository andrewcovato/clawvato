---
name: handoff
description: Write a complete session handoff — update all project files, write last interactions to file, sync to plugin, verify with blind agent. Use when ending a session, context is getting heavy, or user says "hand off" / "wrap up".
user_invocable: true
---

# Session Handoff

You are performing a complete session handoff. Follow every step carefully — the goal is that the next session picks up seamlessly without the user having to explain anything.

## Step 1: Write last-interactions.md

Create/overwrite `.project/sessions/last-interactions.md` with the last 3-5 substantive interactions from this conversation. Include:
- What the user said (verbatim or near-verbatim)
- What you did (concise summary)
- Key decisions made
- Any open questions

Format each interaction as:
```
### [Topic]
**User**: [what they said]
**Assistant**: [what you did]
**Decision**: [if any]
**Pending**: [if any]
```

## Step 2: Update HANDOFF.md

Update `.project/sessions/HANDOFF.md` with:
- Quick Resume block (sprint, status, branch, build, what's next)
- Session summary (what was accomplished)
- Key decisions
- Files created/modified
- Immediate next steps

## Step 3: Update state.json

Update `.project/state.json` with:
- Current sprint progress
- Last session info
- Any new backlog items
- Updated metrics if applicable

## Step 4: Sync to plugin

Call these memory plugin tools:
1. `update_handoff(surface: "local", mode: "replace", content: ...)` — write the full HANDOFF.md content
2. `update_brief(surface: "local", content: ...)` — concise 1-2 sentence summary of current state
3. `store_fact(...)` — for any durable learnings from this session (decisions, architecture changes, gotchas discovered)

## Step 5: Verify with blind subagent

Spawn a subagent with NO conversation context. Give it ONLY access to:
- Read `.project/sessions/HANDOFF.md`
- Read `.project/sessions/last-interactions.md`
- Read `.project/state.json`
- Memory plugin tools: `get_handoff(surface: "local")`, `get_briefs()`

Ask it: "You are resuming after a session restart. Using only these files and plugin tools, demonstrate you can continue. What is the current state? What were the last interactions? What would you do next?"

Evaluate its response. If it misses something critical, update the handoff files and try again. Max 2 rounds.

## Step 6: Confirm

Tell the user: "Handoff complete. [N] interactions saved, [N] facts stored, blind agent verified. Safe to `/continue` in a new session."
