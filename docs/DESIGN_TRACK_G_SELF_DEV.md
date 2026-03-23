# Track G: GitHub Integration + Self-Development

> Status: Design | Author: Andrew + Claude | Date: 2026-03-22

## Vision

Clawvato can maintain and extend its own codebase. The owner requests features via Slack, and Clawvato plans, implements, tests, and deploys them — with safety rails that prevent self-bricking.

## The Core Risk

If Clawvato deploys broken code to itself, it can't fix itself because it's broken. This is the #1 design constraint. Every mechanism below exists to prevent this.

## Safety Architecture: The Three-Gate Model

### Gate 1: Branch Isolation
- Clawvato NEVER commits to `main` or the currently-running branch
- All work happens on feature branches (`clawvato/feature-name`)
- The running branch is sacrosanct — it's the known-good fallback

### Gate 2: Pre-Deploy Verification
Before any self-deploy, Clawvato must:
1. **Build passes**: `npm run build` succeeds
2. **Tests pass**: `npm test` succeeds (requires DB access)
3. **Type check passes**: `npx tsc --noEmit`
4. **PR created**: Changes are visible on GitHub for owner review
5. **Owner approval** (configurable): Wait for owner to approve in Slack before deploying

### Gate 3: Post-Deploy Health Check + Auto-Rollback
After deploying new code:
1. **Heartbeat**: Clawvato sends a "I'm alive" message to Slack within 2 minutes
2. **Self-test**: Clawvato runs a basic self-test (search memory, respond to a ping)
3. **If heartbeat fails**: Railway auto-rolls back to the previous deployment
4. **If self-test fails**: Clawvato reverts to the previous branch and redeploys
5. **Dead man's switch**: If no Slack activity for 5 minutes post-deploy, auto-revert

### The Rollback Chain

```
Feature branch deployed → health check starts
  ├── Heartbeat within 2 min?
  │   ├── YES → self-test passes?
  │   │   ├── YES → deployment stable ✅
  │   │   └── NO → revert to previous branch, redeploy
  │   └── NO → Railway health check fails → auto-rollback to previous deployment
  └── Dead man's switch (5 min no activity) → revert + notify owner
```

### The "Golden Branch" Pattern

```
main (or cc-native-engine)     ← NEVER touched by Clawvato
  └── clawvato/feature-xyz     ← Clawvato works here
        ├── build + test
        ├── PR created
        ├── owner approves (or auto-approve for low-risk)
        └── deploy to Railway
              ├── health check passes → merge to main
              └── health check fails → revert, notify owner
```

## Risk Classification

Not all changes are equal. Clawvato classifies its own changes:

### Low Risk (can auto-approve)
- Prompt changes (`config/prompts/*.md`)
- Config changes (`config/default.json`)
- New tools added (additive, nothing removed)
- Documentation
- Memory/extraction improvements

### Medium Risk (notify owner, proceed after 5 min if no objection)
- Existing code modifications
- New source files
- Dependency changes
- MCP server changes

### High Risk (require explicit owner approval)
- Changes to `Dockerfile`, entrypoint scripts, deployment config
- Changes to the self-dev system itself (this module)
- Removal of existing functionality
- Database schema changes
- Security-related changes

## Implementation

### Prerequisites
- `gh` CLI installed in Docker image (for PRs, issues)
- GitHub token in env (`GITHUB_TOKEN`)
- Git configured with push access
- Railway CLI available for deployment

### New Components

**`src/cc-native/self-dev.ts`** (or system prompt instructions):
Since CC-native uses Claude Code natively, self-dev is mostly prompt-driven:
- CC already has Read, Write, Edit, Bash, Git via Bash
- `gh` CLI for PRs
- System prompt teaches the safety protocol

