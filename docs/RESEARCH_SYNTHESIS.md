# Research Synthesis: Key Findings & Architecture Adjustments

## What the Research Changed

### 1. Agent Framework: Claude Agent SDK, Not Custom

**Finding**: The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) already handles the agent loop, MCP connections, tool routing, model selection, subagents, and session persistence. Building a custom orchestration loop is reinventing the wheel.

**Adjustment**: Use the Agent SDK as the core runtime. Our code is the *configuration layer* on top — defining tools, MCP servers, hooks, and the training-wheels policy engine.

Key SDK features we get for free:
- `PreToolUse` / `PostToolUse` hooks → our security layer
- Native MCP client → connects to all our MCP servers
- Subagent spawning via `Task` tool → model routing (Opus planner, Sonnet executor, Haiku classifier)
- Session persistence → conversation continuity
- Tool search → auto-discovers MCP tools without context bloat

### 2. Memory: Adopt the Generative Agents Retrieval Formula + Bi-Temporal Facts

**Finding**: The Stanford "Generative Agents" paper's `recency × importance × relevance` retrieval formula outperforms any single-factor approach. Zep/Graphiti's bi-temporal `(t_valid, t_invalid)` model solves the stale-fact problem elegantly.

**Adjustment**: Replace our simple relevance_score with the triple-factor formula. Add temporal validity to all facts. Keep the three-tier architecture but adopt MemGPT's approach of giving the agent explicit memory tools rather than only doing retrieval behind the scenes.

### 3. Security: Plan-Then-Execute as Structural Defense

**Finding**: The Reversec paper (2025) and Meta's "Rule of Two" show that architectural patterns provide stronger prompt injection defense than any prompt-level defense. Plan-then-execute constrains what the agent can do during execution — untrusted data cannot alter the plan.

**Adjustment**: Make Plan-Then-Execute the default loop:
1. **Planner** (Opus) receives the user's message + retrieved context → produces a structured plan
2. **Executor** (Sonnet) executes the plan step by step, with each step validated by PreToolUse hooks
3. Untrusted data (email content, file content, Slack messages from others) can inform the plan but cannot add new steps during execution

### 4. MCP Servers: Use Existing Ones Where Possible

**Finding**: Production-quality MCP servers already exist for GitHub, filesystem, Slack, and browser automation. Google Workspace MCP servers exist but are community-maintained.

