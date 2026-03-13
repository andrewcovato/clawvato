/**
 * Start the Clawvato agent process.
 *
 * This is the full bootstrap that:
 * 1. Validates required credentials (Anthropic, Slack)
 * 2. Verifies database connectivity
 * 3. Connects to Slack via Socket Mode
 * 4. Creates the Agent SDK orchestrator
 * 5. Wires handler.onBatch → agent.processBatch
 * 6. Crawls for missed messages (stateless — no file state needed)
 * 7. Handles graceful shutdown
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { getDb, closeDb } from '../db/index.js';
import { hasCredential, requireCredential } from '../credentials.js';
import { createSlackConnection } from '../slack/socket-mode.js';
import { createAgent } from '../agent/index.js';
import type { WebClient } from '@slack/web-api';
import type { SlackHandler } from '../slack/handler.js';

export async function startAgent(): Promise<void> {
  const config = getConfig();

  logger.info({ dataDir: config.dataDir, trustLevel: config.trustLevel }, 'Starting Clawvato agent');

  // ── Verify database ──
  const db = getDb();
  const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as
    | { version: number }
    | undefined;
  logger.info({ schemaVersion: version?.version ?? 0 }, 'Database connected');

  // ── Verify required credentials ──
  const missingCreds: string[] = [];
  if (!await hasCredential('anthropic-api-key')) missingCreds.push('anthropic-api-key');
  if (!await hasCredential('slack-bot-token')) missingCreds.push('slack-bot-token');
  if (!await hasCredential('slack-app-token')) missingCreds.push('slack-app-token');

  if (missingCreds.length > 0) {
    logger.error(
      { missing: missingCreds },
      'Missing required credentials. Run: clawvato setup',
    );
    console.error(`\nMissing credentials: ${missingCreds.join(', ')}`);
    console.error('Run `clawvato setup` to configure all required credentials.\n');
    process.exit(1);
  }

  // ── Verify owner config ──
  if (!config.ownerSlackUserId) {
    logger.warn('No ownerSlackUserId configured — agent will not verify senders');
    logger.warn('Set with: clawvato config set ownerSlackUserId YOUR_SLACK_USER_ID');
  }

  // ── Log startup summary ──
  const trustLabels = ['FULL SUPERVISION', 'TRUSTED READS', 'TRUSTED ROUTINE', 'FULL AUTONOMY'];
  logger.info({
    trustLevel: `${config.trustLevel} (${trustLabels[config.trustLevel]})`,
    model: config.models.executor,
  }, 'Agent configuration loaded');

  // ── Connect to Slack via Socket Mode ──
  const botToken = await requireCredential('slack-bot-token');
  const appToken = await requireCredential('slack-app-token');
  let userToken: string | undefined;
  try {
    userToken = (await hasCredential('slack-user-token'))
      ? await requireCredential('slack-user-token')
      : undefined;
  } catch {
    // User token is optional — search will be limited
  }

  const slack = await createSlackConnection({ appToken, botToken, userToken });

  // ── Create the Agent ──
  const agent = await createAgent({
    botClient: slack.botClient,
    userClient: slack.userClient,
  });

  // ── Wire batch processing ──
  slack.handler.onBatch(async (batch) => {
    await agent.processBatch(batch, slack.handler);
  });

  // ── Graceful shutdown ──
  const shutdown = async () => {
    logger.info('Shutting down...');
    await agent.shutdown();
    await slack.stop();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // ── Start Socket Mode connection ──
  await slack.start();

  logger.info('Clawvato agent is running. Listening to all joined channels.');
  logger.info('Press Ctrl+C to stop.');

  // ── Crawl for missed messages (stateless, non-blocking) ──
  const apiKey = await requireCredential('anthropic-api-key');
  crawlMissedMessages(slack.botClient, apiKey, config.models.classifier, slack.handler, config.ownerSlackUserId)
    .then(() => logger.info('CRAWL: complete'))
    .catch((error) => logger.warn({ error }, 'CRAWL: failed'));

  // Socket Mode keeps the process alive via the WebSocket connection
}

/**
 * Discover all channels the bot is a member of.
 * Fetches each type separately — Slack's API drops private channels
 * when types are combined in a single conversations.list call.
 */
async function getJoinedChannels(botClient: WebClient): Promise<Array<{ id: string; name: string }>> {
  const channelTypes = ['public_channel', 'private_channel', 'im', 'mpim'] as const;
  const joined: Array<{ id: string; name: string }> = [];

  for (const type of channelTypes) {
    try {
      const result = await botClient.conversations.list({
        types: type,
        exclude_archived: true,
        limit: 200,
      });
      for (const ch of (result.channels ?? [])) {
        if (!ch.id || !ch.is_member) continue;
        if (ch.is_im || ch.is_mpim) continue; // Skip DMs
        joined.push({ id: ch.id, name: ch.name ?? ch.id });
      }
    } catch {
      logger.debug({ type }, 'conversations.list failed for type — skipping');
    }
  }

  return joined;
}

/** Lookback window — how far back to check for missed messages */
const LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

