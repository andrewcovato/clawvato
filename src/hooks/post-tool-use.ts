import { logger } from '../logger.js';
import { logAction } from './audit-logger.js';
import { scanForSecrets } from '../security/output-sanitizer.js';

export interface ToolResult {
  toolName: string;
  serverName: string;
  input: Record<string, unknown>;
  output: unknown;
  success: boolean;
  error?: string;
  durationMs: number;
}

/**
 * PostToolUse hook — runs after every tool call.
 *
 * Responsibilities:
 * 1. Audit logging (immutable trail of every action)
 * 2. Output sanitization (scan for leaked secrets before returning to LLM)
 * 3. Metrics collection
 */
export function postToolUse(result: ToolResult): { sanitizedOutput: unknown } {
  // 1. Sanitize output first — before audit logging AND before returning to LLM
  let sanitizedOutput = result.output;
  let sanitizedOutputStr: string | undefined;
  if (typeof result.output === 'string') {
    const scan = scanForSecrets(result.output);
    if (scan.hasSecrets) {
      logger.warn(
        { tool: result.toolName, matches: scan.matches.length },
        'Secrets detected in tool output — redacting',
      );
      sanitizedOutput = scan.redacted;
      sanitizedOutputStr = scan.redacted;
    }
  }

  // 2. Audit log — uses sanitized output to avoid leaking secrets to disk
  logAction({
    type: `${result.serverName}.${result.toolName}`,
    status: result.success ? 'completed' : 'failed',
    trustLevel: 0,
    requestSource: 'agent',
    plannedAction: JSON.stringify(result.input).slice(0, 500),
    actualResult: result.success ? (sanitizedOutputStr ?? String(result.output)).slice(0, 500) : undefined,
    errorMessage: result.error,
  });

  // 3. Performance logging
  if (result.durationMs > 5000) {
    logger.warn(
      { tool: result.toolName, durationMs: result.durationMs },
      'Slow tool execution',
    );
  }

  logger.debug(
    { tool: result.toolName, success: result.success, durationMs: result.durationMs },
    'PostToolUse: complete',
  );

  return { sanitizedOutput };
}
