#!/usr/bin/env npx tsx
// Clawvato v3 — Workstream Scanner
// Runs as a standalone process in the clawvato container (has claude CLI + source APIs)
// Communicates with brain-platform via HTTP MCP calls

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const MEMORY_URL = process.env.CLAWVATO_MEMORY_INTERNAL_URL ?? 'http://brain-platform.railway.internal:8100/api/tool';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? '';
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const TASK_CHANNEL_ID = process.env.TASK_CHANNEL_ID ?? '';

const log = (msg: string) => process.stderr.write(`[v3-scanner] ${msg}\n`);

// Last scan times are persisted in brain-platform's cron_state table via MCP
// No more in-memory map that resets on every deploy

async function getLastScanTime(workstreamId: string): Promise<Date | null> {
  const result = await callMcp('get_last_scan', { workstream_id: workstreamId, job_type: 'commitment_scan' });
  return result === 'never' ? null : new Date(result);
}

async function setLastScanTime(workstreamId: string, time: Date): Promise<void> {
  await callMcp('set_last_scan', { workstream_id: workstreamId, job_type: 'commitment_scan', timestamp: time.toISOString() });
}

// Track which workstreams had new content since last brief cycle
const workstreamsWithChanges = new Set<string>();

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

interface ContentCheckResult {
  hasNew: boolean;
  sources: string[];           // which sources had new content
  gmailThreadIds: string[];    // specific new thread IDs to read
  slackChannels: string[];     // channels with new messages
}

async function checkForNewContent(workstreamId: string, scanWindow: string): Promise<ContentCheckResult> {
  const sources: string[] = [];
  const gmailThreadIds: string[] = [];
  const slackChannels: string[] = [];

  // 1. Check Gmail — find specific new threads for this workstream's domains
  try {
    const domainsText = await callMcp('get_workstream_domains', { workstream_id: workstreamId });
    if (domainsText !== 'No domains tracked.') {
      const domains = domainsText.split(', ').filter(Boolean);
      if (domains.length > 0) {
        const domainQuery = domains.map(d => `from:${d} OR to:${d}`).join(' OR ');
        const query = `(${domainQuery}) ${scanWindow}`;
        const { stdout } = await execFileAsync('gws', [
          'gmail', 'users', 'messages', 'list',
          '--params', JSON.stringify({ userId: 'me', q: query, maxResults: 50 }),
          '--format', 'json',
        ], { timeout: 15_000, env: process.env });

        const result = JSON.parse(stdout);
        if (Array.isArray(result.messages) && result.messages.length > 0) {
          // Dedupe by threadId — one entry per thread
          const threadSet = new Set<string>();
          for (const msg of result.messages) {
            if (msg.threadId) threadSet.add(msg.threadId);
          }
          gmailThreadIds.push(...threadSet);
          sources.push('gmail');
        }
      }
    }
  } catch { /* fail open */ }

  // 2. Check Slack — any new messages in workstream's channels?
  try {
    const artifactsText = await callMcp('get_artifacts', { workstream_id: workstreamId, type: 'slack_channel' });
    if (artifactsText !== 'No artifacts.') {
      // Extract channel IDs from artifact URLs (slack://C0XXXXX)
      const channelMatches = artifactsText.match(/slack:\/\/(\w+)/g);
      if (channelMatches) {
        for (const match of channelMatches) {
          const channelId = match.replace('slack://', '');
          try {
            const lastScan = await getLastScanTime(workstreamId).catch(() => null);
            if (!lastScan) continue; // No baseline yet — skip
            const oldest = String(lastScan.getTime() / 1000);

            const response = await fetch('https://slack.com/api/conversations.history', {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({ channel: channelId, oldest, limit: 1 }),
            });
            const data = await response.json() as { ok: boolean; messages?: unknown[] };
            if (data.ok && data.messages && data.messages.length > 0) {
              slackChannels.push(channelId);
              if (!sources.includes('slack')) sources.push('slack');
            }
          } catch { /* skip this channel */ }
        }
      }
    }
  } catch { /* fail open */ }

  // 3. Check Fireflies — any new transcripts with workstream's people?
  // TODO: lightweight Fireflies check (skip for now — less frequent than email/Slack)

  if (sources.length === 0) {
    log(`  ${workstreamId}: no new content on any channel, skipping`);
  } else {
    log(`  ${workstreamId}: new content on ${sources.join(', ')} (${gmailThreadIds.length} threads, ${slackChannels.length} channels)`);
  }

  return { hasNew: sources.length > 0, sources, gmailThreadIds, slackChannels };
}

