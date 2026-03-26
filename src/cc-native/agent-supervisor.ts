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

// ── Agent Execution ──

/**
 * Invoke a CC agent via --print --session.
 * Returns the agent's response text.
 */
async function invokeAgent(
  sessionName: string,
  prompt: string,
  model = 'claude-opus-4-6',
): Promise<string> {
  const args = [
    '--print',
    '--session', sessionName,
    '--model', model,
    '--dangerously-skip-permissions',
    '--max-turns', '30',
  ];

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
      env: {
        ...process.env,
        HOME: process.env.HOME ?? '/home/clawvato',
      },
    });

    if (stderr) {
      console.error(`[supervisor] Agent ${sessionName} stderr: ${stderr.slice(0, 200)}`);
    }

    return stdout.trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[supervisor] Agent ${sessionName} failed: ${msg}`);
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

    // Send response back via mailbox
    await sql`
      UPDATE agent_messages SET status = 'done', processed_at = NOW()
      WHERE id = ${messageId}
    `;

    await sql`
      INSERT INTO agent_messages (from_agent, to_agent, message_type, payload, parent_id)
      VALUES (${toAgent}, ${fromAgent}, 'response', ${sql.json({ result: response })}, ${messageId})
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

  const messages = await sql`
    SELECT id, from_agent, to_agent, message_type, payload
    FROM agent_messages
    WHERE status = 'pending'
      AND to_agent != 'curator'
      AND to_agent != 'supervisor'
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

    // Skip curator and supervisor messages (handled by their own loops)
    if (toAgent === 'curator' || toAgent === 'supervisor') return;

    // Fetch full message
    const [msg] = await sql`
      SELECT id, from_agent, to_agent, message_type, payload
      FROM agent_messages WHERE id = ${messageId} AND status = 'pending'
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
