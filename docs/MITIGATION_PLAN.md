# Security & Quality Mitigation Plan

> Created: 2026-03-19 | Source: Code review session 15

## Priority 1 — Fix Now (data integrity + exfiltration risk)

### S1 + Q2: Findings file — randomize path, validate content
**Risk**: Fixed `/tmp/clawvato-findings.json` path has TOCTOU race on concurrent deep paths + memory poisoning via prompt-injected content.
**Fix**:
- Generate UUID-stamped temp path per invocation: `/tmp/clawvato-findings-{uuid}.json`
- Pass path to subprocess via prompt (replace hardcoded path in `deep-path.md`)
- Validate parsed findings: whitelist field names, clamp importance/confidence, reject suspiciously long content
- **Files**: `hybrid.ts` (FINDINGS_FILE → per-invocation), `deep-path.md` (template path)

### S5: Subprocess env — allowlist instead of blocklist
**Risk**: Deep path subprocess inherits Slack tokens, Fireflies key, OAuth token. Prompt injection → `echo $SLACK_BOT_TOKEN` → exfiltration.
**Fix**:
- Replace `const { ANTHROPIC_API_KEY: _, ...cleanEnv } = process.env` with explicit allowlist:
  ```typescript
  const cleanEnv = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    DATA_DIR: process.env.DATA_DIR,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    GWS_CONFIG_B64: process.env.GWS_CONFIG_B64,
    FIREFLIES_API_KEY: process.env.FIREFLIES_API_KEY,
    NODE_ENV: process.env.NODE_ENV,
  };
  ```
- Remove SLACK_BOT_TOKEN, SLACK_APP_TOKEN, OWNER_SLACK_USER_ID from subprocess
- **Files**: `deep-path.ts` (env construction)

### S4: Restrict `Write` tool in deep path
**Risk**: Unrestricted `Write` tool can overwrite DB, MCP config, any file.
**Fix**: Remove `Write` from `--allowedTools`. Findings file uses `Bash(cat:*)` which is already allowed. If `Write` is needed later, restrict to `/tmp/*`.
- **Files**: `deep-path.ts` (allowedTools list)

### S6: Sanitize final response before posting to Slack
**Risk**: LLM could echo API keys or secrets found in emails/docs into the Slack response.
**Fix**: Call `scanForSecrets(finalResponse)` before posting. Redact matches.
- **Files**: `hybrid.ts` (before Slack post in post-response section)

## Priority 2 — Fix Soon (reliability + silent failures)

### S2 + Q4: FTS5 query sanitization
**Risk**: Special chars in user messages cause FTS5 syntax errors → silent fallback to recency search, losing semantic relevance.
**Fix**: Wrap each keyword token in double quotes before FTS5 MATCH: `"token1" OR "token2"`. This forces literal matching and is immune to FTS5 operator injection.
- **Files**: `store.ts` (searchMemories FTS5 query), `retriever.ts` (ftsQuery construction)

### Q1: Fix copy-paste bug in cancellation log
**Risk**: `toolCalls` field logs `durationMs` instead of actual tool count. Misleading debug data.
**Fix**: Change to `logger.info({ durationMs: result.durationMs }, 'Deep path cancelled by owner')`.
- **Files**: `hybrid.ts:499`

### Q3: Route assistant messages through serialization chain
**Risk**: `handleAssistantMessage` bypasses `processingChain` → concurrent access to `activeTask` state.
**Fix**: Route through `this.processingChain.then(...)` like regular batches.
- **Files**: `handler.ts` (handleAssistantMessage)

### Q9: Fix duplicate `loadWorkingContext` call
**Risk**: Deep path gets working context with wrong (default) budget, duplicated in prompt.
**Fix**: Reuse `deepWorkingContext` instead of calling `loadWorkingContext(db)` again.
- **Files**: `hybrid.ts:478`

## Priority 3 — Fix When Convenient (robustness)

### Q5: Add pre-flight hard timeout
**Risk**: Owner walks away → pre-flight loop runs forever, blocks all Slack processing.
**Fix**: Add `config.agent.preflightMaxWaitMs` (default 30 min). Auto-cancel with message if exceeded.
- **Files**: `hybrid.ts` (pre-flight while loop), `config.ts`, `default.json`

### Q6: SIGKILL followup for deep path subprocess
**Risk**: SIGTERM may not kill a busy subprocess.
**Fix**: `proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), 5000);`
- **Files**: `deep-path.ts` (abort handler + timeout handler)

### Q7: Robust JSON extraction from Haiku
**Risk**: Multi-block or wrapped responses silently drop all extracted facts.
**Fix**: Use regex to extract first JSON block: `text.match(/```json?\s*([\s\S]*?)```/i)` with fallback.
- **Files**: `extractor.ts:96`

### S8: Validate `store_fact` MCP inputs
**Risk**: Unbounded content length, unclamped importance/confidence values.
**Fix**: Clamp values (matching `processDeepPathFindings` logic), cap content at 10K chars.
- **Files**: `mcp/memory/server.ts` (handleStoreFact)

### S7: Persist rate limiter to SQLite
**Risk**: Rate limits reset on process restart — last defense against prompt-injected email sends.
**Fix**: Store counters in `agent_state` table with TTL.
- **Files**: `rate-limiter.ts`

## Not Fixing (acceptable risk for single-user system)

### S3: Structural prompt injection from external Slack messages
**Status**: The `[EXTERNAL]` prefix + system prompt warning is the standard mitigation. XML tags would be marginally better but adds complexity. The single-principal model means only the owner can trigger destructive actions. Monitor but don't over-invest.

### Q10: Test coverage for orchestration layer
**Status**: Acknowledged gap. The orchestration layer is hard to unit test (Slack API, subprocess spawning, MCP protocol). Integration tests or a test harness would be the right approach, but ROI is low for a single-user system that gets tested manually with every deploy.
