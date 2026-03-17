import { getConfig } from '../config.js';

interface RateLimitBucket {
  timestamps: number[];
  windowMs: number;
  maxRequests: number;
}

// In-memory sliding window rate limiter
const buckets = new Map<string, RateLimitBucket>();

// Default limits by tool category
const DEFAULT_LIMITS: Record<string, { windowMs: number; maxRequests: number }> = {
  // Outbound communication — tighter limits
  'gmail.send_email': { windowMs: 3600_000, maxRequests: 20 },
  'gmail.create_draft': { windowMs: 3600_000, maxRequests: 50 },
  'slack.post_message': { windowMs: 60_000, maxRequests: 30 },

  // File operations
  'gdrive.update_permissions': { windowMs: 3600_000, maxRequests: 50 },
  'filesystem.write_file': { windowMs: 60_000, maxRequests: 30 },

  // Calendar
  'gcalendar.create_event': { windowMs: 3600_000, maxRequests: 20 },

  // Default for any tool
  '_default': { windowMs: 60_000, maxRequests: 60 },
};

function getBucket(toolName: string): RateLimitBucket {
  if (!buckets.has(toolName)) {
    // Merge config overrides into defaults for category-level limits
    const config = getConfig();
    const configOverrides: Record<string, { windowMs: number; maxRequests: number }> = {
      'slack.post_message': { windowMs: 60_000, maxRequests: config.rateLimits.actionsPerMinute },
      'gmail.send_email': { windowMs: 3600_000, maxRequests: config.rateLimits.emailsPerHour },
      'gmail.create_draft': { windowMs: 3600_000, maxRequests: config.rateLimits.emailsPerHour },
      'gdrive.update_permissions': { windowMs: 3600_000, maxRequests: config.rateLimits.fileSharesPerHour },
      '_default': { windowMs: 60_000, maxRequests: config.rateLimits.actionsPerMinute },
    };

    const limits = configOverrides[toolName] ?? DEFAULT_LIMITS[toolName] ?? configOverrides['_default'];
    buckets.set(toolName, {
      timestamps: [],
      windowMs: limits.windowMs,
      maxRequests: limits.maxRequests,
    });
  }
  return buckets.get(toolName)!;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  remaining?: number;
  resetMs?: number;
}

/**
 * Check if a tool call is within rate limits.
 * Uses a sliding window algorithm — no external dependencies needed.
 */
export function checkRateLimit(toolName: string): RateLimitResult {
  const bucket = getBucket(toolName);
  const now = Date.now();

  // Prune expired timestamps
  bucket.timestamps = bucket.timestamps.filter(
    ts => now - ts < bucket.windowMs,
  );

  if (bucket.timestamps.length >= bucket.maxRequests) {
    const oldestInWindow = bucket.timestamps[0];
    const resetMs = bucket.windowMs - (now - oldestInWindow);

    return {
      allowed: false,
      reason: `Rate limit exceeded for ${toolName}: ${bucket.maxRequests} per ${bucket.windowMs / 1000}s`,
      remaining: 0,
      resetMs,
    };
  }

  // Record this request
  bucket.timestamps.push(now);

  return {
    allowed: true,
    remaining: bucket.maxRequests - bucket.timestamps.length,
  };
}

/**
 * Reset rate limit state for a specific tool (useful for testing).
 */
export function resetRateLimit(toolName: string): void {
  buckets.delete(toolName);
}

/**
 * Reset all rate limit state.
 */
export function resetAllRateLimits(): void {
  buckets.clear();
}
