import { logger } from '../logger.js';
import { getConfig } from '../config.js';
import { verifySender } from '../security/sender-verify.js';
import { checkRateLimit } from '../security/rate-limiter.js';
import { validatePath } from '../security/path-validator.js';

export interface ToolUseContext {
  toolName: string;
  serverName: string;
  input: Record<string, unknown>;
  requestSource?: string;
  senderSlackId?: string;
}

export interface HookResult {
  allowed: boolean;
  reason?: string;
  modified?: Record<string, unknown>;
}

/**
 * PreToolUse hook — validates every tool call before execution.
 *
 * This is a critical security boundary. It runs BEFORE the Agent SDK
 * executes any MCP tool call and can block or modify the call.
 *
 * Checks performed:
 * 1. Sender verification (single-principal authority)
 * 2. Rate limiting
 * 3. Path validation (filesystem operations)
 * 4. Trust level enforcement (training wheels)
 */
export function preToolUse(ctx: ToolUseContext): HookResult {
  const config = getConfig();

  // 1. Sender verification for instruction-bearing requests
  if (ctx.senderSlackId && config.ownerSlackUserId) {
    if (!verifySender(ctx.senderSlackId, config.ownerSlackUserId)) {
      logger.warn(
        { tool: ctx.toolName, sender: ctx.senderSlackId },
        'Blocked: sender is not the owner',
      );
      return { allowed: false, reason: 'Unauthorized sender' };
    }
  }

  // 2. Rate limiting
  const rateCheck = checkRateLimit(ctx.toolName);
  if (!rateCheck.allowed) {
    logger.warn(
      { tool: ctx.toolName, limit: rateCheck.reason },
      'Blocked: rate limit exceeded',
    );
    return { allowed: false, reason: rateCheck.reason };
  }

  // 3. Path validation for filesystem operations
  if (ctx.serverName === 'filesystem' && typeof ctx.input.path === 'string') {
    const pathCheck = validatePath(ctx.input.path, config.sandboxRoots);
    if (!pathCheck.allowed) {
      logger.warn(
        { tool: ctx.toolName, path: ctx.input.path, reason: pathCheck.reason },
        'Blocked: path validation failed',
      );
      return { allowed: false, reason: pathCheck.reason };
    }
  }

  // 4. Trust level enforcement is handled by the training wheels policy engine
  //    (injected separately to keep this hook focused on security checks)

  logger.debug({ tool: ctx.toolName, server: ctx.serverName }, 'PreToolUse: allowed');
  return { allowed: true };
}
