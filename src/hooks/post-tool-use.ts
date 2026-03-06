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
  // 1. Audit log
  logAction({
    type: `${result.serverName}.${result.toolName}`,
    status: result.success ? 'completed' : 'failed',
    trustLevel: 0,
    requestSource: 'agent',
    plannedAction: JSON.stringify(result.input).slice(0, 500),
    actualResult: result.success ? String(result.output).slice(0, 500) : undefined,
    errorMessage: result.error,
  });

  // 2. Output sanitization — scan for secrets before returning to LLM context
  let sanitizedOutput = result.output;
  if (typeof result.output === 'string') {
    const scan = scanForSecrets(result.output);
    if (scan.hasSecrets) {
      logger.warn(
        { tool: result.toolName, matches: scan.matches.length },
        'Secrets detected in tool output — redacting',
      );
      sanitizedOutput = scan.redacted;
    }
  }

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
