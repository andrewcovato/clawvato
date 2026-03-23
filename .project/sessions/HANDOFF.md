# Session Handoff

> Last updated: 2026-03-23 | Session 18 | Sprint S9

## Quick Resume

```
Sprint: S9 — CC-Native Engine + Shared Memory Brain
Status: CC-NATIVE ENGINE DEPLOYED AND WORKING ON RAILWAY
Branch: cc-native-engine (GitHub auto-deploy to Railway)
Engine: ENGINE=cc-native env var activates CC-native mode
Database: Railway managed Postgres — 130 memories, 693 entity tags
Task Channel: #clawvato-tasks (C0AN5J0LCP3)
Build: Clean (tsc --noEmit passes)
Deploy: Live on Railway via GitHub auto-deploy
Memory Plugin: github.com/andrewcovato/clawvato-memory (built, local config wired, untested)
NEXT: Test memory plugin locally, stabilize cc-native 24h, wire sweeps
```

## What's Working (deployed 2026-03-23)

### CC-Native Engine (Track O)
Claude Code runs as the core engine on Railway. Slack messages flow in via a Channel MCP server. CC handles tool orchestration, context management, and reasoning natively. Replaces ~2,250 lines of custom orchestration (router, fast path, deep path, context planner).

```
Railway container:
  Supervisor (expect + restart loop)
    └── claude (interactive, Max plan = $0)
          ├── Slack Channel MCP server (Socket Mode → channel events)
          │     ├── 👀 reaction on receipt (code-enforced)
          │     ├── slack_reply, slack_react, slack_get_history tools
          │     ├── Debounce (4s), owner-only gate
          │     └── Startup crawl event on session start
          ├── Memory MCP server (old in-tree version)
          │     └── search, store, working ctx, tasks
          └── Google/Fireflies via Bash (gws CLI, tools/fireflies.ts)

  Task Scheduler (standalone sidecar)
    └── Polls scheduled_tasks → posts to Slack → CC handles as channel event
```

