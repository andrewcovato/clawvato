/**
 * Setup Wizard — interactive guided setup for Clawvato.
 *
 * Walks the user through:
 * 1. Anthropic API key
 * 2. Slack tokens (bot, app, optional user)
 * 3. Owner Slack user ID
 * 4. Trust level
 * 5. Connection test
 *
 * Uses `readline/promises` (Node.js core) — no extra deps.
 * All validation is extracted as pure functions for testability.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { setCredential, hasCredential } from '../credentials.js';
import { updateConfig, loadConfig } from '../config.js';

// ── Validation Functions (pure, testable) ──

export function validateAnthropicKey(key: string): { valid: boolean; reason?: string } {
  const trimmed = key.trim();
  if (!trimmed) return { valid: false, reason: 'API key cannot be empty' };
  if (!trimmed.startsWith('sk-ant-')) return { valid: false, reason: 'Anthropic API keys start with "sk-ant-"' };
  if (trimmed.length < 20) return { valid: false, reason: 'API key is too short' };
  return { valid: true };
}

export function validateSlackBotToken(token: string): { valid: boolean; reason?: string } {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false, reason: 'Bot token cannot be empty' };
  if (!trimmed.startsWith('xoxb-')) return { valid: false, reason: 'Slack bot tokens start with "xoxb-"' };
  if (trimmed.length < 20) return { valid: false, reason: 'Bot token is too short' };
  return { valid: true };
}

export function validateSlackAppToken(token: string): { valid: boolean; reason?: string } {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false, reason: 'App token cannot be empty' };
  if (!trimmed.startsWith('xapp-')) return { valid: false, reason: 'Slack app-level tokens start with "xapp-"' };
  if (trimmed.length < 20) return { valid: false, reason: 'App token is too short' };
  return { valid: true };
}

export function validateSlackUserToken(token: string): { valid: boolean; reason?: string } {
  const trimmed = token.trim();
  if (!trimmed) return { valid: true }; // Optional — empty is OK
  if (!trimmed.startsWith('xoxp-')) return { valid: false, reason: 'Slack user tokens start with "xoxp-"' };
  if (trimmed.length < 20) return { valid: false, reason: 'User token is too short' };
  return { valid: true };
}

export function validateSlackUserId(id: string): { valid: boolean; reason?: string } {
  const trimmed = id.trim();
  if (!trimmed) return { valid: false, reason: 'User ID cannot be empty' };
  if (!/^U[A-Z0-9]{3,}$/.test(trimmed)) {
    return { valid: false, reason: 'Slack user IDs start with "U" followed by alphanumeric characters (e.g., U0ABC12345)' };
  }
  return { valid: true };
}

export function validateTrustLevel(input: string): { valid: boolean; value?: number; reason?: string } {
  const trimmed = input.trim();
  if (!trimmed) return { valid: true, value: 1 }; // Default
  const n = parseInt(trimmed, 10);
  if (isNaN(n) || n < 0 || n > 3) {
    return { valid: false, reason: 'Trust level must be 0, 1, 2, or 3' };
  }
  return { valid: true, value: n };
}

// ── Slack App Manifest ──

const SLACK_APP_MANIFEST = `display_information:
  name: Clawvato
  description: Personal AI chief of staff
  background_color: "#2c2d30"
features:
  bot_user:
    display_name: clawvato
    always_online: true
  assistant_view:
    assistant_description: "Your AI chief of staff — manages Slack, email, calendar, and tasks"
    suggested_prompts:
      - title: "Summarize recent messages"
        message: "Summarize the important messages I've missed in the last few hours"
      - title: "Check my calendar"
        message: "What does my schedule look like today?"
      - title: "Draft a message"
        message: "Help me draft a message to..."
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write
      - channels:history
      - channels:read
      - chat:write
      - im:history
      - im:read
      - im:write
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
      - users:read.email
    user:
      - search:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - assistant_thread_started
      - assistant_thread_context_changed
      - message.im
      - message.mpim
  interactivity:
    is_enabled: true
  org_deploy_enabled: false
  socket_mode_enabled: true
  token_rotation_enabled: false`;

// ── Interactive Wizard ──

/**
 * Run the interactive setup wizard.
 *
 * @param testRl - Optional readline interface for testing
 */
