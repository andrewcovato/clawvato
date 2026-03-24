---
name: continue
description: Resume from a previous session handoff — read local state files, plugin handoff, last interactions, and brain context. Use at session start or when user says "continue" / "pick up where we left off".
user_invocable: true
---

# Continue from Handoff

You are resuming after a session break. Load all context and present a brief status to the user. Do NOT ask them to "get you up to speed" — you have everything you need.

## Step 1: Read local state files

Read these files (all may not exist — that's fine):
1. `.project/sessions/HANDOFF.md` — full session handoff
2. `.project/sessions/last-interactions.md` — recent conversation thread
3. `.project/state.json` — project state, sprint, backlog

## Step 2: Read plugin state

Call these memory plugin tools:
1. `get_handoff(surface: "local")` — the plugin's copy of the handoff
2. `get_briefs()` — what other surfaces (cloud, cowork) have been doing

## Step 3: Brain context bridge

Take the current task/topic from the handoff and call:
```
retrieve_context(message: "[summary of current work from handoff]", token_budget: 1000)
```

This surfaces any brain knowledge that's relevant to where you left off — including facts stored by other surfaces or by journaling since the last session.

## Step 4: Present status

Give the user a brief (3-5 line) status:
- What was being worked on
- What other surfaces have been doing (if anything)
- What the brain knows that's relevant
- Suggested next step

Format:
```
**Resuming Session [N]** — [topic]
[1-2 lines on what was accomplished]
[1 line on cross-surface activity if any]
[1 line on what the brain surfaced]
**Next**: [suggested action]
```

## Step 5: Continue naturally

After presenting status, proceed with the suggested next step or wait for the user's direction. Do not rehash what was already done — just continue as if the session never ended.

## Important

- If `last-interactions.md` exists, use it to restore conversational tone and context
- If the handoff mentions open questions, raise them proactively
- If the brain surfaced new information (from other surfaces or journaling), mention it
- Trust the handoff — don't re-read files that the handoff already summarizes
