#!/usr/bin/env npx tsx
// Clawvato v3 — Workstream Scanner
// Runs as a standalone process in the clawvato container (has claude CLI + source APIs)
// Communicates with brain-platform via HTTP MCP calls

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MEMORY_URL = process.env.CLAWVATO_MEMORY_INTERNAL_URL ?? 'http://brain-platform.railway.internal:8100/mcp';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const TASK_CHANNEL_ID = process.env.TASK_CHANNEL_ID ?? '';

const log = (msg: string) => process.stderr.write(`[v3-scanner] ${msg}\n`);

// ── MCP Client ────────────────────────────────────────────

async function callMcp(toolName: string, args: Record<string, unknown> = {}): Promise<string> {
  const response = await fetch(MEMORY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ params: { name: toolName, arguments: args } }),
  });

  if (!response.ok) {
    throw new Error(`MCP ${toolName} failed: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as { content?: { text: string }[]; error?: string };
  if (data.error) throw new Error(`MCP ${toolName} error: ${data.error}`);
  return data.content?.[0]?.text ?? '';
}

// ── Global Definitions ────────────────────────────────────

const GLOBAL_DEFINITIONS = `
## Item Type Definitions

**TODO**: An internal task that needs to be done. Something to build, write, send, create, prepare, review, or complete. No external party is waiting on this — it's your own work.
Examples: "Review the MOS strategy doc", "Complete the Aperiam voting", "Grant Phil access to the Google Doc"

**COMMITMENT**: A promise made to an external party. Someone OUTSIDE your team is counting on this being delivered. It's like a high-priority todo because there's an external stakeholder aware of the commitment and reputational weight if you miss it. Has a recipient (who you promised), a deliverable (what you promised), and ideally a deadline.
Examples: "Send API specs to Phil by March 28", "Confirm no additional MSA comments to Glenton", "Deliver scope doc to Jono by end of week"
NOT a commitment: Calendar events, scheduled meetings, recurring syncs. A meeting is just a meeting — unless you promised to bring/deliver something TO that meeting.

**FOLLOW_UP**: A communication that needs chasing — either you owe someone a response, or someone owes you one. Directional:
- OUTBOUND: You need to reply, reach out, or circle back. You're the bottleneck.
- INBOUND: They owe you a response. You're waiting.
Examples: "Haven't replied to Daisy about the RFP (outbound)", "Phil hasn't responded to scope doc (inbound)"
`;

// ── Commitment Scan ───────────────────────────────────────

async function scanWorkstream(workstreamId: string): Promise<void> {
  log(`Scanning ${workstreamId}...`);

  // Get full context via MCP
  const contextText = await callMcp('get_workstream_context', { workstream_id: workstreamId });
  if (contextText.includes('not found')) {
    log(`  Workstream ${workstreamId} not found, skipping`);
    return;
  }

  const prompt = `You are scanning for updates related to a business workstream.

${GLOBAL_DEFINITIONS}

${contextText}

INSTRUCTIONS:
You have Bash access. Use these tools to search sources:

GMAIL: Use gws CLI to search and read emails. Search BOTH inbox AND sent mail.
  Search inbox:  gws gmail users messages list --params '{"userId":"me","q":"QUERY newer_than:1d","maxResults":20}' --format json
  Search sent:   gws gmail users messages list --params '{"userId":"me","q":"in:sent QUERY newer_than:1d","maxResults":20}' --format json
  Read thread:   gws gmail users threads get --params '{"userId":"me","id":"THREAD_ID","format":"full"}' --format json
  Use the people, domains, entity names, and shorthand above to craft your queries.
  Cast a wide net — check by domain, by person, by entity name.
  Read full threads for anything you find.

  IMPORTANT: Sent mail reveals:
  - Commitments YOU made ("I'll send that by Friday")
  - Follow-ups YOU completed (replied to someone → mark inbound follow-up done)
  - Todo status changes (you sent the doc → todo is done)

SLACK: If Slack channels are listed in artifacts, search them.

FIREFLIES: Use the fireflies CLI if available:
  npx tsx tools/fireflies.ts search "QUERY"

4. For everything you find:
   a. Extract NEW todos, commitments, and follow-ups (use the type definitions above).
   b. Check EXISTING open items against new evidence. For each change, propose an alteration
      with a reason (what evidence you found). Do NOT silently complete items.
      Alterations: "complete" (done), "cancel" (no longer relevant), "update" (change title/priority/date)
   c. Extract new people: name, entity_id (if they belong to a known entity), role, email.
   d. Note anything that changes the state of play for the brief.

5. For each item, specify which workstream it belongs to.

Return ONLY valid JSON (no markdown fences) with this structure:
{
  "new_todos": [
    { "workstream_id": "${workstreamId}", "title": "...", "type": "todo|commitment|follow_up",
      "priority": 1-10, "due_date": "YYYY-MM-DD or null", "commitment_to": "name or null",
      "direction": "outbound|inbound|null", "source": "email|meeting|slack",
      "source_ref": "thread id or url or null" }
  ],
  "proposed_alterations": [
    { "todo_id": "existing-todo-uuid", "action": "complete|cancel|update",
      "reason": "Why — cite the specific evidence (email subject, date, sender)",
      "updates": {} }
  ],
  "new_people": [
    { "full_name": "...", "entity_id": "...", "role": "...", "email": "..." }
  ],
  "brief_updates": "Key changes for the next brief refresh, or empty string if nothing new"
}

If nothing new was found, return empty arrays and empty string.`;

  try {
    const result = await invokeClaude(prompt, workstreamId);
    await processResults(workstreamId, result);
  } catch (err) {
    log(`  Error scanning ${workstreamId}: ${err}`);
  }
}

// ── Brief Update ──────────────────────────────────────────

async function updateBrief(workstreamId: string, mode: 'update' | 'refresh' = 'update'): Promise<void> {
  log(`Updating brief for ${workstreamId} (mode: ${mode})...`);

  const contextText = await callMcp('get_workstream_context', { workstream_id: workstreamId });
  if (contextText.includes('not found')) return;

  const prompt = `You are ${mode === 'refresh' ? 'writing a fresh' : 'updating the'} state-of-the-state brief for a business workstream.

${contextText}

INSTRUCTIONS:
You have Bash access. Search sources using:
  Gmail (inbox): gws gmail users messages list --params '{"userId":"me","q":"QUERY newer_than:1d","maxResults":20}' --format json
  Gmail (sent):  gws gmail users messages list --params '{"userId":"me","q":"in:sent QUERY newer_than:1d","maxResults":20}' --format json
  Gmail thread:  gws gmail users threads get --params '{"userId":"me","id":"THREAD_ID","format":"full"}' --format json

- Search Gmail (BOTH inbox and sent), Slack, and Fireflies for recent activity related to this workstream
- Write 2-3 paragraphs summarizing the latest state of affairs
${mode === 'update' ? `- Maintain continuity from the current brief shown above — carry forward anything still relevant
- If something is no longer relevant, note it as [RESOLVED: brief description]
- If the current brief contained [RESOLVED: ...] items, drop them entirely` : '- This is a fresh rewrite — generate entirely from source data, ignore any existing brief'}
- Do NOT list todos/commitments (tracked separately) unless they affect state of play
- Focus on: state of play, key dynamics, open questions, blockers
- Adapt length to activity level — quiet workstream gets a short brief

Return ONLY the brief text. No JSON, no markdown fences, no preamble.`;

  try {
    const briefText = await invokeClaude(prompt, `brief-${workstreamId}`);
    if (briefText && briefText.trim().length > 20) {
      await callMcp('update_brief', { workstream_id: workstreamId, content: briefText.trim() });
      log(`  Brief updated for ${workstreamId} (${briefText.length} chars)`);
    }
  } catch (err) {
    log(`  Error updating brief for ${workstreamId}: ${err}`);
  }
}

// ── Catchall Scan ─────────────────────────────────────────

async function scanCatchall(): Promise<void> {
  log('Running catchall scan...');

  const workstreamList = await callMcp('list_workstreams', { status: 'active' });

  const prompt = `You have access to all the owner's email, Slack, and meeting sources.
The following workstreams are already being tracked:
${workstreamList}

Your job: find anything IMPORTANT that isn't covered by those workstreams.
Look for:
- Emails from unknown senders that seem business-relevant (not newsletters, not spam)
- Slack messages in channels not associated with any workstream
- Anything that looks like a commitment, deadline, or follow-up that doesn't clearly belong

For each item found, surface it with:
- A one-line summary
- Why it might be important
- A suggested workstream (existing or new) to route it to

Return plain text, one item per paragraph. If nothing found, return "Nothing new on the radar."`;

  try {
    const result = await invokeClaude(prompt, 'catchall');
    if (result && result.trim().length > 10) {
      await callMcp('update_brief', { workstream_id: '_catchall', content: result.trim() });
      log(`  Catchall brief updated (${result.length} chars)`);
    }
  } catch (err) {
    log(`  Catchall scan error: ${err}`);
  }
}

// ── Claude Invocation ─────────────────────────────────────

async function invokeClaude(prompt: string, label: string): Promise<string> {
  log(`  Invoking claude --print for ${label}...`);
  const startTime = Date.now();

  const { stdout } = await execFileAsync('claude', [
    '--print',
    '--model', 'sonnet',
    '--output-format', 'text',
    '--allowedTools', 'Bash,Read,Grep,Glob,WebSearch',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ], {
    timeout: 300_000, // 5 min
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      // Prevent MCP config inheritance — scanner uses Bash tools (gws CLI, etc.)
      // not the CoS's Slack channel MCP
      CLAUDE_MCP_CONFIG: '',
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`  ${label} completed in ${elapsed}s (${stdout.length} chars)`);
  return stdout;
}

// ── Slack Posting ─────────────────────────────────────────

async function postToSlack(channel: string, text: string, threadTs?: string): Promise<string | null> {
  if (!SLACK_BOT_TOKEN || !channel) {
    log('  Slack not configured — skipping post');
    return null;
  }

  try {
    const body: Record<string, string> = { channel, text };
    if (threadTs) body.thread_ts = threadTs;

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json() as { ok: boolean; ts?: string; error?: string };
    if (!data.ok) {
      log(`  Slack post failed: ${data.error}`);
      return null;
    }
    return data.ts ?? null;
  } catch (err) {
    log(`  Slack post error: ${err}`);
    return null;
  }
}

// ── Proposed Alterations (persisted in brain-platform DB) ──

async function postProposedAlteration(alteration: { todo_id: string; action: string; reason: string; updates?: Record<string, unknown> }): Promise<void> {
  // Create the alteration in the DB (supersedes any existing one for this todo)
  const result = await callMcp('propose_alteration', {
    todo_id: alteration.todo_id,
    action: alteration.action,
    reason: alteration.reason,
    updates: alteration.updates,
  });
  log(`  Proposed alteration: ${result}`);

  // Post to Slack for owner visibility
  const actionEmoji = alteration.action === 'complete' ? '✅' : alteration.action === 'cancel' ? '🚫' : '✏️';
  const actionLabel = alteration.action === 'complete' ? 'Mark done' : alteration.action === 'cancel' ? 'Cancel' : 'Update';

  const text = `${actionEmoji} *Proposed: ${actionLabel}*\n${alteration.reason}\n\n_React ✅ to accept, or reply in thread to propose something else._`;

  const ts = await postToSlack(TASK_CHANNEL_ID, text);
  if (ts) {
    log(`  Posted to Slack: ${alteration.action} ${alteration.todo_id.slice(0, 8)}`);
    // TODO: update the alteration record with slack_ts for reaction tracking
  }
}

// ── Reaction Listener ─────────────────────────────────────

let reactionPollerStarted = false;

function startReactionPoller(): void {
  if (reactionPollerStarted || !SLACK_BOT_TOKEN || !TASK_CHANNEL_ID) return;
  reactionPollerStarted = true;

  // Poll for reactions every 30s on pending alterations
  setInterval(async () => {
    const pendingText = await callMcp('get_pending_alterations', {});
    if (pendingText === 'No pending alterations.') return;

    // TODO: parse pending alterations, check their slack_ts for reactions
    // For now, alterations are accepted via CoS ("accept alteration X") or
    // the accept_alteration MCP tool. Slack reaction polling can be added
    // once the alteration records store slack_ts.

  }, 30_000);

  log('Reaction poller started (30s interval)');
}

// ── Result Processing ─────────────────────────────────────

async function processResults(workstreamId: string, rawResult: string): Promise<void> {
  let result: any;
  try {
    let jsonStr = rawResult.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    result = JSON.parse(jsonStr);
  } catch {
    log(`  Failed to parse JSON for ${workstreamId}. Raw: ${rawResult.slice(0, 200)}`);
    return;
  }

  let newTodos = 0, proposedAlts = 0, newPeople = 0;

  // New todos — these are added immediately (new discoveries)
  if (Array.isArray(result.new_todos)) {
    for (const item of result.new_todos) {
      try {
        await callMcp('create_todo', {
          workstream_id: item.workstream_id ?? workstreamId,
          title: item.title,
          type: item.type ?? 'todo',
          priority: item.priority ?? 5,
          due_date: item.due_date ?? undefined,
          commitment_to: item.commitment_to ?? undefined,
          direction: item.direction ?? undefined,
          source: item.source ?? 'agent',
          source_ref: item.source_ref ?? undefined,
        });
        newTodos++;
      } catch (err) {
        log(`  Failed to create todo: ${err}`);
      }
    }
  }

  // Proposed alterations — posted to Slack for confirmation, NOT applied immediately
  if (Array.isArray(result.proposed_alterations)) {
    for (const alt of result.proposed_alterations) {
      try {
        await postProposedAlteration(alt);
        proposedAlts++;
      } catch (err) {
        log(`  Failed to post alteration: ${err}`);
      }
    }
  }

  // New people — added immediately
  if (Array.isArray(result.new_people)) {
    for (const person of result.new_people) {
      try {
        await callMcp('add_person', {
          full_name: person.full_name,
          preferred_name: person.preferred_name ?? undefined,
          entity_id: person.entity_id ?? undefined,
          role: person.role ?? undefined,
          email: person.email ?? undefined,
        });
        newPeople++;
      } catch {
        // Likely duplicate — ok
      }
    }
  }

  log(`  ${workstreamId}: +${newTodos} todos, ${proposedAlts} proposed alterations, +${newPeople} people`);
}

// ── Main Cron Loop ────────────────────────────────────────

const COMMITMENT_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes
const BRIEF_INTERVAL_MS = 60 * 60 * 1000;        // 1 hour

async function getActiveWorkstreams(): Promise<string[]> {
  const text = await callMcp('list_workstreams', { status: 'active' });
  // Parse workstream IDs from the formatted list: "- **Name** (id) — type, status"
  const ids: string[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/\(([^)]+)\) — /);
    if (match && match[1] !== '_catchall') ids.push(match[1]);
  }
  return ids;
}

async function runCommitmentCycle(): Promise<void> {
  try {
    const workstreams = await getActiveWorkstreams();
    log(`Commitment cycle: scanning ${workstreams.length} workstreams...`);

    for (const wsId of workstreams) {
      await scanWorkstream(wsId);
    }
    await scanCatchall();

    log('Commitment cycle complete');
  } catch (err) {
    log(`Commitment cycle error: ${err}`);
  }
}

async function runBriefCycle(): Promise<void> {
  try {
    const workstreams = await getActiveWorkstreams();
    log(`Brief cycle: updating ${workstreams.length} workstreams...`);

    for (const wsId of workstreams) {
      await updateBrief(wsId);
    }

    log('Brief cycle complete');
  } catch (err) {
    log(`Brief cycle error: ${err}`);
  }
}

// ── Entry Point ───────────────────────────────────────────

async function main(): Promise<void> {
  log('v3 Scanner starting...');
  log(`Memory URL: ${MEMORY_URL}`);

  // Verify MCP connection
  try {
    const health = await callMcp('list_workstreams', { status: 'active' });
    log(`Connected to brain-platform. Active workstreams: ${health.split('\n').length}`);
  } catch (err) {
    log(`Failed to connect to brain-platform: ${err}`);
    log('Scanner will retry on next cycle.');
  }

  // Run initial commitment scan after 30s delay
  setTimeout(() => runCommitmentCycle(), 30_000);

  // Schedule recurring scans
  setInterval(() => runCommitmentCycle(), COMMITMENT_INTERVAL_MS);
  setInterval(() => runBriefCycle(), BRIEF_INTERVAL_MS);

  log(`Scanner active: commitments every 5m, briefs every 1h`);

  // Keep process alive
  process.on('SIGTERM', () => { log('Shutting down...'); process.exit(0); });
  process.on('SIGINT', () => { log('Shutting down...'); process.exit(0); });
}

main().catch(err => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
