/**
 * Google OAuth2 Authentication.
 *
 * Supports two flows:
 * 1. Credentials from env vars (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)
 *    — used on Railway / headless servers
 * 2. Interactive OAuth via `gws auth setup` + export
 *    — used for initial setup, tokens exported to env vars
 *
 * One-click deploy note: the setup wizard should automate:
 *   gws auth setup → gws auth export → railway variable set GOOGLE_REFRESH_TOKEN=...
 */

import { google } from 'googleapis';
import { logger } from '../logger.js';
import { getCredential } from '../credentials.js';

let oauth2Client: InstanceType<typeof google.auth.OAuth2> | null = null;

/**
 * Get or create an authenticated OAuth2 client.
 * Returns null if credentials are not configured.
 */
export async function getGoogleAuth(): Promise<InstanceType<typeof google.auth.OAuth2> | null> {
  if (oauth2Client) return oauth2Client;

  const clientId = await getCredential('google-client-id');
  const clientSecret = await getCredential('google-client-secret');
  const refreshToken = await getCredential('google-refresh-token');

  if (!clientId || !clientSecret || !refreshToken) {
    logger.debug('Google credentials not configured — Google tools disabled');
    return null;
  }

  oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  // Verify the token works
  try {
    await oauth2Client.getAccessToken();
    logger.info('Google OAuth2 authenticated');
  } catch (error) {
    logger.warn({ error }, 'Google OAuth2 token refresh failed — Google tools disabled');
    oauth2Client = null;
    return null;
  }

  return oauth2Client;
}

/**
 * Check if Google credentials are available (without creating the client).
 */
export async function hasGoogleCredentials(): Promise<boolean> {
  const clientId = await getCredential('google-client-id');
  const refreshToken = await getCredential('google-refresh-token');
  return !!(clientId && refreshToken);
}