**Adjustment**:
- **GitHub**: Use the official GitHub MCP server (Go-based, stdio transport)
- **Filesystem**: Use `@modelcontextprotocol/server-filesystem` with sandboxed directories
- **Slack**: Build custom (existing servers don't support our sender-verification and user-token search requirements)
- **Google Workspace**: Build custom (need tight integration with our credential management and output sanitizer)
- **Browser/Web Research**: Use `@playwright/mcp` for web research capability
- **Memory**: Build custom (our three-tier system with triple-factor retrieval is novel)

### 5. Local Embeddings + sqlite-vec: Confirmed Best Choice

**Finding**: `@huggingface/transformers` with `all-MiniLM-L6-v2` runs at ~5-15ms per sentence on Apple Silicon. sqlite-vec handles up to 100K vectors with 4-57ms query time. FTS5 gives us free hybrid search.

**Adjustment**: Stack confirmed. Use quantized (`q8`) model for 2x faster inference. Run embeddings in a worker thread to avoid blocking the event loop. sqlite-vec + FTS5 for hybrid retrieval.

### 6. Slack: Socket Mode + Chat Streaming

**Finding**: Socket Mode works perfectly for local deployment — no public endpoint needed. Slack's new `chat.startStream`/`appendStream`/`stopStream` APIs enable LLM-style streaming responses. The Real-time Search API provides bot-token search for public channels.

**Adjustment**: Adopt chat streaming for real-time response delivery. Implement catch-up polling on reconnection (Socket Mode has no delivery guarantee for missed events). Use both bot token + user token (user token for private channel search).

### 7. Durable Workflows: SQLite State Machine, Not Temporal

**Finding**: Temporal is the gold standard for durable execution (used by Dust.tt), but it's operationally expensive to self-host. For a single-user local agent, a SQLite-backed state machine with the same guarantees (checkpoint-per-step, crash recovery) is sufficient.

**Adjustment**: Build a lightweight workflow engine inspired by Temporal's patterns:
- Each workflow step is a "checkpoint" persisted to SQLite
- On crash recovery, replay from last checkpoint
- Use `continue-as-new` pattern for long-running workflows (prevent unbounded state growth)

---

## Cool Features & Upgrades to Add

### Feature 1: "Context Bridge" — Cross-Source Intelligence
The agent sees your Slack, email, calendar, files, and GitHub. It can connect dots humans miss:
- "Sarah asked about the Q2 budget in Slack yesterday, and Jake emailed about budget revisions this morning. These might be related — should I loop them in together?"
- "You have a meeting with the Acme team tomorrow, but the proposal draft in Drive hasn't been updated since last week. Want me to remind you?"

### Feature 2: "Ghost Draft" Mode
For high-stakes outbound communications, the agent prepares everything but executes nothing:
- Composes the email, shows it in Slack with a one-click send button
- Prepares calendar invites with all details, waits for approval
- Creates Drive permission changes, shows diff of before/after sharing state

### Feature 3: Relationship Intelligence
Build rich profiles of everyone you interact with:
- Communication frequency and preferred channels
- Topics you typically discuss
- Timezone and availability patterns
- Response time patterns ("Jake typically replies within 2 hours")
- Relationship graph ("Sarah introduced you to Jake on Feb 15")

### Feature 4: "Undo Window"
For graduated (auto-approved) actions, maintain a 5-minute undo window:
- "I auto-shared the weekly report with #team as usual. Undo within 5 min."
- Undo reverts the file permission change
- Provides psychological safety for increasing autonomy

### Feature 5: Daily Briefing
Each morning (configurable time), DM a structured briefing:
- Today's calendar with prep notes ("Meeting with Acme — last email thread was about pricing")
- Pending action items from yesterday
- Emails that need responses (with draft suggestions)
- GitHub PRs/issues that need attention
- Any workflows still in progress

### Feature 6: "Teach Me" Mode
User can explicitly teach the agent:
- "@clawvato remember: when someone asks for the investor deck, always share the one in /Decks/Current, not the archived version"
- "@clawvato my scheduling preferences: no meetings before 10am, prefer 25-min meetings, Fridays are focus days"
- These become high-confidence, non-decaying preferences

### Feature 7: Web Research Agent
Use Playwright MCP to do lightweight research:
- "@clawvato what's the latest pricing for Notion Business plan?"
- "@clawvato find Jake Martinez on LinkedIn and tell me his current title"
- Useful for pre-meeting prep, competitive intelligence, etc.

### Feature 8: "What Would You Do?" / Suggestion Mode
Instead of waiting for instructions, proactively suggest actions:
- "You have 3 unread emails from yesterday — want me to draft responses?"
- "The standup notes haven't been shared yet (usually done by 9:15am). Should I post them?"
- User can thumbs-up/down suggestions to train the agent's proactivity level

---

## Anti-Patterns to Avoid (from Research)

| Anti-Pattern | Lesson Source | Our Mitigation |
|---|---|---|
| Dumping all memory into every prompt | ChatGPT Memory analysis | Token-budgeted tiered retrieval (max 3000 tokens) |
| No step limits or cost budgets | AutoGPT disasters | Per-request token budget, per-action rate limits, circuit breakers |
| Vector DB before you need it | AutoGPT's own admission | Start with structured queries, add vector search for semantic gap |
| Relying on prompting for security | All 2025 security research | Architectural defense: Plan-Then-Execute + sender verification + PreToolUse hooks |
| No crash recovery for long tasks | Multiple production failures | SQLite-backed workflow checkpointing |
| Implicit agent communication | CrewAI lessons | Typed tool calls, structured plans, no free-form inter-agent messages |
| Static API keys in prompts | OWASP LLM Top 10 | Keychain storage, injected at tool execution time, never in LLM context |
