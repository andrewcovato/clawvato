# Design: Plugin Adapter for Clawvato

> Status: Proposed | Priority: High | Track: New (Plugin Ecosystem)

## Problem

Clawvato's deep path spawns Claude Code via `claude --print`, which doesn't support interactive skills or plugins. This means every new capability (Gmail drafting, GitHub integration, etc.) must be hand-built as either an MCP server, CLI wrapper, or fast-path tool. Meanwhile, the Claude Code plugin ecosystem is growing — community and first-party plugins bundle MCP servers, skills, hooks, and agents that solve these problems generically.

## Goal

Build an adapter that scans installed Claude Code plugins and makes their capabilities available to Clawvato's deep path subprocess and fast path API loop — enabling a development workflow where the owner builds/tests skills locally in interactive Claude Code, then deploys them to Clawvato automatically.

## Development Workflow

```
1. Owner develops a skill/plugin locally in interactive Claude Code
   └── Uses /skill-creator or manual SKILL.md authoring
   └── Tests interactively — does it work?

2. Plugin is already installed (in ~/.claude/plugins/ or .claude/plugins/)

3. Clawvato startup: plugin adapter scans plugin dirs
   └── MCP servers → merged into --mcp-config for deep path
   └── Skills → injected into system prompt (selective, based on routing)
   └── Hooks → wired into existing pre/post tool hook system

4. Railway deployment
   └── Plugin dirs bundled in Docker image or synced to /data volume
   └── Adapter picks them up on restart — no code changes needed
```

## Plugin On-Disk Structure (Reference)

```
my-plugin/
├── .claude-plugin/
│   └── plugin.json          # Manifest: name, description, component paths
├── skills/
│   └── my-skill/
│       ├── SKILL.md          # YAML frontmatter + markdown instructions
│       └── reference.md      # Optional supporting files
├── agents/
│   └── my-agent.md           # Agent definition (frontmatter + system prompt)
├── hooks/
│   └── hooks.json            # Hook configurations (PreToolUse, PostToolUse, etc.)
├── .mcp.json                 # MCP server definitions
└── .lsp.json                 # LSP servers (not applicable for Clawvato)
```

### Key Manifest Fields (`plugin.json`)

```json
{
  "name": "plugin-name",
  "description": "What the plugin does",
  "version": "1.0.0",
  "mcpServers": "./.mcp.json",       // or inline object
  "skills": "./skills/",
  "agents": "./agents/",
  "hooks": "./hooks/hooks.json"
}
```

### SKILL.md Frontmatter

```yaml
---
name: skill-name
description: When Claude should use this skill
allowed-tools: "Read, Grep, Bash"
model: "claude-opus-4-6"              # Optional model override
context: "fork"                        # Optional: run in subagent
---
Markdown instructions...
```

### MCP Server Config (`.mcp.json`)

```json
{
  "mcpServers": {
    "server-name": {
      "command": "${CLAUDE_PLUGIN_ROOT}/servers/my-server",
      "args": ["--config", "${CLAUDE_PLUGIN_ROOT}/config.json"],
      "env": { "KEY": "value" }
    }
  }
}
```

`${CLAUDE_PLUGIN_ROOT}` resolves to the plugin's absolute directory path.
`${CLAUDE_PLUGIN_DATA}` resolves to `~/.claude/plugins/data/{plugin-id}/`.

## Architecture

### New Modules

```
src/plugins/
  scanner.ts       # Discover and parse plugins from configured directories
  adapter.ts       # Integrate discovered plugins into Clawvato's runtime
  types.ts         # DiscoveredPlugin, PluginSkill, PluginMcpServer interfaces
```

### Scanner (`scanner.ts`)

Responsibilities:
- Scan configured plugin directories (default: `~/.claude/plugins/cache/`, `.claude/plugins/`)
- Parse `plugin.json` manifests (or infer structure from directory layout)
- Read `.mcp.json` files and resolve `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` vars
- Parse `SKILL.md` files: extract YAML frontmatter + markdown body
- Parse agent definitions from `agents/*.md`
- Return structured `DiscoveredPlugin[]` array

