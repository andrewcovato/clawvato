/**
 * Agent Supervisor — lightweight process that routes mailbox messages to CC agents.
 *
 * Responsibilities:
 * 1. Listen for agent_mail NOTIFY events from Postgres
 * 2. Route messages to the right agent via `claude --print --session {agent-id}`
 * 3. Check inbox freshness before routing to entity agents
 * 4. Manage agent sessions (track active, queue if busy)
 *
 * This is NOT an LLM — it's a simple Node.js orchestration process.
 * ~200-300 lines, runs as a background sidecar alongside the curator and CoS.
 */

import postgres from 'postgres';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { join } from 'path';

const execFileAsync = promisify(execFile);

// ── Configuration ──

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('[supervisor] FATAL: DATABASE_URL is required');
  process.exit(1);
}

const MCP_CONFIG = process.env.SUPERVISOR_MCP_CONFIG ?? process.env.MCP_CONFIG ?? '/tmp/cc-native-mcp.json';
const ENTITY_PROMPT = process.env.ENTITY_AGENT_PROMPT ?? join(process.cwd(), 'config/prompts/entity-agent-system.md');
const BRAIN_STATES_DIR = process.env.BRAIN_STATES_DIR ?? '/data/brain-states';
const POLL_INTERVAL_MS = parseInt(process.env.SUPERVISOR_POLL_MS ?? '5000');
const MAX_CONCURRENT = parseInt(process.env.SUPERVISOR_MAX_CONCURRENT ?? '3');

// ── State ──

const activeAgents = new Map<string, { startedAt: Date; messageId: string }>();
const messageQueue: Array<{ toAgent: string; messageId: string; payload: Record<string, unknown>; fromAgent: string }> = [];

// ── Database Connection ──

const sql = postgres(DATABASE_URL, { max: 3 });

// ── Session Persistence ──

/**
 * Get the stored CC session ID for an agent, or null if no session exists.
 * Session IDs are stored in agent_state keyed by `agent-session:{agentName}`.
 */
async function getAgentSessionId(agentName: string): Promise<string | null> {
  const key = `agent-session:${agentName}`;
  const [row] = await sql`
    SELECT value FROM agent_state WHERE key = ${key} AND status = 'active'
  ` as unknown as Array<{ value: string }>;
  return row?.value ?? null;
}

/**
 * Store a CC session ID for an agent.
 */
async function setAgentSessionId(agentName: string, sessionId: string): Promise<void> {
  const key = `agent-session:${agentName}`;
  await sql`
    INSERT INTO agent_state (key, value, status, updated_at)
    VALUES (${key}, ${sessionId}, 'active', NOW())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
  `;
  console.log(`[supervisor] Stored session ID for ${agentName}: ${sessionId}`);
}

// ── Agent Execution ──

/**
 * Invoke a CC agent via --print with session resuming.
 *
 * Pattern:
 * 1. First run: no --resume, uses --name for labeling, --output-format json to capture session_id
 * 2. Parse session_id from JSON output, store in DB
 * 3. Subsequent runs: --resume <uuid> continues the same session
 *
 * Returns the agent's text response.
 */