const CATCHUP_TRIAGE_PROMPT = `You are triaging Slack messages for an AI assistant (Clawvato) that was offline. You see the full conversation — messages the bot already responded to AND messages marked with ">>> UNRESPONDED" that the bot missed.

Use the full conversation for context, but only triage the UNRESPONDED messages. Determine which (if any) were directed at the assistant or need attention.

Respond with a JSON object:
{
  "relevant_count": <number of UNRESPONDED messages directed at or needing the assistant>,
  "summary": "<brief summary of what was asked/needed, or null if nothing relevant>",
  "single_task": "<if exactly 1 relevant message, describe the task concisely, otherwise null>"
}

RESPOND-worthy:
- @mentions of the bot
- Requests for the assistant to do something
- Questions the assistant would typically answer
- Follow-ups to a conversation the assistant was part of

IGNORE-worthy:
- People talking to each other
- General announcements, social chatter
- Messages that don't need the assistant`;

/**
 * Stateless startup crawl — no file state needed.
 *
 * For each joined channel:
 * 1. Fetch last 24h of history
 * 2. Identify human messages the bot did NOT respond to
 * 3. Run unresponded messages through Haiku for relevance
 * 4. Announce contextually if anything was directed at the bot
 */
async function crawlMissedMessages(
  botClient: WebClient,
  apiKey: string,
  classifierModel: string,
  handler: SlackHandler,
  ownerUserId?: string,
): Promise<void> {
  const anthropic = new Anthropic({ apiKey });

  // Get the bot's own user ID so we can identify our own messages in history
  let botUserId: string | undefined;
  try {
    const auth = await botClient.auth.test();
    botUserId = auth.user_id as string | undefined;
    logger.info({ botUserId }, 'CRAWL: bot identity resolved');
  } catch {
    logger.warn('Could not determine bot user ID — response detection will use bot_id only');
  }

  try {
    const channels = await getJoinedChannels(botClient);
    logger.info({ channelCount: channels.length }, 'CRAWL: starting');

    const oldestTs = ((Date.now() - LOOKBACK_MS) / 1000).toFixed(6);

    for (const channel of channels) {
      logger.info({ channel: channel.id, channelName: channel.name, oldestTs }, 'CRAWL: checking channel');

      try {
        const history = await botClient.conversations.history({
          channel: channel.id,
          oldest: oldestTs,
          limit: 50,
        });

        const allMessages = history.messages ?? [];
        logger.info({ channel: channel.id, messageCount: allMessages.length }, 'CRAWL: history fetched');

        if (allMessages.length === 0) {
          logger.debug({ channel: channel.id }, 'CRAWL: no messages in window');
          continue;
        }

        // Log each message for debugging
        for (const m of allMessages) {
          logger.info({
            ts: m.ts,
            user: m.user,
            bot_id: m.bot_id ?? null,
            subtype: m.subtype ?? null,
            thread_ts: m.thread_ts ?? null,
            text: (m.text ?? '').slice(0, 80),
          }, 'CRAWL: message');
        }

        // Build bot participation map:
        // - Threads the bot replied in (checked via conversations.replies)
        // - Timestamps of bot messages (for top-level response detection)
        const botRespondedThreads = new Set<string>();
        const botMessageTimestamps: string[] = [];

        // First pass: collect bot messages visible in history (top-level bot posts)
        for (const m of allMessages) {
          const isBotMessage = !!m.bot_id || (botUserId && m.user === botUserId);
          if (isBotMessage) {
            if (m.thread_ts) botRespondedThreads.add(m.thread_ts);
            botMessageTimestamps.push(m.ts ?? '');
          }
        }

        // Second pass: for messages with reply_count > 0, check thread replies
        // for bot participation. conversations.history DOES NOT include thread
        // replies — we must fetch them with conversations.replies.
        const threadParents = allMessages.filter(
          m => (m.reply_count ?? 0) > 0 && m.ts && !botRespondedThreads.has(m.ts),
        );

        for (const parent of threadParents) {
          try {
            const replies = await botClient.conversations.replies({
              channel: channel.id,
              ts: parent.ts!,
              limit: 20,
            });
            for (const reply of (replies.messages ?? [])) {
              const isBot = !!reply.bot_id || (botUserId && reply.user === botUserId);
              if (isBot) {
                botRespondedThreads.add(parent.ts!);
                botMessageTimestamps.push(reply.ts ?? '');
                logger.info({ thread_ts: parent.ts, reply_ts: reply.ts }, 'CRAWL: found bot reply in thread');
                break; // One bot reply is enough to mark as responded
              }
            }
          } catch {
            logger.debug({ thread_ts: parent.ts }, 'CRAWL: failed to fetch thread replies');
          }
        }

        logger.info({
          botRespondedThreads: [...botRespondedThreads],
          botMessageCount: botMessageTimestamps.length,
          threadsChecked: threadParents.length,
        }, 'CRAWL: bot participation');

        // Find human messages the bot did NOT respond to
        const unresponded = allMessages.filter((m) => {
          // Skip bot messages and system subtypes
          if (m.bot_id || m.subtype) return false;
          if (botUserId && m.user === botUserId) return false;

          // If in a thread the bot replied to → already handled
          if (m.thread_ts && botRespondedThreads.has(m.thread_ts)) {
            logger.debug({ ts: m.ts, reason: 'bot_in_thread' }, 'CRAWL: responded');
            return false;
          }

          // Top-level: check if a bot message follows within 120s
          if (!m.thread_ts && m.ts) {
            const msgTime = parseFloat(m.ts);
            for (const botTs of botMessageTimestamps) {
              const botTime = parseFloat(botTs);
              if (botTime > msgTime && botTime - msgTime < 120) {
                logger.debug({ ts: m.ts, botTs, reason: 'bot_replied_within_120s' }, 'CRAWL: responded');
                return false;
              }
            }
          }

          logger.info({ ts: m.ts, user: m.user, text: (m.text ?? '').slice(0, 80) }, 'CRAWL: UNRESPONDED');
          return true;
        });

        if (unresponded.length === 0) {
          logger.info({ channel: channel.id, channelName: channel.name }, 'CRAWL: all messages responded to');
          continue;
        }

        logger.info({
          channel: channel.id,
          channelName: channel.name,
          total: allMessages.length,
          unresponded: unresponded.length,
        }, 'CRAWL: unresponded messages found — sending to Haiku');

        // Build full conversation context for Haiku (including bot messages)
        // so it can understand what was already handled vs. what's new.
        // Mark unresponded messages with >>> so Haiku knows which to triage.
        const unrespondedTs = new Set(unresponded.map(m => m.ts));
        const conversationText = allMessages
          .slice()
          .reverse() // oldest first for natural reading order
          .filter(m => !m.subtype) // skip system messages
          .slice(-40)
          .map(m => {
            const isBotMsg = !!m.bot_id || (botUserId && m.user === botUserId);
            const prefix = isBotMsg ? '[BOT]' : `[${m.user}]`;
            const marker = unrespondedTs.has(m.ts) ? '>>> UNRESPONDED: ' : '';
            return `${marker}${prefix}: ${(m.text ?? '').slice(0, 200)}`;
          })
          .join('\n');

        const haikuPrompt = `Channel: #${channel.name}\n\nFull conversation (>>> marks messages the bot did NOT respond to):\n${conversationText}`;
        logger.info({ prompt: haikuPrompt }, 'CRAWL: Haiku prompt');

        const relevanceResult = await anthropic.messages.create({
          model: classifierModel,
          max_tokens: 300,
          system: CATCHUP_TRIAGE_PROMPT,
          messages: [{ role: 'user', content: haikuPrompt }],
        });

        const responseBlock = relevanceResult.content.find(b => b.type === 'text');
        const responseStr = responseBlock && 'text' in responseBlock ? responseBlock.text : '';
        logger.info({ rawResponse: responseStr }, 'CRAWL: Haiku response');

        let triage: { relevant_count: number; summary: string | null; single_task: string | null };
        try {
          const jsonMatch = responseStr.match(/\{[\s\S]*\}/);
          triage = jsonMatch ? JSON.parse(jsonMatch[0]) : { relevant_count: 0, summary: null, single_task: null };
        } catch {
          logger.warn({ response: responseStr }, 'CRAWL: failed to parse Haiku response');
          triage = { relevant_count: 0, summary: null, single_task: null };
        }

        logger.info({ channel: channel.id, ...triage }, 'CRAWL: triage result');

        if (triage.relevant_count > 0) {
          // Collect the actual unresponded message texts for the agent
          const missedTexts = unresponded
            .slice()
            .reverse() // oldest first
            .map(m => (m.text ?? '').trim())
            .filter(Boolean);

          if (triage.relevant_count === 1 && triage.single_task) {
            // Single task — acknowledge and dispatch to agent
            await botClient.chat.postMessage({
              channel: channel.id,
              text: `Hey — just came back online and saw I missed this. On it: ${triage.single_task}`,
            });

            // Feed the missed message(s) to the agent via the handler queue
            const taskText = missedTexts.join('\n');
            logger.info({ channel: channel.id, taskText }, 'CRAWL: dispatching single task to agent');
            handler.getQueue().enqueue({
              text: taskText,
              channel: channel.id,
              userId: ownerUserId ?? unresponded[0]?.user ?? '',
              ts: `crawl-${Date.now()}`,
              receivedAt: Date.now(),
            });
          } else if (triage.summary) {
            // Multiple things — summarize and offer to help (user responds naturally)
            await botClient.chat.postMessage({
              channel: channel.id,
              text: `Just came back online — looks like I missed a few things here (${triage.summary}). Want me to dig into any of this?`,
            });
          } else {
            await botClient.chat.postMessage({
              channel: channel.id,
              text: `Just came back online — saw some activity I may have missed. Anything you need me to pick up?`,
            });
          }
        }

      } catch (error) {
        logger.debug({ channel: channel.id, error }, 'CRAWL: failed to check channel');
      }
    }
  } catch (error) {
    logger.warn({ error }, 'CRAWL: failed');
  }
}