```typescript
interface DiscoveredPlugin {
  name: string;
  root: string;                    // Absolute path to plugin directory
  version?: string;
  mcpServers: PluginMcpServer[];   // Resolved MCP server configs
  skills: PluginSkill[];           // Parsed SKILL.md files
  agents: PluginAgent[];           // Parsed agent definitions
  hooks: PluginHook[];             // Hook configurations
}

interface PluginMcpServer {
  name: string;                    // Server name (e.g., "plugin-database")
  command: string;                 // Resolved command (no ${} vars)
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface PluginSkill {
  name: string;
  description: string;
  content: string;                 // Full markdown body (instructions)
  allowedTools?: string[];
  model?: string;
  userInvocable: boolean;
}
```

### Adapter (`adapter.ts`)

Responsibilities:
- **MCP merge**: Combine plugin MCP servers with Clawvato's memory MCP config when building `--mcp-config` for deep path. Also add plugin MCP tool names to `--allowedTools`.
- **Skill injection**: Select relevant skills based on routing context and append their markdown to the deep path system prompt. For fast path, skills could inform tool selection or be appended to the system prompt.
- **Hook wiring**: Register plugin hooks in Clawvato's existing `preToolUse` / `postToolUse` system.
- **Selective loading**: Not all skills are relevant to every message. Use the router's classification or keyword matching to include only pertinent skills in the prompt (avoids bloating context).

```typescript
// Called once at startup
const plugins = await scanPlugins(config.pluginDirs);

// Called when building deep path config
const mcpConfig = buildMcpConfigWithPlugins(dataDir, plugins);
const systemPrompt = buildSystemPromptWithSkills(basePrompt, plugins, routingContext);
const allowedTools = buildAllowedToolsWithPlugins(baseTools, plugins);
```

### Integration Points

| Component | Where it integrates | How |
|---|---|---|
| MCP servers | `deep-path.ts` `buildMcpConfig()` | Merge plugin servers into the MCP config JSON |
| Skills | `deep-path.ts` `buildSdkSystemPrompt()` | Append selected skill markdown to system prompt |
| Skills | `fast-path.ts` system prompt | Append lightweight skill instructions |
| Hooks | `hooks/pre-tool-use.ts`, `hooks/post-tool-use.ts` | Register plugin hook commands |
| Allowed tools | `deep-path.ts` `--allowedTools` | Add `mcp__{plugin-server}__{tool}` entries |

### Config

```json
{
  "plugins": {
    "dirs": ["~/.claude/plugins/cache/", ".claude/plugins/"],
    "enabled": true,
    "maxSkillsInPrompt": 5
  }
}
```

## Mapping Plugin Components to Clawvato Paths

| Plugin component | Deep path (subprocess) | Fast path (API) |
|---|---|---|
| MCP servers | Merge into `--mcp-config` — full tool access | N/A (subprocess only) |
| Skills (markdown) | Append to system prompt — model follows instructions | Could append to system prompt for tool guidance |
| Hooks (pre/post) | Wire into existing hook system | Wire into existing hook system |
| Custom agents | Could spawn as subagents (future) | N/A |
| LSP servers | Not applicable | Not applicable |

## Selective Skill Loading

Including all skills in every prompt would bloat context. Strategy:

1. **Always-on skills**: Skills with `disable-model-invocation: false` and broad descriptions (e.g., "code review") — always included
2. **Keyword match**: Match skill `description` against the user's message — include if relevant
3. **Router hint**: The router's `REASON` field could suggest which skills are needed
4. **Max cap**: `config.plugins.maxSkillsInPrompt` limits how many skill bodies are injected (default 5)
5. **Skill index**: Always include a one-line index of all available skills so the model knows what's available, even if the full body isn't included

## Railway Deployment

### Option A: Bundle in Docker image
```dockerfile
COPY .claude/plugins/ /app/.claude/plugins/
```
Simple, but requires rebuild to update plugins.

### Option B: Sync to persistent volume
```bash
# In docker-entrypoint.sh
if [ -n "$PLUGINS_TAR_B64" ]; then
  echo "$PLUGINS_TAR_B64" | base64 -d | tar xzf - -C /data/plugins/
fi
```
Same pattern as `GWS_CONFIG_B64` — update via env var without rebuild.

### Option C: Git submodule or clone
```bash
# In docker-entrypoint.sh
git clone --depth 1 https://github.com/owner/clawvato-plugins.git /data/plugins/
```
Most flexible — push to the plugins repo, restart Clawvato.