### Key Infrastructure Details
- **expect** provides PTY + auto-approves trust prompt (regex match on "folder" through ANSI noise)
- **Non-root user** (clawvato) required for `--dangerously-skip-permissions`
- **docker-entrypoint.sh** runs as root to fix volume perms, then `su -p` to clawvato user
- **HOME explicitly set** to `/home/clawvato` (su -p preserves root's HOME)
- **Trust pre-creation** in `.claude.json` does NOT work — must use expect
- **GitHub auto-deploy** from `cc-native-engine` branch (railway up CLI was timing out due to .claude/ 379MB)

### Background Sweeps (Track M — complete)
```
Scheduler tick → Parallel collectors (Slack, Gmail, Drive, Fireflies) ~2 min
→ Workspace .md file (1.8MB sweep content)
→ Opus CLI synthesis (~6 min)
→ findings.md → Sonnet extraction → 130 facts + 693 entity tags ✅
```

### Memory Plugin (Track H — built, untested)
Standalone repo: `github.com/andrewcovato/clawvato-memory`
- Self-contained MCP server (postgres.js + MCP SDK, no clawvato deps)
- Session-scoped working context: `wctx:SESSION_ID:key` pattern
- `list_working_contexts` tool for cross-instance awareness
- SKILL.md teaching CC memory discipline (store what+why, not how)
- Configured locally at `~/.claude/.mcp.json` pointing to Railway Postgres (public URL: autorack.proxy.rlwy.net:59024)
- NOT yet tested — need to restart CC session to pick up MCP config

## Architecture: Two Engines

### CC-Native Engine (active on Railway, `cc-native-engine` branch)
```
Slack → Channel MCP → Claude Code (interactive, Opus, $0 on Max plan)
     → CC uses tools natively: Memory MCP, gws CLI, Fireflies CLI
     → CC replies via slack_reply tool
     → 👀 on receipt (code), 🧠 while processing (prompt-driven)
```

### Hybrid Engine (fallback on `main` branch)
```
Slack → Socket Mode → EventQueue → Haiku router
     → FAST (Sonnet API) / MEDIUM (Opus API) / DEEP (Opus CLI)
     → Custom tool loop, context assembly, stream-json parsing
```

Switch: set `ENGINE=cc-native` or `ENGINE=hybrid` in Railway env vars.

## Session 18 Key Decisions

1. **CC-native engine**: CC as core, not custom orchestration. On Max plan, Opus is $0.
2. **Channels**: Anthropic's MCP primitive for pushing events into CC. Research preview but works.
3. **expect for headless**: Only reliable way to handle PTY + trust prompt on Railway.
4. **Memory as plugin**: Separate repo, any CC instance shares the same Postgres brain.
5. **Session-scoped working context**: Multi-instance safe (wctx:SESSION_ID:key).
6. **Fact extraction via CC judgment**: Trust Opus (SKILL.md teaches discipline). No Slack-specific hooks.
7. **Store what+why, never how**: The noise filter for memory.
8. **Track G redesigned**: Self-development with three-gate safety (docs/DESIGN_TRACK_G_SELF_DEV.md).
9. **Verified handoff protocol**: Subagent tests handoff before session exit (max 3 rounds).
10. **Build for the future**: Adopt Anthropic tech as it ships.

## Files Created/Modified This Session

### New (cc-native engine):
- `src/cc-native/slack-channel.ts` — Slack Channel MCP server
- `src/cc-native/start.ts` — Launcher for supervisor
- `src/cc-native/task-scheduler-standalone.ts` — Sidecar task scheduler
- `config/prompts/cc-native-system.md` — System prompt with handoff protocol
- `scripts/cc-native-entrypoint.sh` — Supervisor (expect + restart loop)
- `.cc-native-mcp.json` — MCP config for CC

### New (design docs):
- `docs/DESIGN_CC_NATIVE.md` — CC-native engine architecture
- `docs/DESIGN_TRACK_G_SELF_DEV.md` — Self-development with safety rails

### New (memory plugin — separate repo):
- `github.com/andrewcovato/clawvato-memory` — Standalone MCP server + SKILL.md

### Modified:
- `Dockerfile` — non-root user, expect, copy all scripts
- `scripts/docker-entrypoint.sh` — trust pre-creation, user switching, ENGINE routing
- `src/cli/index.ts` — --engine flag
- `CLAUDE.md` — "build for the future" directive + handoff protocol
- `.gitignore` / `.dockerignore` — added .claude/, .workspaces/

## Immediate Next Steps

1. Test memory plugin locally — restart CC, verify search/store
2. Swap Railway to plugin MCP server (session-scoped working context)
3. Stabilize cc-native 24h — monitor crashes, verify restart + handoff
4. Test verified handoff — trigger idle timeout, check subagent verification
5. Wire sweeps to cc-native — task scheduler sidecar

## Backlog

### High Priority
1. Track G Phase 1: read-only GitHub access
2. Track G Phase 2: branch + PR (self-development, owner-gated)
3. SessionEnd hook for memory extraction safety net
4. Sweep integration with cc-native

### Medium Priority
5. Track G Phase 3: self-deploy with health check + auto-rollback
6. Artifact short-term memory (FIFO cache)
7. Finance integration

### Strategic
8. Merge cc-native to main (after stability proven)
9. Obsidian .md export
10. Clawvato self-development (Track G Phase 3)

## Hard-Won Gotchas (new this session)

- CC trust prompt: `hasTrustDialogAccepted` in `.claude.json` does NOT prevent it — must use `expect` with regex
- ANSI codes (`[1C`) between words in CC TUI — literal `expect` matching breaks, use `-re` regex
- `--dangerously-skip-permissions` does NOT skip trust prompt — separate security layer
- `--dangerously-skip-permissions` cannot run as root — need non-root Docker user
- `su -p` preserves `HOME=/root` — must explicitly `export HOME=/home/clawvato`
- `railway up` uses `.gitignore` for filtering — `.claude/` (379MB) must be in `.gitignore`
- GitHub auto-deploy more reliable than `railway up` CLI
- `expect` with `exp_continue` keeps matching — "folder" in normal output triggers spurious Enter
- `script` piped stdin doesn't reach CC's ink TUI — `expect` is the only reliable approach
- Settings.json `mcpServers` is not valid — MCP servers go in `.mcp.json` files
- Memory plugin needs public Postgres URL (autorack.proxy.rlwy.net), not internal
