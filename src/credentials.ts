import { logger } from './logger.js';

const SERVICE_NAME = 'clawvato';

// Credential keys stored in Keychain
export type CredentialKey =
  | 'anthropic-api-key'
  | 'slack-bot-token'
  | 'slack-app-token'
  | 'slack-user-token'
  | 'google-client-id'
  | 'google-client-secret'
  | 'google-refresh-token'
  | 'github-pat';

let keytar: typeof import('keytar') | null = null;

async function getKeytar() {
  if (keytar) return keytar;
  try {
    keytar = await import('keytar');
    return keytar;
  } catch {
    logger.warn('keytar not available — falling back to environment variables');
    return null;
  }
}

// Environment variable mapping for fallback
const ENV_MAP: Record<CredentialKey, string> = {
  'anthropic-api-key': 'ANTHROPIC_API_KEY',
  'slack-bot-token': 'SLACK_BOT_TOKEN',
  'slack-app-token': 'SLACK_APP_TOKEN',
  'slack-user-token': 'SLACK_USER_TOKEN',
  'google-client-id': 'GOOGLE_CLIENT_ID',
  'google-client-secret': 'GOOGLE_CLIENT_SECRET',
  'google-refresh-token': 'GOOGLE_REFRESH_TOKEN',
  'github-pat': 'GITHUB_PAT',
};

/**
 * Get a credential from macOS Keychain, falling back to environment variable.
 * Credentials are NEVER included in LLM context — only used at tool execution time.
 */
export async function getCredential(key: CredentialKey): Promise<string | null> {
  // Try Keychain first
  const kt = await getKeytar();
  if (kt) {
    const value = await kt.getPassword(SERVICE_NAME, key);
    if (value) return value;
  }

  // Fallback to environment variable
  const envKey = ENV_MAP[key];
  return process.env[envKey] ?? null;
}

/**
 * Store a credential in macOS Keychain.
 */
export async function setCredential(key: CredentialKey, value: string): Promise<void> {
  const kt = await getKeytar();
  if (kt) {
    await kt.setPassword(SERVICE_NAME, key, value);
    logger.info({ key }, 'Credential stored in Keychain');
  } else {
    logger.warn({ key }, 'Cannot store credential — keytar not available');
    throw new Error('Keychain not available. Install keytar or set environment variables.');
  }
}

/**
 * Delete a credential from macOS Keychain.
 */
export async function deleteCredential(key: CredentialKey): Promise<void> {
  const kt = await getKeytar();
  if (kt) {
    await kt.deletePassword(SERVICE_NAME, key);
    logger.info({ key }, 'Credential deleted from Keychain');
  }
}

/**
 * Check if a credential is available (in Keychain or env).
 */
export async function hasCredential(key: CredentialKey): Promise<boolean> {
  const value = await getCredential(key);
  return value !== null && value.length > 0;
}

/**
 * Get a credential or throw if not found.
 */
export async function requireCredential(key: CredentialKey): Promise<string> {
  const value = await getCredential(key);
  if (!value) {
    throw new Error(
      `Missing credential: ${key}. Set via 'clawvato credentials set ${key}' or environment variable ${ENV_MAP[key]}.`
    );
  }
  return value;
}

/**
 * List all credential keys and their availability status.
 */
export async function listCredentials(): Promise<Record<CredentialKey, boolean>> {
  const keys = Object.keys(ENV_MAP) as CredentialKey[];
  const result: Record<string, boolean> = {};
  for (const key of keys) {
    result[key] = await hasCredential(key);
  }
  return result as Record<CredentialKey, boolean>;
}