## Security Considerations

- **MCP server commands**: Only execute servers from trusted plugin sources. Validate command paths are within plugin root.
- **Hook commands**: Same trust model as Clawvato's existing hooks — owner-installed only.
- **Skill injection**: Skills are prompt text — no execution risk, but could influence model behavior. Only load from configured dirs.
- **Path traversal**: Reject any resolved paths that escape the plugin root directory.
- **Railway**: Plugin dirs should be read-only on the deployed instance.

## Unified Memory Bridge (Bi-Directional)

The Memory MCP server is the universal bridge between all Claude Code contexts. Every session — Slack deep path, Railway SSH, local dev — reads AND writes to the same memory DB.

### Memory Surfaces

```
┌─────────────────────────────────────────────────────────────┐
│                    Railway /data/clawvato.db                  │
│                    (single source of truth)                   │
│                                                              │
│          ┌──────────────┐                                    │
│          │  Memory MCP  │ ← stdio server                     │
│          │  (6 tools)   │                                    │
│          └──────┬───────┘                                    │
│                 │                                            │
│    ┌────────────┼────────────┬──────────────────┐            │
│    ▼            ▼            ▼                  ▼            │
│  Slack       Railway       --print           Any future      │
│  deep path   SSH session   (--session)       context         │
│  (--print)   (interactive) (Slack threads)                   │
└─────────────────────────────────────────────────────────────┘
         ▲
         │ SSH tunnel / remote MCP
         │
┌────────┴──────────────────────────────────────────────────┐
│                  Local Machine (owner)                      │
│                                                            │
│  claude (interactive)                                      │
│    └── Memory MCP via SSH tunnel to Railway                │
│         └── reads: search_memory, retrieve_context, etc.   │
│         └── writes: store_fact, flush_session_to_memory    │
└────────────────────────────────────────────────────────────┘
```

### Read Path (already works)

- `search_memory` / `retrieve_context` → query long-term memory
- `list_people` / `list_commitments` → structured lookups
- `update_working_context` (read scratch pad) → operational state

### Write Path (partially works → needs extraction hooks)

**Explicit writes (already in MCP server):**
- `store_fact` → model calls during session when it learns something important
- `update_working_context` → model updates scratch pad

**Automatic extraction (new — the real value):**
- **Session-end hook**: When a session closes, Haiku sweeps the full transcript → `extractFacts()` → stores to DB
- **Mid-session flush tool**: `flush_session_to_memory` — model calls explicitly when it finishes a block of work. Extracts from recent conversation since last flush.
- **Source tagging**: All extracted facts tagged with `source: cc-session:{session-id}` or `source: cc-interactive:{timestamp}` for traceability

### New MCP Tool: `flush_session_to_memory`

```typescript
{
  name: 'flush_session_to_memory',
  description: 'Extract and store facts from the current conversation into long-term memory. '
    + 'Call after completing a research task, making decisions, or learning new information. '
    + 'Extracts facts, decisions, people, and commitments using the same pipeline as Slack extraction.',
  input_schema: {
    type: 'object',
    properties: {
      conversation_summary: {
        type: 'string',
        description: 'Summary of the conversation so far (the model provides this)'
      },
      source_label: {
        type: 'string',
        description: 'Label for the source (e.g., "research-project-x", "meeting-prep")'
      }
    },
    required: ['conversation_summary']
  }
}
```

The handler calls `extractFacts()` on the summary, then `storeExtractionResult()` — the same pipeline Clawvato uses after Slack interactions. No new extraction logic needed.

### Session-End Hook (Automatic Safety Net)

For interactive sessions on Railway:

```json
// .claude/hooks.json on Railway
{
  "SessionEnd": [{
    "hooks": [{
      "type": "command",
      "command": "npx tsx src/hooks/session-end-extract.ts"
    }]
  }]
}
```

`session-end-extract.ts` reads the session transcript (via Claude Code session files), runs Haiku extraction, and stores results. This catches knowledge from sessions where the model didn't explicitly call `flush_session_to_memory`.

For `--print` sessions (Slack deep path): extraction already happens in `hybrid.ts` post-interaction — no change needed.

### Local → Cloud Memory Flow