**System prompt additions:**
```markdown
## Self-Development Protocol

You can modify your own codebase. Follow these rules strictly:

1. NEVER commit to the currently-running branch
2. Create a feature branch: `git checkout -b clawvato/<feature-name>`
3. Make changes, then verify:
   - `npm run build` passes
   - `npm test` passes (if tests exist for the changes)
   - `npx tsc --noEmit` passes
4. Commit with clear message
5. Push and create PR: `gh pr create --title "..." --body "..."`
6. Report to owner: "PR #N ready — [title]. [risk level]. [summary]"
7. Wait for owner approval before deploying
8. After deploy: send heartbeat, run self-test
9. If anything fails: revert immediately
```

**Health check endpoint** (`src/cc-native/health.ts`):
- Simple HTTP endpoint that the channel server exposes
- Returns 200 if channel server is connected to Slack + CC is responding
- Railway uses this for container health checks
- Failure → Railway auto-rolls back

**Rollback script** (`scripts/rollback.sh`):
- Accepts a branch name or deployment ID
- Switches Railway to that branch/deployment
- Notifies owner in Slack
- Can be triggered by health check failure OR by owner command

### Workflow Example

```
Owner: "Add a tool that searches our Notion workspace"

Clawvato:
  1. Reads existing tool patterns (google/tools.ts, fireflies/tools.ts)
  2. Plans the implementation
  3. Reports plan to owner in Slack
  4. [Owner approves plan]
  5. git checkout -b clawvato/notion-integration
  6. Implements: MCP server, tools, config
  7. npm run build && npm test && tsc --noEmit
  8. git commit + push
  9. gh pr create
  10. Reports: "PR #52: Notion integration. Medium risk. Added MCP server + 3 tools."
  11. [Owner approves deploy]
  12. Railway deploys the branch
  13. Health check: heartbeat + self-test
  14. If healthy: "Deployed successfully. Notion tools are live."
  15. If unhealthy: auto-revert, "Deploy failed — reverted to previous version. Error: [details]"
```

### Edge Cases

**Q: What if Clawvato breaks during the health check itself?**
A: Railway's built-in health check is the backstop. If the container crashes, Railway keeps the previous deployment running.

**Q: What if the broken code passes all pre-deploy checks?**
A: The post-deploy self-test catches runtime issues. And the dead man's switch catches total failures. The owner can also say "revert" at any time.

**Q: What if Clawvato modifies the rollback mechanism itself?**
A: High-risk classification — requires explicit owner approval. The rollback script lives outside the CC-native code path.

**Q: What if the owner isn't available to approve?**
A: Low-risk changes can auto-approve after the 3-gate check. Medium/high risk changes wait indefinitely. Clawvato reports the pending PR and moves on to other work.

**Q: Can Clawvato create tasks for itself to implement later?**
A: Yes — "I should add error handling for the Notion API rate limits" → creates a task → implements later. Self-directed improvement.

## Phases

### Phase 1: Read-only GitHub (safe, immediate value)
- Install `gh` CLI in Docker
- CC can read issues, PRs, repo structure
- Owner: "check if there are any open issues" → Clawvato reads GitHub
- No write access, no self-modification

### Phase 2: Branch + PR (safe, owner-gated)
- Git push access to feature branches only
- CC can implement changes and create PRs
- Owner reviews and approves/rejects
- No self-deployment

### Phase 3: Self-deploy with safety rails (the full vision)
- Health check endpoint
- Rollback mechanism
- Risk classification
- Auto-revert on failure
- Dead man's switch

## Open Questions

1. **Git identity**: What name/email for commits? `clawvato@growthbyscience.com`?
2. **Test database**: Self-dev needs a test DB for `npm test`. Use the production DB with isolated schemas, or a separate test instance?
3. **Concurrent development**: What if the owner is also developing on a branch? Need to handle merge conflicts gracefully.
4. **Rate limiting**: Should there be a limit on how many self-dev PRs Clawvato can create per day?
5. **Code review quality**: Should Clawvato review its own PRs with a subagent before presenting to the owner?
