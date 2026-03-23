# Design: Remote Memory Plugin (HTTP MCP Server)

> Status: Proposed | Priority: High | Track: H (Plugin Adapter)
> Supersedes: SSH tunnel approach in DESIGN_PLUGIN_ADAPTER.md Phase 4
> Depends on: clawvato-memory plugin (validated, 7 bugs fixed in Session 20)

## Problem

The memory plugin (`clawvato-memory`) is validated and working locally, but propagating updates to all CC instances is manual:

- **Local CC**: Reads plugin from disk. Edit file → `/mcp` restart → done.
- **Railway CC**: Uses the **in-tree** MCP server (`src/mcp/memory/server.ts`) — a separate codebase with different behavior (no `retire_memory`, no `valid_until` filter, no session-scoped working context, no `list_working_contexts`).
- **Cowork / teammate CC**: Would need their own copy of the plugin + DB connection string.

Worse, the Railway CC instance doesn't even know multi-instance features exist. When asked "can you see what other sessions are working on?", it gives a canned "CC can only see its own session" answer because its in-tree MCP server doesn't expose `list_working_contexts` and its system prompt doesn't teach the capability.

**The goal**: Push a fix to one repo → every CC instance (Railway, local, Cowork, future teammates) picks it up automatically, with zero redeployment of anything else.

## Architecture: HTTP MCP Server on Railway

```
┌─────────────────────────────────────────────────────────────┐
│  Railway                                                     │
│                                                              │
│  ┌──────────────────────┐     ┌──────────────────────────┐  │
│  │  clawvato-memory      │     │  Postgres (managed)       │  │
│  │  (HTTP MCP server)    │────▶│  memories, agent_state,   │  │
│  │  Port 8100            │     │  memory_entities, etc.    │  │
│  │  Streamable HTTP      │     └──────────────────────────┘  │
│  │  transport             │                                   │
│  └──────────┬────────────┘                                   │
│             │ internal network                                │
│  ┌──────────┴────────────┐                                   │
│  │  clawvato (CC-native)  │                                   │
│  │  Claude Code engine    │                                   │
│  │  Connects to memory    │                                   │
│  │  via internal URL      │                                   │
│  └────────────────────────┘                                   │
└─────────────────────────────────────────────────────────────┘
          │
          │ HTTPS (public or Tailscale)
          │
┌─────────┴───────────────────────────────────────────────────┐
│  Local / Cowork / Teammate                                    │
│                                                              │
│  claude (interactive)                                        │
│    └── .mcp.json → url: https://memory.clawvato.railway.app │
│                                                              │
│  Any CC instance with the URL + auth token can connect.      │
└──────────────────────────────────────────────────────────────┘
```

### Why HTTP, not stdio?

| | stdio (current) | HTTP (proposed) |
|---|---|---|
| **Update propagation** | Edit file + restart MCP process | Push to repo → Railway redeploys → all clients get new version |
| **Multi-client** | One client per process (1:1) | Many clients per server (1:N) |
| **Railway ↔ local** | Need SSH tunnel or local copy | Just a URL |
| **Auth** | Implicit (local process) | Bearer token header |
| **Latency** | ~0ms (IPC) | ~50-100ms (HTTPS) — acceptable for memory ops |
| **MCP SDK support** | Yes (StdioServerTransport) | Yes (StreamableHTTPServerTransport, stable since MCP SDK 1.8+) |

## Implementation Plan

### Step 1: Add HTTP transport to clawvato-memory plugin

The MCP SDK provides `StreamableHTTPServerTransport` alongside `StdioServerTransport`. The plugin can support both:

```typescript
// server/index.ts
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const mode = process.env.MCP_TRANSPORT ?? 'stdio';

if (mode === 'http') {
  const port = parseInt(process.env.PORT ?? '8100');
  const authToken = process.env.MCP_AUTH_TOKEN;

  // Express/Node HTTP server wrapping StreamableHTTPServerTransport
  // Auth middleware: verify Bearer token on every request
  // Health check endpoint: GET /health
  // MCP endpoint: POST /mcp (StreamableHTTPServerTransport handles the rest)
} else {
  // Existing stdio path — unchanged
  await mcp.connect(new StdioServerTransport());
}
```

**Key design choice**: The same `server/index.ts` file serves both transports. Local dev uses stdio (zero config). Railway runs HTTP. No code fork.

### Step 2: Deploy as a separate Railway service

```yaml
# In Railway dashboard or railway.toml
[service.clawvato-memory]
  source = "github.com/andrewcovato/clawvato-memory"
  build_command = "npm install"
  start_command = "npm start"

  [service.clawvato-memory.env]
    MCP_TRANSPORT = "http"
    PORT = "8100"                          # Railway injects $PORT automatically
    DATABASE_URL = "${{Postgres.DATABASE_URL}}"
    MCP_AUTH_TOKEN = "{{generate secret}}"

  [service.clawvato-memory.networking]
    # Internal: clawvato-memory.railway.internal:8100 (for CC-native on same project)
    # Public: optional, for local/external CC instances
```

**GitHub auto-deploy**: Push to `clawvato-memory` repo → Railway redeploys the service → all connected CC instances get the new tools/behavior on next MCP reconnect.

### Step 3: Wire CC instances to the HTTP server

