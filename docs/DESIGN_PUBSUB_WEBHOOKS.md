# Design: Real-Time Gmail & Calendar via Google Pub/Sub

> Status: **Specced** | Sprint: S26 | Depends on: S25 (sidecar rebuild) ✅

## Problem

Sweeps poll Gmail every 24 hours and Calendar not at all. Emails and calendar events are high-value, time-sensitive data. A client email about a meeting tomorrow shouldn't wait 24 hours to reach the brain.

## Solution

Google Pub/Sub push notifications for Gmail. Built-in `events.watch()` for Calendar. Both push to the sidecar's HTTP server, which fetches full content and sends to the plugin `/ingest` endpoint. Sweeps remain as a daily backfill safety net.

## Architecture

```
Gmail:
  New email arrives
    → Google Pub/Sub pushes notification to sidecar /webhooks/gmail
    → Sidecar decodes notification, extracts historyId
    → Sidecar calls gmail.users.history.list(startHistoryId)
    → Fetches full message content via gmail.users.messages.get()
    → Formats as markdown (Subject, From, Body snippet)
    → POST to plugin /ingest (source: "gmail:webhook")
    → Sonnet extracts facts → 3-tier dedup → stored
    → Updates historyId in agent_state

Calendar:
  Event created/modified/deleted
    → Google Calendar push notification to sidecar /webhooks/calendar
    → Sidecar calls calendar.events.list(syncToken)
    → Gets changed events since last sync
    → Formats: title, time, attendees, location, description
    → POST to plugin /ingest (source: "calendar:webhook")
    → Updates syncToken in agent_state
```

## Deployment

The sidecar becomes its own Railway service (separate from the CC supervisor). This gives it a public URL for receiving webhooks while keeping sweeps + task polling running independently of CC session state.

**Why separate service:**
- CC supervisor restarts shouldn't kill webhook processing
- Sidecar needs a stable public URL (Railway auto-assigns)
- Zero additional cost (same Railway plan)
- Clean separation of concerns

## GCP Setup (One-Time)

### Gmail Pub/Sub

1. Create Pub/Sub topic: `projects/YOUR_PROJECT/topics/clawvato-gmail`
2. Create push subscription: `https://SIDECAR_URL/webhooks/gmail?token=WEBHOOK_SECRET`
3. Grant `gmail-api-push@system.gserviceaccount.com` publish permission on topic
4. Set env var: `GMAIL_PUBSUB_TOPIC=projects/YOUR_PROJECT/topics/clawvato-gmail`

### Calendar (No Pub/Sub Needed)

Calendar API has built-in push notifications via `events.watch()`. Just needs the sidecar's public URL — no GCP topic or subscription required.

## State Variables

All stored in `agent_state` table (same pattern as sweep high-water marks):

| Key | Purpose |
|-----|---------|
| `webhook:gmail:historyId` | Last processed Gmail history ID |
| `webhook:gmail:watchExpiry` | ISO timestamp when watch() expires |
| `webhook:calendar:syncToken` | Calendar incremental sync token |
| `webhook:calendar:channelId` | Calendar watch channel ID |
| `webhook:calendar:resourceId` | Calendar watch resource ID |
| `webhook:calendar:watchExpiry` | ISO timestamp when channel expires |

## Watch Renewal

- **Gmail**: `users.watch()` expires after 7 days. Sidecar re-registers every 6 days via `setInterval`. Also re-registers on startup.
- **Calendar**: `events.watch()` channel expires after ~30 days. Sidecar renews every 25 days. Also re-registers on startup.

## Safety Net

Sweeps remain as daily backfill. If webhooks fail (watch expires, Pub/Sub breaks, sidecar down), the daily sweep catches everything. Plugin dedup ensures no duplicates when both webhook and sweep process the same content.

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Sidecar restarts | Re-register watch() on startup. history.list() from stored historyId catches missed notifications. |
| Duplicate Pub/Sub delivery | HistoryId is idempotent. Plugin dedup prevents duplicate storage. |
| Watch expires without renewal | Notifications stop. Daily backfill catches everything. Next restart re-registers. |
| Gmail notification for sent mail | Filter by labelIds — only process INBOX. Same noise filters as sweep collector. |
| Burst of notifications | Each triggers history fetch from advancing historyId. No duplication. |
| Plugin /ingest down | Log error, skip. Daily sweep backfill catches it. |
| OAuth token revoked | API calls fail 401. Log error, post to task channel. |
| Large email with attachments | Extract text content + metadata only. Skip binary. Same as sweep. |

## Environment Variables

| Variable | Where | Purpose |
|----------|-------|---------|
| `GMAIL_PUBSUB_TOPIC` | Sidecar | Full Pub/Sub topic name |
| `WEBHOOK_SECRET` | Sidecar | Pub/Sub verification token |
| `PORT` | Sidecar | HTTP server port (Railway auto-sets) |
| Google OAuth vars | Sidecar | Existing — client_id, client_secret, refresh_token |
| `CLAWVATO_MEMORY_URL` | Sidecar | Existing — plugin URL |
| `MCP_AUTH_TOKEN` | Sidecar | Existing — plugin auth |

## Cost

| Component | Monthly |
|-----------|---------|
| Google Pub/Sub | $0 (free tier: 10GB/month, we use ~1MB) |
| Sonnet extraction | ~$15 (50 emails/day × $0.01) |
| Railway service | ~$5 (idle 99% of time) |
| **Total** | **~$20/month** |

## Build Sequence

**Phase A: Gmail Webhook**
1. Add HTTP server to sidecar (native `http.createServer`)
2. Add `POST /webhooks/gmail` handler
3. Implement `handleGmailWebhook()`: decode → fetch history → fetch messages → /ingest
4. Add `registerGmailWatch()` on startup + 6-day renewal timer
5. Deploy sidecar as separate Railway service
6. Create GCP Pub/Sub topic + push subscription
7. Test: send email → verify memory created within 30s

**Phase B: Calendar Webhook**
1. Add `POST /webhooks/calendar` handler
2. Implement `handleCalendarWebhook()`: sync token → fetch events → /ingest
3. Add `registerCalendarWatch()` on startup + 25-day renewal
4. Test: create calendar event → verify memory created

**Phase C: Optimize Sweeps**
1. Move Gmail from daily backfill to weekly safety net
2. Calendar sweep becomes unnecessary (webhook covers it)

## Dependencies

- S25 sidecar rebuild ✅ (tiered sweeps, in-process collectors)
- `googleapis` npm package ✅ (already in dependencies)
- Google OAuth refresh token ✅ (already configured on Railway)
- GCP project with Pub/Sub API enabled (new — one-time setup)

## Files to Modify

| File | Change |
|------|--------|
| `src/cc-native/task-scheduler-standalone.ts` | Add HTTP server, webhook handlers, watch registration/renewal |
| `src/google/auth.ts` | Export for sidecar use (may need env var fallback) |
| `config/default.json` | Add `webhooks` config section |
| `src/config.ts` | Add webhooks Zod schema |
| `CLAUDE.md` | Document webhook architecture |

## Visual Spec

Full interactive spec with Mermaid diagrams: `~/.agent/diagrams/pubsub-webhook-spec.html`