export async function runSetup(testRl?: ReturnType<typeof createInterface>): Promise<void> {
  const rl = testRl ?? createInterface({ input: stdin, output: stdout });
  const isTest = !!testRl;

  const print = (msg: string) => {
    if (!isTest) console.log(msg);
  };

  try {
    print('');
    print('  ┌─────────────────────────────┐');
    print('  │   Clawvato Setup Wizard     │');
    print('  └─────────────────────────────┘');
    print('');

    // Ensure config is loaded
    loadConfig();

    // ── Step 1: Anthropic API Key ──
    print('  Step 1/5: Anthropic API Key');
    print('  ───────────────────────────');
    print('  Get one at: https://console.anthropic.com/settings/keys');
    print('');

    let anthropicKey = '';
    while (true) {
      anthropicKey = await rl.question('  API Key: ');
      const result = validateAnthropicKey(anthropicKey);
      if (result.valid) break;
      print(`  ✗ ${result.reason}`);
    }

    await setCredential('anthropic-api-key', anthropicKey.trim());
    print('  ✓ Stored in macOS Keychain');
    print('');

    // ── Step 2: Slack App ──
    print('  Step 2/5: Slack App');
    print('  ───────────────────');
    print('  1. Go to https://api.slack.com/apps → Create New App → From Manifest');
    print('  2. Paste this manifest:');
    print('');
    for (const line of SLACK_APP_MANIFEST.split('\n')) {
      print(`     ${line}`);
    }
    print('');
    print('  3. Install to workspace');
    print('  4. Go to "OAuth & Permissions" → copy Bot Token');
    print('  5. Go to "Basic Information" → "App-Level Tokens" → create one with connections:write');
    print('');

    // Bot token
    let botToken = '';
    while (true) {
      botToken = await rl.question('  Bot Token (xoxb-...): ');
      const result = validateSlackBotToken(botToken);
      if (result.valid) break;
      print(`  ✗ ${result.reason}`);
    }
    await setCredential('slack-bot-token', botToken.trim());
    print('  ✓ Bot token stored');

    // App token
    let appToken = '';
    while (true) {
      appToken = await rl.question('  App-Level Token (xapp-...): ');
      const result = validateSlackAppToken(appToken);
      if (result.valid) break;
      print(`  ✗ ${result.reason}`);
    }
    await setCredential('slack-app-token', appToken.trim());
    print('  ✓ App token stored');

    // User token (optional)
    const userTokenInput = await rl.question('  User Token (xoxp-..., optional — Enter to skip): ');
    const userTokenResult = validateSlackUserToken(userTokenInput);
    if (userTokenResult.valid && userTokenInput.trim()) {
      await setCredential('slack-user-token', userTokenInput.trim());
      print('  ✓ User token stored');
    } else if (!userTokenResult.valid) {
      print(`  ✗ ${userTokenResult.reason} — skipping`);
      print('  ⚠ Search will be limited to public channels the bot is in');
    } else {
      print('  ⚠ Skipped — search limited to public channels');
    }
    print('');

    // ── Step 3: Owner Slack User ID ──
    print('  Step 3/5: Your Slack User ID');
    print('  ────────────────────────────');
    print('  Find it: Your profile → ⋯ → Copy member ID');
    print('');

    let userId = '';
    while (true) {
      userId = await rl.question('  User ID: ');
      const result = validateSlackUserId(userId);
      if (result.valid) break;
      print(`  ✗ ${result.reason}`);
    }
    updateConfig({ ownerSlackUserId: userId.trim() });
    print('  ✓ Owner configured');
    print('');

    // ── Step 4: Trust Level ──
    print('  Step 4/5: Trust Level');
    print('  ─────────────────────');
    print('  0 = Full Supervision    (confirm everything)');
    print('  1 = Trusted Reads       (auto-approve searches) ← recommended');
    print('  2 = Trusted Routine     (auto-approve graduated patterns)');
    print('  3 = Full Autonomy       (auto-approve most actions)');
    print('');

    let trustLevel = 1;
    while (true) {
      const input = await rl.question('  Trust Level [1]: ');
      const result = validateTrustLevel(input);
      if (result.valid) {
        trustLevel = result.value!;
        break;
      }
      print(`  ✗ ${result.reason}`);
    }
    updateConfig({ trustLevel });
    print(`  ✓ Trust level set to ${trustLevel}`);
    print('');

    // ── Step 5: Connection Test ──
    print('  Step 5/5: Connection Test');
    print('  ─────────────────────────');

    // Test Slack connection
    let slackOk = false;
    try {
      const { WebClient } = await import('@slack/web-api');
      const slackClient = new WebClient(botToken.trim());
      const authResult = await slackClient.auth.test();
      print(`  Testing Slack... ✓ Connected as @${authResult.user} in "${authResult.team}"`);
      slackOk = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      print(`  Testing Slack... ✗ ${msg}`);
    }

    // Test Anthropic connection
    let anthropicOk = false;
    try {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const anthropicClient = new Anthropic({ apiKey: anthropicKey.trim() });
      await anthropicClient.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'ping' }],
      });
      print('  Testing Anthropic... ✓ API key valid');
      anthropicOk = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      print(`  Testing Anthropic... ✗ ${msg}`);
    }

    print('');
    if (slackOk && anthropicOk) {
      print('  ✓ Setup complete! Run: clawvato start');
    } else {
      print('  ⚠ Setup saved, but some connection tests failed.');
      print('  Fix the issues above, then run: clawvato start');
    }
    print('');
  } finally {
    if (!isTest) {
      rl.close();
    }
  }
}