async function invokeAgent(
  sessionName: string,
  prompt: string,
  model = 'claude-opus-4-6',
): Promise<string> {
  const sessionId = await getAgentSessionId(sessionName);

  const args = [
    '--print',
    '--model', model,
    '--dangerously-skip-permissions',
    '--max-turns', '30',
    '--output-format', 'json',
  ];

  if (sessionId) {
    // Resume existing session
    args.push('--resume', sessionId);
  } else {
    // New session — name it for discoverability
    args.push('--name', sessionName);
  }

  // Add MCP config if it exists
  if (existsSync(MCP_CONFIG)) {
    args.push('--mcp-config', MCP_CONFIG);
  }

  // Add system prompt if it exists
  if (existsSync(ENTITY_PROMPT)) {
    args.push('--append-system-prompt-file', ENTITY_PROMPT);
  }

  args.push(prompt);

  try {
    const { stdout, stderr } = await execFileAsync('claude', args, {
      timeout: 300_000, // 5 minute timeout per agent invocation
      maxBuffer: 10 * 1024 * 1024, // 10MB — agent responses can be large
      env: {
        ...process.env,
        HOME: process.env.HOME ?? '/home/clawvato',
      },
    });

    if (stderr) {
      console.error(`[supervisor] Agent ${sessionName} stderr: ${stderr.slice(0, 200)}`);
    }

    // Parse JSON output to get session_id and result
    let result = stdout.trim();
    let newSessionId: string | null = null;

    try {
      const parsed = JSON.parse(result);
      newSessionId = parsed.session_id ?? null;
      result = parsed.result ?? result;
    } catch {
      // Not JSON — use raw output (fallback if --output-format json not supported)
    }

    // Store session ID for future resumption
    if (newSessionId && newSessionId !== sessionId) {
      await setAgentSessionId(sessionName, newSessionId);
    }

    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[supervisor] Agent ${sessionName} failed: ${msg}`);

    // If resume fails (stale session), clear the stored ID and retry without it
    if (sessionId && msg.includes('session')) {
      console.log(`[supervisor] Clearing stale session for ${sessionName}, will create new on next invoke`);
      const key = `agent-session:${sessionName}`;
      await sql`DELETE FROM agent_state WHERE key = ${key}`.catch(() => {});
    }

    return `Agent error: ${msg}`;
  }
}

// ── Message Processing ──

/**
 * Process a single mailbox message — route to the appropriate agent.
 */
async function processMessage(
  toAgent: string,
  messageId: string,
  payload: Record<string, unknown>,
  fromAgent: string,
): Promise<void> {
  console.log(`[supervisor] Processing message ${messageId}: ${fromAgent} → ${toAgent}`);

  // Check if agent is already active
  if (activeAgents.has(toAgent)) {
    console.log(`[supervisor] Agent ${toAgent} is busy, queueing message ${messageId}`);
    messageQueue.push({ toAgent, messageId, payload, fromAgent });
    return;
  }

  // Mark agent as active
  activeAgents.set(toAgent, { startedAt: new Date(), messageId });

  try {
    // Check inbox freshness for entity agents
    if (toAgent.startsWith('agent-')) {
      const brainId = toAgent.replace('agent-', '').replace(/-/g, '/');
      const [pendingRow] = await sql`
        SELECT COUNT(*)::int as count FROM inbox
        WHERE status = 'pending'
          AND (metadata->>'brain_id' = ${brainId} OR metadata->>'brain_id' IS NULL)
      ` as unknown as Array<{ count: number }>;

      if (pendingRow?.count > 0) {
        console.log(`[supervisor] ${pendingRow.count} pending inbox items for ${brainId} — curator should process first`);
        // Send alert to curator
        await sql`
          INSERT INTO agent_messages (from_agent, to_agent, message_type, payload)
          VALUES ('supervisor', 'curator', 'notification', ${sql.json({ alert: `Pending inbox items for ${brainId}`, count: pendingRow.count })})
        `;
      }
    }

    // Build the prompt from the message payload
    const brainStateFile = getBrainStateFile(toAgent);
    let context = '';
    if (brainStateFile && existsSync(brainStateFile)) {
      context = `Read your brain state file at: ${brainStateFile}\n\n`;
    }

    const task = payload.task ?? payload.query ?? payload.alert ?? JSON.stringify(payload);
    const prompt = `${context}Message from ${fromAgent} (type: ${payload.message_type ?? 'task'}):\n${task}`;

    // Invoke the agent
    const response = await invokeAgent(toAgent, prompt);

    // Mark original as done — agent handles replying via reply_to_message MCP tool
    // Do NOT create a response message here — that causes infinite loops
    await sql`
      UPDATE agent_messages SET status = 'done', processed_at = NOW()
      WHERE id = ${messageId} AND status = 'pending'
    `;

    console.log(`[supervisor] Agent ${toAgent} completed message ${messageId} (${response.length} chars)`);
  } catch (err) {
    console.error(`[supervisor] Error processing message ${messageId}: ${err}`);
    // Mark message as failed but don't lose it
    await sql`
      UPDATE agent_messages SET status = 'done', processed_at = NOW()
      WHERE id = ${messageId}
    `.catch(() => {});
  } finally {
    activeAgents.delete(toAgent);

    // Process queued messages for this agent
    const queuedIdx = messageQueue.findIndex(m => m.toAgent === toAgent);
    if (queuedIdx >= 0) {
      const queued = messageQueue.splice(queuedIdx, 1)[0];
      processMessage(queued.toAgent, queued.messageId, queued.payload, queued.fromAgent).catch(console.error);
    }
  }
}

/**
 * Get the brain state file path for an agent.
 */
function getBrainStateFile(agentId: string): string | null {
  if (!agentId.startsWith('agent-')) return null;
  const brainId = agentId.replace('agent-', '');
  return join(BRAIN_STATES_DIR, `${brainId}.brain.md`);
}

// ── Polling ──

/**
 * Poll for unprocessed messages (backup for missed NOTIFY events).
 */
async function pollMessages(): Promise<void> {
  if (activeAgents.size >= MAX_CONCURRENT) return;

  // Only process 'task' messages TO entity agents (agent-*).
  // Skip: responses (delivered, not re-processed), notifications (informational),
  // messages to curator/supervisor (handled by their own loops),
  // messages to clawvato (CoS reads its own mailbox via MCP tools).
  const messages = await sql`
    SELECT id, from_agent, to_agent, message_type, payload
    FROM agent_messages
    WHERE status = 'pending'
      AND message_type = 'task'
      AND to_agent LIKE 'agent-%'
    ORDER BY created_at ASC
    LIMIT ${MAX_CONCURRENT - activeAgents.size}
  ` as unknown as Array<{
    id: string;
    from_agent: string;
    to_agent: string;
    message_type: string;
    payload: Record<string, unknown>;
  }>;

  for (const msg of messages) {
    if (activeAgents.has(msg.to_agent)) continue;
    processMessage(msg.to_agent, msg.id, msg.payload, msg.from_agent).catch(console.error);
  }
}

// ── Main ──

async function start(): Promise<void> {
  console.log('[supervisor] Agent supervisor starting');
  console.log(`[supervisor] MCP config: ${MCP_CONFIG}`);
  console.log(`[supervisor] Entity prompt: ${ENTITY_PROMPT}`);
  console.log(`[supervisor] Brain states dir: ${BRAIN_STATES_DIR}`);
  console.log(`[supervisor] Poll interval: ${POLL_INTERVAL_MS}ms`);
  console.log(`[supervisor] Max concurrent: ${MAX_CONCURRENT}`);

  // Ensure mailbox tables exist
  await sql`
    CREATE TABLE IF NOT EXISTS agent_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      message_type TEXT DEFAULT 'task',
      payload JSONB NOT NULL,
      status TEXT DEFAULT 'pending',
      parent_id UUID,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      processed_at TIMESTAMPTZ
    )
  `;

  // Listen for real-time notifications
  await sql.listen('agent_mail', async (payload: string) => {
    const [toAgent, messageId] = payload.split(':');
    if (!toAgent || !messageId) return;

    // Only route task messages to entity agents (agent-*)
    // Skip: curator, supervisor, clawvato (they read their own mailboxes)
    // Skip: responses, notifications (not actionable by supervisor)
    if (!toAgent.startsWith('agent-')) return;

    // Fetch full message — only tasks
    const [msg] = await sql`
      SELECT id, from_agent, to_agent, message_type, payload
      FROM agent_messages WHERE id = ${messageId} AND status = 'pending' AND message_type = 'task'
    ` as unknown as Array<{
      id: string;
      from_agent: string;
      to_agent: string;
      message_type: string;
      payload: Record<string, unknown>;
    }>;

    if (!msg) return;

    if (activeAgents.size < MAX_CONCURRENT) {
      processMessage(msg.to_agent, msg.id, msg.payload, msg.from_agent).catch(console.error);
    } else {
      messageQueue.push({
        toAgent: msg.to_agent,
        messageId: msg.id,
        payload: msg.payload,
        fromAgent: msg.from_agent,
      });
    }
  });

  console.log('[supervisor] Listening for agent_mail NOTIFY events');

  // Fallback polling
  setInterval(() => pollMessages().catch(console.error), POLL_INTERVAL_MS);

  // Initial poll to catch any messages that arrived before we started
  await pollMessages();

  console.log('[supervisor] Agent supervisor ready');
}

// ── Lifecycle ──

const shutdown = async () => {
  console.log('[supervisor] Shutting down...');
  await sql.end();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start().catch(err => {
  console.error(`[supervisor] Fatal: ${err}`);
  process.exit(1);
});