async function scanWorkstream(workstreamId: string): Promise<void> {
  log(`Scanning ${workstreamId}...`);

  // Determine scan window based on last scan time (persisted in DB)
  let lastScan: Date | null = null;
  try {
    lastScan = await getLastScanTime(workstreamId);
  } catch {
    // get_last_scan tool may not be deployed yet — treat as first run
  }

  if (!lastScan) {
    // First run after deploy — seed the baseline so next cycle has a proper window
    // Don't scan 7 days of history, just mark "now" and let the next cycle catch new content
    log(`  ${workstreamId}: no scan history — seeding baseline, skipping this cycle`);
    await setLastScanTime(workstreamId, new Date()).catch(() => {});
    return;
  }

  const scanWindow = `after:${lastScan.toISOString().split('T')[0]}`;

  // Lightweight check — skip expensive LLM call if no new content on any channel
  const contentCheck = await checkForNewContent(workstreamId, scanWindow);
  if (!contentCheck.hasNew) return;

  const activeSources = contentCheck.sources;
  const { gmailThreadIds, slackChannels: activeSlackChannels } = contentCheck;

  // Get full context via MCP
  const contextText = await callMcp('get_workstream_context', { workstream_id: workstreamId });
  if (contextText.includes('not found')) {
    log(`  Workstream ${workstreamId} not found, skipping`);
    return;
  }

  const prompt = `You are scanning for updates related to a business workstream.
Scan window: ${lastScan ? `since ${lastScan.toISOString()}` : 'last 7 days (initial scan)'}

${GLOBAL_DEFINITIONS}

${contextText}

INSTRUCTIONS:
You have Bash access. New content was detected on: ${activeSources.join(', ')}.
ONLY search the sources listed above — skip sources with no new content.

${activeSources.includes('gmail') ? `GMAIL: ${gmailThreadIds.length} new thread(s) detected. Read ONLY these specific threads:
${gmailThreadIds.map(id => `  gws gmail users threads get --params '{"userId":"me","id":"${id}","format":"full"}' --format json`).join('\n')}
Do NOT search for additional threads — only read the ones listed above.` : '(Gmail: no new content — skip)'}
  Read thread:   gws gmail users threads get --params '{"userId":"me","id":"THREAD_ID","format":"full"}' --format json
  Use the people, domains, entity names, and shorthand above to craft your queries.
  Cast a wide net — check by domain, by person, by entity name.
  Read full threads for anything you find.

  IMPORTANT: Sent mail reveals:
  - Commitments YOU made ("I'll send that by Friday")
  - Follow-ups YOU completed (replied to someone → mark inbound follow-up done)
  - Todo status changes (you sent the doc → todo is done)

${activeSources.includes('slack') ? `SLACK: New messages in ${activeSlackChannels.length} channel(s): ${activeSlackChannels.join(', ')}. Read recent history from ONLY these channels.` : '(Slack: no new content — skip)'}

${activeSources.includes('fireflies') ? 'FIREFLIES: New transcripts detected. Use: npx tsx tools/fireflies.ts search "QUERY"' : '(Fireflies: no new content — skip)'}

4. IMPORTANT — TEMPORAL RECONCILIATION:
   You are reading emails, Slack messages, and meeting transcripts that may span days.
   Information evolves over time. A meeting on Monday may set a deadline, an email on
   Tuesday may change it, and a Slack message on Wednesday may confirm the change.

   ALWAYS use the MOST RECENT information as the source of truth. When you find
   conflicting information across sources, check the timestamps and use the latest.
   The final state is what matters — not intermediate states.

5. For everything you find:
   a. BEFORE creating any new item, check the OPEN ITEMS list above carefully.
      - If an identical or near-identical item already exists in the same state → DO NOT create a duplicate. Skip it entirely.
      - If something has changed, progressed, or new evidence exists for an existing item → propose an ALTERATION (not a new item). E.g., a due date changed, the item was completed, new context emerged.
      - If a meeting set a deadline but a later email changed it → the item should reflect the EMAIL's date, not the meeting's.
   b. Only create genuinely NEW todos, commitments, and follow-ups that don't already exist in any form.
   c. For existing items with new evidence, propose alterations:
      Alterations: "complete" (done), "cancel" (no longer relevant), "update" (change title/priority/date)
      Include the existing item's ID and cite specific evidence with timestamps.
   d. Extract new people: name, entity_id (if they belong to a known entity), role, email.
   e. Note anything that changes the state of play for the brief.

6. For each item, specify which workstream it belongs to.

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
    const scanStart = new Date();
    const result = await invokeClaude(prompt, workstreamId);
    await processResults(workstreamId, result);
    await setLastScanTime(workstreamId, scanStart);
    workstreamsWithChanges.add(workstreamId); // Flag for brief update
  } catch (err) {
    log(`  Error scanning ${workstreamId}: ${err}`);
    // Don't update lastScanTime on failure — retry same window next cycle
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

- Search Gmail (BOTH inbox and sent), Slack, and Fireflies for recent activity
- When multiple sources discuss the same topic, use the MOST RECENT timestamp as truth
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

// Running totals for session-level monitoring
let sessionTotalCost = 0;
let sessionTotalInputTokens = 0;
let sessionTotalOutputTokens = 0;
let sessionInvocations = 0;

async function invokeClaude(prompt: string, label: string): Promise<string> {
  log(`  Invoking claude --print for ${label}...`);
  const startTime = Date.now();

  const { stdout } = await execFileAsync('claude', [
    '--print',
    '--model', 'opus',
    '--output-format', 'json',
    '--allowedTools', 'Bash,Read,Grep,Glob,WebSearch',
    '--dangerously-skip-permissions',
    '-p', prompt,
  ], {
    timeout: 300_000, // 5 min
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      // Strip API key so claude CLI uses OAuth/Max plan ($0) instead of API billing
      ANTHROPIC_API_KEY: '',
      // Prevent MCP config inheritance — scanner uses Bash tools (gws CLI, etc.)
      // not the CoS's Slack channel MCP
      CLAUDE_MCP_CONFIG: '',
    },
  });

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  // Parse JSON envelope for token usage + result text
  try {
    const envelope = JSON.parse(stdout);
    const cost = envelope.total_cost_usd ?? 0;
    const input = (envelope.usage?.input_tokens ?? 0) +
                  (envelope.usage?.cache_creation_input_tokens ?? 0) +
                  (envelope.usage?.cache_read_input_tokens ?? 0);
    const output = envelope.usage?.output_tokens ?? 0;
    const turns = envelope.num_turns ?? 0;

    sessionTotalCost += cost;
    sessionTotalInputTokens += input;
    sessionTotalOutputTokens += output;
    sessionInvocations++;

    log(`  ${label} completed in ${elapsed}s | $${cost.toFixed(4)} | ${input} in / ${output} out | ${turns} turns`);
    log(`  Session totals: $${sessionTotalCost.toFixed(4)} | ${sessionInvocations} calls | ${sessionTotalInputTokens} in / ${sessionTotalOutputTokens} out`);

    // Post to monitoring channel
    const MONITOR_CHANNEL = 'C0APG26FLRJ';
    await postToSlack(MONITOR_CHANNEL,
      `\`${label}\` — ${elapsed}s | $${cost.toFixed(4)} | ${input} in / ${output} out | session: $${sessionTotalCost.toFixed(4)} (${sessionInvocations} calls)`
    ).catch(() => {}); // fire-and-forget

    return envelope.result ?? '';
  } catch {
    // Fallback if JSON parsing fails — return raw stdout
    log(`  ${label} completed in ${elapsed}s (${stdout.length} chars, failed to parse usage)`);
    return stdout;
  }
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