```bash
# Local .claude/mcp.json (or plugin config)
{
  "mcpServers": {
    "clawvato-memory": {
      "command": "ssh",
      "args": [
        "-o", "StrictHostKeyChecking=no",
        "railway-container",
        "cd /app && LOG_DESTINATION=stderr npx tsx src/mcp/memory/stdio.ts --data-dir /data"
      ]
    }
  }
}
```

Local session → calls `store_fact` or `flush_session_to_memory` → MCP call travels over SSH → server writes to Railway's `/data/clawvato.db` → next Slack interaction, Clawvato has the knowledge.

### Session Continuity with `--session`

Deep path can maintain session state across Slack messages in the same thread:

```
Slack thread ts: 1234567890.123456
  → claude --print --session slack-1234567890 ...
  → claude --print --session slack-1234567890 --resume ...
```

Benefits:
- No need to reassemble full context from Slack API each time
- Model remembers what it already searched/found
- Combined with Memory MCP: short-term (session) + long-term (DB) memory

Session IDs can be mapped from Slack thread timestamps. Sessions auto-expire (Claude Code manages cleanup).

### Project-Level MCP Config (Immediate Win)

Instead of building a temp MCP config file per deep-path call, create a project-level config:

```json
// /app/.claude/mcp.json (on Railway)
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["tsx", "src/mcp/memory/stdio.ts", "--data-dir", "/data"]
    }
  }
}
```

All `claude` invocations from `/app` — interactive SSH, `--print`, any future context — automatically get the memory MCP server. Deep-path.ts can stop creating temp files.

## Implementation Phases

### Phase 0: Unified Memory Bridge (highest value, least code)
- Create `.claude/mcp.json` with memory server config
- Add `flush_session_to_memory` tool to Memory MCP server
- Add `--session` support to deep path (map Slack thread ts → session ID)
- Simplify `deep-path.ts` `buildMcpConfig()` to use project-level config
- Add session-end extraction hook (`src/hooks/session-end-extract.ts`)
- Test: SSH into Railway, run interactive `claude`, verify memory read/write

### Phase 1: Plugin Scanner + MCP merge
- Build `scanner.ts` — discover plugins, parse manifests, resolve MCP configs
- Merge discovered plugin MCP servers into project `.claude/mcp.json` at startup
- Add plugin MCP tools to `--allowedTools`
- Config: `plugins.dirs`, `plugins.enabled`

### Phase 2: Skill injection
- Parse SKILL.md files in scanner
- Selective loading logic (keyword match + max cap)
- Inject into deep path system prompt via `buildSdkSystemPrompt()`
- Skill index in system prompt (always-on, one-line summaries)

### Phase 3: Hook wiring + fast path
- Register plugin hooks in existing hook system
- Append lightweight skill instructions to fast path system prompt
- Agent definitions as subagent configs (future)

### Phase 4: Local dev bridge
- SSH tunnel setup instructions / script
- Local `.claude/mcp.json` template pointing at Railway
- Package as installable plugin (`clawvato-memory`)
- Optionally: DB sync/replica for offline local access

### Phase 5: Deployment pipeline
- `PLUGINS_TAR_B64` env var for Railway (or git clone)
- Docker entrypoint unpacking + `.claude/mcp.json` generation
- Plugin directory validation + security checks

## Open Questions

1. **Selective loading granularity**: Should the router explicitly name which plugins/skills to load, or is keyword matching sufficient?
2. **Plugin versioning**: How to handle version conflicts between plugins that provide overlapping MCP servers?
3. **Fast path MCP**: Could we run lightweight MCP servers in-process for the fast path (avoiding subprocess overhead)?
4. **Plugin state**: Plugins with `${CLAUDE_PLUGIN_DATA}` expect persistent state — how does this map to Railway's `/data` volume?
5. **Hot reload**: Should Clawvato detect plugin changes at runtime, or only at startup?
6. **Session cleanup**: How long should `--session` state persist? Map to Slack thread TTL?
7. **Extraction dedup**: If a session flushes mid-way and then session-end hook also extracts, how to avoid duplicate facts? (Existing dedup via `contentSimilarity` may suffice.)
8. **Local offline mode**: Should the local plugin support a local SQLite replica that syncs to Railway, or is SSH tunnel sufficient?
9. **Railway SSH access**: Best mechanism — `railway shell`, SSH service on a port, or Tailscale/WireGuard tunnel?
