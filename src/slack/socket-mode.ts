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
import { getConfig } from '../config.js';
import { SlackHandler, type SlackReactionAPI, type SlackMessageAPI } from './handler.js';

/** Callback for task approval reactions. Set by start.ts after DB is ready. */
let onTaskApprovalReaction: ((channel: string, messageTs: string) => Promise<void>) | null = null;

/** Callback to resolve task context from a thread parent ts. */
let onResolveTaskFromThread: ((channel: string, threadTs: string) => Promise<{ taskId: string; title: string } | null>) | null = null;

/** Register a callback for task approval reactions. */
export function setTaskApprovalHandler(handler: (channel: string, messageTs: string) => Promise<void>): void {
  onTaskApprovalReaction = handler;
}

/** Register a callback to resolve tasks from thread replies. */
export function setTaskThreadResolver(resolver: (channel: string, threadTs: string) => Promise<{ taskId: string; title: string } | null>): void {
  onResolveTaskFromThread = resolver;
}

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

  /** Slack's max message length. We use 3900 to leave room for block overhead. */
  const SLACK_MAX_CHARS = 3900;

  /**
   * Split a long message into chunks at natural boundaries (paragraph, heading, hr).
   * Each chunk stays under SLACK_MAX_CHARS.
   */
  function chunkMessage(text: string): string[] {
    if (text.length <= SLACK_MAX_CHARS) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= SLACK_MAX_CHARS) {
        chunks.push(remaining);
        break;
      }

      // Find a good break point within the limit
      const slice = remaining.slice(0, SLACK_MAX_CHARS);
      let breakAt = -1;

      // Try to break at a horizontal rule
      const hrMatch = slice.lastIndexOf('\n---');
      if (hrMatch > SLACK_MAX_CHARS * 0.3) breakAt = hrMatch;

      // Try double newline (paragraph boundary)
      if (breakAt === -1) {
        const paraMatch = slice.lastIndexOf('\n\n');
        if (paraMatch > SLACK_MAX_CHARS * 0.3) breakAt = paraMatch;
      }

      // Try single newline
      if (breakAt === -1) {
        const nlMatch = slice.lastIndexOf('\n');
        if (nlMatch > SLACK_MAX_CHARS * 0.3) breakAt = nlMatch;
      }

      // Hard break at limit if no good boundary found
      if (breakAt === -1) breakAt = SLACK_MAX_CHARS;

      chunks.push(remaining.slice(0, breakAt).trimEnd());
      remaining = remaining.slice(breakAt).trimStart();
    }

    return chunks;
  }

  const messages: SlackMessageAPI = {
    async post(channel: string, text: string, threadTs?: string) {
      // Chunk long messages to avoid Slack's msg_too_long error
      const chunks = chunkMessage(text);
      let firstTs: string | undefined;

      for (const chunk of chunks) {
        // Try native markdown block first, fall back to plain text
        try {
          const result = await botClient.chat.postMessage({
            channel,
            text: chunk, // fallback for notifications
            blocks: [{ type: 'markdown', text: chunk }] as never[],
            thread_ts: threadTs,
          });
          if (!firstTs) firstTs = result.ts as string;
        } catch (error) {
          // If markdown block is rejected, fall back to plain text
          const errMsg = error instanceof Error ? error.message : '';
          if (errMsg.includes('invalid_blocks') || errMsg.includes('markdown')) {
            logger.debug('Markdown block not supported — falling back to plain text');
            const result = await botClient.chat.postMessage({
              channel,
              text: chunk,
              thread_ts: threadTs,
            });
            if (!firstTs) firstTs = result.ts as string;
          } else {
            throw error;
          }
        }
      }

      if (chunks.length > 1) {
        logger.info({ chunks: chunks.length, totalLength: text.length }, 'Long message split into chunks');
      }

      return { ts: firstTs as string };
    },
    async update(channel: string, ts: string, text: string) {
      try {
        await botClient.chat.update({
          channel, ts, text,
          blocks: [{ type: 'markdown', text }] as never[],
        });
      } catch {
        // Fall back to plain text update
        await botClient.chat.update({ channel, ts, text });
      }
    },
    async delete(channel: string, ts: string) {
      await botClient.chat.delete({ channel, ts });
    },
  };

  // Create handler with real Slack APIs
  const handler = new SlackHandler(reactions, messages);

  // ── Wire Bolt events to handler ──

  // Global middleware — logs ALL incoming events to verify Socket Mode is alive
  app.use(async ({ body, next }) => {
    const eventBody = body as Record<string, unknown>;
    const eventObj = eventBody.event as Record<string, unknown> | undefined;
    logger.debug({
      bodyType: eventBody.type,
      eventType: eventObj?.type ?? 'none',
    }, 'Bolt middleware: event received');
    await next();
  });

  // ALL messages in channels the bot is in — the bot listens like a human
  app.event('message', async ({ event }) => {
    try {
      // Cast to access common message fields — Bolt's union type is broad
      const msg = event as unknown as Record<string, unknown>;

      logger.info(
        { user: msg.user, bot_id: msg.bot_id ?? null, subtype: msg.subtype ?? null, channel: msg.channel, ts: msg.ts },
        'Socket Mode event received (raw)',
      );

      // Filter: ignore bot messages (prevent bot-to-bot injection and self-loop)
      if (msg.bot_id || msg.bot_profile) {
        logger.debug({ bot_id: msg.bot_id }, 'Filtered: bot message');
        return;
      }

      // Filter: ignore our own messages (belt-and-suspenders with bot_id check)
      if (botUserId && msg.user === botUserId) {
        logger.debug('Filtered: own message');
        return;
      }

      // Filter: only process new messages (not edits, deletes, etc.)
      if (msg.subtype) {
        logger.debug({ subtype: msg.subtype }, 'Filtered: has subtype');
        return;
      }

      const channel = msg.channel as string;
      const user = (msg.user as string) ?? '';
      const ts = msg.ts as string;
      const threadTs = msg.thread_ts as string | undefined;
      const channelType = msg.channel_type as string | undefined;

      // If this is a thread reply, check if the parent is a pinned task message
      let messageText = (msg.text as string) ?? '';
      if (threadTs && onResolveTaskFromThread) {
        try {
          const taskInfo = await onResolveTaskFromThread(channel, threadTs);
          if (taskInfo) {
            // Prepend deterministic task context so the agent knows exactly which task
            messageText = `[Task modification — task ID: ${taskInfo.taskId}, title: "${taskInfo.title}"]\n\nUser says: ${messageText}`;
            logger.info({ taskId: taskInfo.taskId, title: taskInfo.title }, 'Thread reply matched to pinned task');
          }
        } catch { /* non-critical — fall through to normal processing */ }
      }

      logger.info(
        { channel, user, ts, channelType },
        'User is asking something — routing to handler',
      );

      await handler.handleMessage({
        text: messageText,
        channel,
        thread_ts: threadTs,
        user,
        ts,
        channelType,
      });
    } catch (error) {
      logger.error({ error }, 'Message event handler crashed');
    }
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

  // Reaction events — used for task approval (thumbs-up on proposal messages)
  app.event('reaction_added', async ({ event }) => {
    try {
      const evt = event as unknown as Record<string, unknown>;
      const reaction = evt.reaction as string;
      const item = evt.item as Record<string, unknown>;
      const user = evt.user as string;

      // Only handle thumbs-up reactions from the owner
      if (reaction !== '+1' && reaction !== 'thumbsup') return;

      // Security: only the owner can approve tasks via reaction
      if (user !== getConfig().ownerSlackUserId) return;

      const channel = item.channel as string;
      const messageTs = item.ts as string;

      if (onTaskApprovalReaction) {
        await onTaskApprovalReaction(channel, messageTs);
      }
    } catch (error) {
      logger.debug({ error }, 'Reaction event handler error — non-critical');
    }
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

  // Catch-all error handler — Bolt can swallow errors silently
  app.error(async (error) => {
    logger.error({ error }, 'Bolt app error');
  });

  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  return {
    app,
    handler,
    botClient,
    userClient,
    botUserId,

    async start() {
      await app.start();
      logger.info('Slack Socket Mode connection established');

      // Access the SocketModeReceiver's client for connection monitoring
      const receiver = (app as unknown as { receiver: { client: {
        on: (event: string, cb: (...args: unknown[]) => void) => void;
        disconnect: () => Promise<void>;
        start: () => Promise<void>;
      } } }).receiver;

      if (receiver?.client) {
        receiver.client.on('connected', () => {
          logger.info('Socket Mode: connected');
        });
        receiver.client.on('disconnected', () => {
          logger.warn('Socket Mode: disconnected — will attempt reconnect');
        });
        receiver.client.on('reconnecting', () => {
          logger.info('Socket Mode: reconnecting...');
        });
        receiver.client.on('unable_to_socket_mode_start', () => {
          logger.error('Socket Mode: unable to start — will retry');
        });
      }

      // Heartbeat with connection health check
      heartbeatInterval = setInterval(async () => {
        try {
          // Quick API call to verify the bot token is still working
          await botClient.auth.test();
          logger.info('Heartbeat: process alive, API reachable');
        } catch (error) {
          logger.warn({ error }, 'Heartbeat: API call failed — connection may be dead');
        }
      }, 30_000);
    },

    async stop() {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      handler.shutdown();
      await app.stop();
      logger.info('Slack Socket Mode connection closed');
    },
  };
}