const COMMITMENT_INTERVAL_MS = 5 * 60 * 1000;    // 5 minutes — lightweight check skips if no new content
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
    // Only run catchall if at least one workstream had new content this cycle
    // (if sources are active, there may be untracked activity too)
    if (workstreamsWithChanges.size > 0) {
      await scanCatchall();
    } else {
      log('Catchall: skipping — no new content on any workstream this cycle');
    }

    log('Commitment cycle complete');
  } catch (err) {
    log(`Commitment cycle error: ${err}`);
  }
}

async function runBriefCycle(): Promise<void> {
  try {
    if (workstreamsWithChanges.size === 0) {
      log('Brief cycle: no workstreams with changes, skipping');
      return;
    }

    const toUpdate = [...workstreamsWithChanges];
    workstreamsWithChanges.clear();

    log(`Brief cycle: updating ${toUpdate.length} workstreams with changes...`);

    for (const wsId of toUpdate) {
      await updateBrief(wsId);
    }

    log('Brief cycle complete');
  } catch (err) {
    log(`Brief cycle error: ${err}`);
  }
}

// ── Scheduled Task Executor ───────────────────────────────

const TASK_POLL_INTERVAL_MS = 60 * 1000; // Check every 60s for due tasks

async function runScheduledTasks(): Promise<void> {
  try {
    // Get due tasks from brain-platform
    const dueText = await callMcp('list_scheduled_tasks', { status: 'active' });
    if (dueText === 'No scheduled tasks.') return;

    // Parse tasks — look for ones where next_run is in the past
    const now = new Date();
    const lines = dueText.split('\n').filter((l: string) => l.startsWith('- [active]'));

    for (const line of lines) {
      // Extract next run time and ID
      const nextMatch = line.match(/next: (\S+)/);
      const idMatch = line.match(/\(([0-9a-f-]{36})\)/);
      const titleMatch = line.match(/\*\*(.+?)\*\*/);

      if (!nextMatch || !idMatch || !titleMatch) continue;

      const nextRun = new Date(nextMatch[1]);
      const taskId = idMatch[1];
      const title = titleMatch[1];

      if (nextRun > now) continue; // Not due yet

      log(`Executing scheduled task: ${title} (${taskId})`);

      // Extract instruction — we need to fetch it via a separate call
      // For now, use the title as the instruction hint
      // TODO: add get_scheduled_task(id) MCP tool for full details
      try {
        const result = await invokeClaude(
          `You are executing a scheduled task: "${title}". ` +
          `You have access to the brain-platform MCP tools via Bash and gws CLI for email. ` +
          `Complete the task and return a ONE-LINE summary of what happened or what you found. ` +
          `If the task involves checking todos, use: curl -s -X POST "http://brain-platform.railway.internal:8100/api/tool" ` +
          `-H "Authorization: Bearer ${AUTH_TOKEN}" -H "Content-Type: application/json" ` +
          `-d '{"params":{"name":"get_todos","arguments":{"status":"open"}}}'`,
          `task-${taskId.slice(0, 8)}`
        );

        const oneLiner = result.trim().split('\n')[0].slice(0, 200);
        await postToSlack(TASK_CHANNEL_ID, `📋 *${title}*: ${oneLiner}`);

        // Parse schedule to compute next_run for recurring tasks
        const scheduleMatch = line.match(/cron: ([^)]+)/);
        const isRecurring = scheduleMatch != null;

        if (isRecurring) {
          // Compute next run from cron expression
          const nextRunAt = computeNextCron(scheduleMatch![1], now);
          // Update via direct API call — markTaskRun needs an MCP tool
          // For now just log it; the task stays active and will re-run
          log(`  Recurring task "${title}" — next run: ${nextRunAt.toISOString()}`);
        }

        // Mark as run — for one-off tasks this completes them
        // TODO: add mark_task_run MCP tool
        if (!scheduleMatch) {
          await callMcp('cancel_scheduled_task', { id: taskId }); // one-off → done
        }

        log(`  Task "${title}" completed: ${oneLiner}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        await postToSlack(TASK_CHANNEL_ID, `⚠️ *${title}*: Error — ${errMsg.slice(0, 100)}`);
        log(`  Task "${title}" failed: ${errMsg}`);
      }
    }
  } catch (err) {
    // Silently skip if brain-platform is unavailable
  }
}

// Simple cron next-run calculator (handles basic patterns)
function computeNextCron(expr: string, from: Date): Date {
  const parts = expr.split(' ');
  if (parts.length !== 5) return new Date(from.getTime() + 86400000); // fallback: +1 day

  const [min, hour, dayOfMonth, month, dayOfWeek] = parts;
  const next = new Date(from);

  // Simple case: daily at specific time (e.g., "0 8 * * *")
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    next.setUTCHours(parseInt(hour), parseInt(min), 0, 0);
    if (next <= from) next.setDate(next.getDate() + 1);
    return next;
  }

  // Weekly on specific day (e.g., "0 8 * * 1" = Monday 8am)
  if (dayOfMonth === '*' && month === '*' && dayOfWeek !== '*') {
    const targetDay = parseInt(dayOfWeek);
    next.setUTCHours(parseInt(hour), parseInt(min), 0, 0);
    while (next.getUTCDay() !== targetDay || next <= from) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  // Fallback: +1 day
  return new Date(from.getTime() + 86400000);
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

  // Start reaction poller for proposed alterations
  startReactionPoller();

  // Sequential loop — wait for each cycle to finish before scheduling the next
  // Prevents overlapping cycles that caused duplicate scans
  async function commitmentLoop(): Promise<void> {
    await new Promise(r => setTimeout(r, 30_000)); // initial delay
    while (true) {
      await runCommitmentCycle();
      await new Promise(r => setTimeout(r, COMMITMENT_INTERVAL_MS));
    }
  }

  async function briefLoop(): Promise<void> {
    await new Promise(r => setTimeout(r, BRIEF_INTERVAL_MS)); // first brief after 1h
    while (true) {
      await runBriefCycle();
      await new Promise(r => setTimeout(r, BRIEF_INTERVAL_MS));
    }
  }

  // Task polling is lightweight (no LLM) — setInterval is fine
  setInterval(() => runScheduledTasks(), TASK_POLL_INTERVAL_MS);

  // Start loops (non-blocking — they run forever)
  commitmentLoop().catch(err => log(`Commitment loop fatal: ${err}`));
  briefLoop().catch(err => log(`Brief loop fatal: ${err}`));

  log(`Scanner active: commitments every ${COMMITMENT_INTERVAL_MS / 60000}m (sequential), briefs every 1h, tasks every 60s`);

  // Keep process alive
  process.on('SIGTERM', () => { log('Shutting down...'); process.exit(0); });
  process.on('SIGINT', () => { log('Shutting down...'); process.exit(0); });
}

main().catch(err => {
  log(`Fatal: ${err}`);
  process.exit(1);
});
