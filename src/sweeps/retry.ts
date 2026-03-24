/**
 * Retry utility for sweep collectors — exponential backoff around external API calls.
 *
 * Wraps a single async operation with up to `maxAttempts` retries.
 * Backoff starts at `initialDelayMs` and doubles each attempt.
 * Only retries on transient errors (network timeouts, 5xx, rate limits).
 */

import { logger } from '../logger.js';

const TRANSIENT_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND',
  'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH',
]);

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

function isTransientError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;

  // Node network errors
  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSIENT_CODES.has(code)) return true;

  // HTTP status codes (googleapis, axios, etc.)
  const errAny = err as unknown as Record<string, unknown>;
  const status = errAny.status ??
    errAny.statusCode ??
    (errAny.response as Record<string, unknown> | undefined)?.status;
  if (typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status)) return true;

  // Slack rate limit
  const msg = err.message.toLowerCase();
  if (msg.includes('rate_limited') || msg.includes('ratelimited') || msg.includes('too many requests')) return true;
  if (msg.includes('timeout') || msg.includes('timed out')) return true;

  return false;
}

/**
 * Retry an async function with exponential backoff.
 *
 * @param label - Human-readable label for logging
 * @param fn - The async operation to retry
 * @param maxAttempts - Maximum number of attempts (default: 3)
 * @param initialDelayMs - Initial delay before first retry (default: 1000)
 */
export async function retryWithBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  maxAttempts = 3,
  initialDelayMs = 1000,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      if (attempt === maxAttempts || !isTransientError(err)) {
        // Final attempt or non-transient error — don't retry
        throw err;
      }

      const delayMs = initialDelayMs * Math.pow(2, attempt - 1);
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        { label, attempt, maxAttempts, delayMs, error: errMsg },
        'Transient error — retrying after backoff',
      );

      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }

  // Should never reach here, but TypeScript needs it
  throw lastError;
}
