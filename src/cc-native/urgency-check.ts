// Clawvato v4 — Urgency Check
// Lightweight, zero LLM tokens. Polls Gmail + Slack for urgent signals between crawls.
// Posts to owner's Slack DM if anything hot is detected.

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const log = (msg: string) => process.stderr.write(`[urgency-check] ${msg}\n`);

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN ?? '';
const OWNER_SLACK_USER_ID = process.env.OWNER_SLACK_USER_ID ?? '';

async function postToOwner(text: string): Promise<void> {
  if (!SLACK_BOT_TOKEN || !OWNER_SLACK_USER_ID) return;
  try {
    // Open DM channel with owner
    const openRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ users: OWNER_SLACK_USER_ID }),
    });
    const openData = await openRes.json() as any;
    const dmChannel = openData?.channel?.id;
    if (!dmChannel) return;

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: dmChannel, text }),
    });
  } catch (e) {
    log(`Failed to DM owner: ${e}`);
  }
}

export async function runUrgencyCheck(opts: {
  lastCrawlTime: Date;
  keywords: string[];
}): Promise<void> {
  const keywordsLower = opts.keywords.map(k => k.toLowerCase());

  // Gmail urgency check — disabled until we have a direct Gmail API solution.
  // The gws CLI binary requires GLIBC 2.39 which Railway's container doesn't have.
  // The master crawl agent uses gws via claude --print (which has its own gws binary),
  // but the urgency check runs directly in the Node sidecar.
  // TODO: Implement via Google OAuth + fetch to Gmail API directly.

  // Slack: check for new DMs or mentions since last crawl
  // (Slack's native push via channel events handles most of this — this is a safety net)
}
