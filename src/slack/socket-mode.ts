/**
 * Slack Socket Mode Adapter — connects @slack/bolt to our SlackHandler.
 *
 * Socket Mode is used (instead of HTTP webhooks) because:
 * - No public endpoint needed (local-first architecture)
 * - WebSocket connection is persistent and low-latency
 * - @slack/bolt handles reconnection automatically
 *
 * This module creates a Bolt App and wires its events to the existing
 * SlackHandler, which manages accumulation, reactions, and interrupts.
 */

import { App, Assistant } from '@slack/bolt';
import { WebClient } from '@slack/web-api';
import { logger } from '../logger.js';
import { SlackHandler, type SlackReactionAPI, type SlackMessageAPI } from './handler.js';

export interface SlackConnection {
  app: App;
  handler: SlackHandler;
  botClient: WebClient;
  userClient?: WebClient;
  botUserId?: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Create a Slack connection using Socket Mode.
 *
 * @param config.appToken - Slack app-level token (xapp-...) for Socket Mode
 * @param config.botToken - Slack bot token (xoxb-...) for API calls
 * @param config.userToken - Optional user token (xoxp-...) for extended permissions
 */
export async function createSlackConnection(config: {
  appToken: string;
  botToken: string;
  userToken?: string;
}): Promise<SlackConnection> {
  // Create Bolt App with Socket Mode
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    // Disable built-in retry to avoid duplicate processing
    installerOptions: { directInstall: true },
  });

  // Create WebClients for direct API use (MCP server, etc.)
  const botClient = new WebClient(config.botToken);
  const userClient = config.userToken ? new WebClient(config.userToken) : undefined;

  // Get our bot's user ID so we can filter self-messages
  let botUserId: string | undefined;
  try {
    const authResult = await botClient.auth.test();
    botUserId = authResult.user_id as string | undefined;
    logger.info(
      { botUser: botUserId, team: authResult.team },
      'Slack auth verified',
    );
  } catch (error) {
    logger.warn({ error }, 'Failed to get bot user ID — self-message filtering disabled');
  }

  // ── Implement SlackReactionAPI ──
  const reactions: SlackReactionAPI = {
    async add(channel: string, timestamp: string, reaction: string) {
      await botClient.reactions.add({ channel, timestamp, name: reaction });
    },
    async remove(channel: string, timestamp: string, reaction: string) {
      await botClient.reactions.remove({ channel, timestamp, name: reaction });
    },
  };

  // ── Implement SlackMessageAPI ──
  const messages: SlackMessageAPI = {
    async post(channel: string, text: string, threadTs?: string) {
      const result = await botClient.chat.postMessage({
        channel,
        text,
        thread_ts: threadTs,
      });
      return { ts: result.ts as string };
    },
    async update(channel: string, ts: string, text: string) {
      await botClient.chat.update({ channel, ts, text });
    },
  };

  // Create handler with real Slack APIs
  const handler = new SlackHandler(reactions, messages);

  // ── Wire Bolt events to handler ──

  // Direct messages (IM) and app_mention events
  app.event('message', async ({ event }) => {
    // Cast to access common message fields — Bolt's union type is broad
    const msg = event as unknown as Record<string, unknown>;

    // Filter: ignore bot messages (prevent bot-to-bot injection)
    if (msg.bot_id || msg.bot_profile) return;

    // Filter: ignore our own messages
    if (botUserId && msg.user === botUserId) return;

    // Filter: only process new messages (not edits, deletes, etc.)
    if (msg.subtype && msg.subtype !== 'me_message') return;

    // Filter: only process DMs and channels where bot is mentioned
    // (app_mention is handled separately; 'message' in DMs always fires)
    if (msg.channel_type !== 'im' && msg.channel_type !== 'mpim') return;

    const channel = msg.channel as string;
    const user = (msg.user as string) ?? '';
    const ts = msg.ts as string;

    logger.debug(
      { channel, user, ts },
      'Message received via Socket Mode',
    );

    await handler.handleMessage({
      text: (msg.text as string) ?? '',
      channel,
      thread_ts: msg.thread_ts as string | undefined,
      user,
      ts,
    });
  });

  // App mentions in channels
  app.event('app_mention', async ({ event }) => {
    // Filter: ignore bot messages
    if ('bot_id' in event && event.bot_id) return;

    logger.debug(
      { channel: event.channel, user: event.user, ts: event.ts },
      'App mention received',
    );

    await handler.handleMessage({
      text: event.text ?? '',
      channel: event.channel,
      thread_ts: event.thread_ts,
      user: event.user ?? '',
      ts: event.ts,
    });
  });

  // User typing events — extends the accumulation window
  app.event('user_typing' as 'message', async ({ event }) => {
    const typingEvent = event as unknown as { channel: string; thread_ts?: string; user: string };
    handler.handleTyping(typingEvent);
  });

  // ── Wire Assistant Framework ──
  // The assistant panel is a separate UI surface (split-view) that coexists
  // with DMs and @mentions. It provides status indicators, suggested prompts,
  // and thread titles via dedicated Slack APIs.
  const assistant = new Assistant({
    threadStarted: async ({ setSuggestedPrompts, saveThreadContext }) => {
      // Show suggested prompts when user opens the assistant panel
      const prompts = [
        { title: 'Summarize recent messages', message: 'Summarize the important messages I missed in the last few hours' },
        { title: 'Check my calendar', message: 'What does my schedule look like today?' },
        { title: 'Draft a message', message: 'Help me draft a message to...' },
      ];

      try {
        await setSuggestedPrompts({ prompts });
      } catch (error) {
        logger.debug({ error }, 'Failed to set suggested prompts — non-critical');
      }

      // Save channel context if the user opened the panel from a channel
      try {
        await saveThreadContext();
      } catch {
        // Non-critical — context may not be available
      }
    },

    threadContextChanged: async ({ saveThreadContext }) => {
      // User navigated to a different channel while the panel is open.
      // Save the context for future use (Track D: memory/context injection).
      try {
        await saveThreadContext();
      } catch {
        // Non-critical
      }
    },

    userMessage: async ({ event, say, setStatus, setTitle }) => {
      // Message sent in the assistant panel — route through handler
      const msg = event as unknown as Record<string, unknown>;
      const channel = msg.channel as string;
      const user = (msg.user as string) ?? '';
      const text = (msg.text as string) ?? '';
      const ts = msg.ts as string;
      const threadTs = msg.thread_ts as string | undefined;

      logger.debug(
        { channel, user, ts },
        'Assistant message received',
      );

      await handler.handleAssistantMessage({
        text,
        channel,
        thread_ts: threadTs,
        user,
        ts,
        setStatus: async (status: string) => { await setStatus(status); },
        setTitle: async (title: string) => { await setTitle(title); },
        say: async (text: string) => { await say(text); },
      });
    },
  });

  app.assistant(assistant);

  return {
    app,
    handler,
    botClient,
    userClient,
    botUserId,

    async start() {
      await app.start();
      logger.info('Slack Socket Mode connection established');
    },

    async stop() {
      handler.shutdown();
      await app.stop();
      logger.info('Slack Socket Mode connection closed');
    },
  };
}
