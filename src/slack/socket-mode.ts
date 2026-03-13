/**
 * Slack Socket Mode Adapter — connects @slack/bolt to our SlackHandler.
 *
 * Socket Mode is used (instead of HTTP webhooks) because:
 * - No public endpoint needed (local-first architecture)
 * - WebSocket connection is persistent and low-latency
 * - @slack/bolt handles reconnection automatically
 *
 * The bot listens to ALL messages in channels it's joined — like a human
 * in the room. The agent decides whether to respond based on context.
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

  // ALL messages in channels the bot is in — the bot listens like a human
  app.event('message', async ({ event }) => {
    // Cast to access common message fields — Bolt's union type is broad
    const msg = event as unknown as Record<string, unknown>;

    // Filter: ignore bot messages (prevent bot-to-bot injection and self-loop)
    if (msg.bot_id || msg.bot_profile) return;

    // Filter: ignore our own messages (belt-and-suspenders with bot_id check)
    if (botUserId && msg.user === botUserId) return;

    // Filter: only process new messages (not edits, deletes, etc.)
    if (msg.subtype) return;

    const channel = msg.channel as string;
    const user = (msg.user as string) ?? '';
    const ts = msg.ts as string;
    const threadTs = msg.thread_ts as string | undefined;
    const channelType = msg.channel_type as string | undefined;

    logger.debug(
      { channel, user, ts, channelType },
      'Message received via Socket Mode',
    );

    await handler.handleMessage({
      text: (msg.text as string) ?? '',
      channel,
      thread_ts: threadTs,
      user,
      ts,
      channelType,
    });
  });

  // App mentions in channels — still wired for explicit @mention detection
  // (handler can use this signal to know the message is definitely directed at the bot)
  app.event('app_mention', async ({ event }) => {
    // The message event handler already processes this message.
    // app_mention fires in addition to the message event, so we just log it.
    // The agent uses @mention presence in the text to gauge intent.
    logger.debug(
      { channel: event.channel, user: event.user, ts: event.ts },
      'App mention received (handled via message event)',
    );
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
      try {
        await saveThreadContext();
      } catch {
        // Non-critical
      }
    },

    userMessage: async ({ event, say, setStatus, setTitle }) => {
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