**Railway CC-native** (internal network, zero latency):
```json
// .cc-native-mcp.json (or injected at startup)
{
  "mcpServers": {
    "clawvato-memory": {
      "type": "url",
      "url": "http://clawvato-memory.railway.internal:8100/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

**Local CC** (public URL):
```json
// ~/.claude/projects/<path>/.mcp.json
{
  "mcpServers": {
    "clawvato-memory": {
      "type": "url",
      "url": "https://clawvato-memory-production.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer ${MCP_AUTH_TOKEN}"
      }
    }
  }
}
```

**Cowork / teammate**: Same as local — just share the URL + token.

### Step 4: Teach CC instances what they have

This is the critical "awareness" problem. The Railway CC instance today doesn't know `list_working_contexts` exists because:
1. Its MCP server doesn't expose it
2. Its system prompt doesn't mention it
3. The SKILL.md isn't loaded

**Solution: SKILL.md as a CC skill, loaded from the plugin repo.**

The plugin already has `skills/memory/SKILL.md`. When CC connects to the MCP server, it discovers the tools via `tools/list`. But tool descriptions alone don't teach *when* and *how* to use them — that's what SKILL.md does.

**Three-layer teaching**:

1. **Tool discovery** (automatic): MCP `tools/list` returns tool names + descriptions. CC sees the tools exist.
2. **Skill injection** (needs wiring): SKILL.md content is either:
   - Bundled into the CC-native system prompt (`config/prompts/cc-native-system.md`)
   - Loaded as a CC skill from the plugin directory
   - Served as an MCP resource (the MCP SDK supports `resources/read` — the server can expose SKILL.md as a resource that CC reads on startup)
3. **Behavioral reinforcement** (prompt-driven): The system prompt says "You have a shared memory brain. Search before answering. Store facts proactively. Use `list_working_contexts` for multi-instance awareness."

**Recommended approach**: Option (c) — serve SKILL.md as an MCP resource. This way the teaching content travels with the server, not with each client's config. Update SKILL.md in the plugin repo → redeploy → all instances get the updated instructions.

```typescript
// In server/index.ts
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [{
    uri: 'memory://skill',
    name: 'Memory Skill Guide',
    description: 'Instructions for how to use the shared memory brain effectively',
    mimeType: 'text/markdown',
  }],
}));

mcp.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  if (req.params.uri === 'memory://skill') {
    return { contents: [{ uri: 'memory://skill', mimeType: 'text/markdown', text: SKILL_MD_CONTENT }] };
  }
  throw new Error(`Unknown resource: ${req.params.uri}`);
});
```

**Note**: CC doesn't auto-read MCP resources today (as of March 2026). Until it does, we should also inject key behavioral instructions into the system prompt. The resource approach is forward-compatible — when CC starts reading MCP resources, the teaching will flow automatically.

**Interim**: Add a condensed version of SKILL.md to `config/prompts/cc-native-system.md`:

```markdown
## Shared Memory Brain

You have access to a shared memory brain via the clawvato-memory MCP server. This brain is shared across all CC instances.

Key tools:
- `search_memory` — search before answering questions
- `store_fact` — store facts proactively after learning something new
- `retire_memory` — soft-retire incorrect facts (store corrected version first)
- `retrieve_context` — token-budgeted context for a topic
- `list_working_contexts` — see what other CC sessions are working on
- `update_working_context` — your session's scratch pad

Rules:
- Store what+why, never how (implementation details belong in code)
- Search before storing to avoid duplicates
- To correct a fact: store_fact (new) → retire_memory (old)
- Use list_working_contexts for multi-instance awareness
```

### Step 5: Update SKILL.md for retire_memory

The current SKILL.md still references `delete_memory`. Update to reflect `retire_memory` and the correction workflow.

## Auth Model

Simple bearer token auth. The token is:
- Generated once, stored as a Railway env var (`MCP_AUTH_TOKEN`)
- Shared with local CC via the `.mcp.json` `headers` field
- Rotated manually if compromised

**Why not OAuth/API keys?** This is a single-principal system (one owner). The token just prevents drive-by access to the public URL. If the owner wants to share with a teammate, they share the token.

**Future**: If Clawvato gains multi-user support, upgrade to per-user API keys with scoped permissions.

## Migration Path

### Phase 1: Dual transport (now)
- Add HTTP transport to plugin, keep stdio working
- Deploy as Railway service alongside CC-native
- Local CC switches from stdio → HTTP URL
- Railway CC switches from in-tree MCP → HTTP URL (internal network)
- Validate: both instances see each other's working contexts

### Phase 2: Remove in-tree MCP server
- Once Railway CC is on the plugin, the in-tree `src/mcp/memory/server.ts` is dead code
- Remove it and the `src/mcp/memory/stdio.ts` entrypoint
- The plugin repo is now the single source of truth for memory tools

### Phase 3: SKILL.md as MCP resource
- Add resource serving to the plugin
- When CC supports auto-reading MCP resources, remove the system prompt duplication
- SKILL.md becomes the single source of truth for memory behavior instructions

## Latency Budget

Memory operations are not in the hot path of conversation. Typical usage:
- `search_memory`: 1-2 calls per message, ~50ms each over internal network
- `store_fact`: 0-1 calls per message, ~30ms each
- `retrieve_context`: 1 call at conversation start, ~100ms

Total added latency per message: ~100-200ms over internal network. Negligible compared to LLM inference time (~5-30 seconds).

Over public internet (local CC): add ~50ms RTT. Still under 300ms total. Acceptable.

## Open Questions

1. **Public URL exposure**: Should the memory server be publicly accessible (with auth), or only via Tailscale/private network? Public is simpler for local dev; private is more secure.
2. **Connection pooling**: StreamableHTTPServerTransport creates a new session per request (stateless). Does this interact well with postgres.js connection pooling (`max: 3`)? May need to increase.
3. **Rate limiting**: Should the HTTP server rate-limit requests? Probably not initially (single-principal), but good to have the middleware slot.
4. **Graceful reconnect**: When the memory service redeploys, connected CC instances will get connection errors. MCP SDK's HTTP transport should auto-reconnect, but verify this behavior.
5. **Monitoring**: Add a `/health` endpoint that checks Postgres connectivity. Wire to Railway health checks for auto-restart.
