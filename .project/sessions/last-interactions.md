# Last Interactions — Session 24

### Publishing to GitHub Packages
**User**: we should NOT clone locally. I want this as robust as possible. minimal hack, maximum assurance that as we develop this, all sessions using the memory get updated automatically.
**Assistant**: Published @andrewcovato/clawvato-memory to GitHub Packages via GitHub Action. Auto-publishes on every push to main. Set up ~/.npmrc with GitHub auth for npx access.
**Decision**: GitHub Packages for distribution (private, free, auto-publish). Will move to npm when ready to open source.
**Pending**: None — publishing works.

### SessionStart Hook for Auto-Sync
**User**: can continue run the npx clawvato-memory init command automatically? I want to avoid having stagnant versions hanging around.
**Assistant**: Tried multiple approaches: npx init in SessionStart hook (failed — interactive prompts, timing), sync-scripts.sh (too hacky), version check script. Landed on check-version.sh that reads installed version from ~/.clawvato/config.json and compares against npm view. Outputs status to agent context.
**Decision**: Version check hook on SessionStart (silent when current, warns when outdated). Auto-update via npx was unreliable in hook context. CLAUDE.md snippet instructs agent to mention version status.
**Pending**: Agent doesn't always surface the version message to user — prompt instruction is soft, not guaranteed.

### Memory Plugin CLAUDE.md Snippet
**User**: I would have loved richer context, and for the new session to make the connection that "hey we could use the clawvato brain to help our project." What's the gap?
**Assistant**: Rewrote CLAUDE.md snippet from tool docs to worldview. Now frames brain as shared business knowledge, instructs agents to look for transferable patterns across projects, and to store insights immediately as type "reflection".
**Decision**: Brain snippet teaches worldview, not just tools. "Think across projects — the owner's projects share DNA."

### Handoff/Continue Skills
**User**: I'm confused. handoff/continue should be its own thing. The memory plugin should be separate.
**Assistant**: Rewrote both skills with clean separation. Core = file-based (works anywhere). Plugin enhancement = optional bridge (briefs, retrieve_context, store_fact for un-journaled facts). Skills live in ~/.claude/skills/ as directories with skill.md.
**Decision**: /handoff and /continue are file-first, plugin-optional. Two independent systems that compose when both present.

### Cloud Agent Insights
**User**: Can we also update the cloud agent to send insights to memory?
**Assistant**: Added "Store insights" and "Think across projects" instructions to CC-native system prompt (config/prompts/cc-native-system.md).
**Decision**: All surfaces (cloud, local, any connected project) now instructed to store insights as type "reflection" and look for cross-project patterns.
