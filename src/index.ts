/**
 * Clawvato: Always-On Personal AI Agent
 *
 * Main entry point. This module is imported by the CLI and
 * re-exports the core public API for programmatic use.
 */

export { loadConfig, getConfig, updateConfig } from './config.js';
export { initDb, getDb, closeDb } from './db/index.js';
export { initLogger, logger } from './logger.js';
export {
  getCredential,
  setCredential,
  deleteCredential,
  hasCredential,
  requireCredential,
  listCredentials,
} from './credentials.js';
export { preToolUse } from './hooks/pre-tool-use.js';
export { postToolUse } from './hooks/post-tool-use.js';
export { logAction, updateAction, getRecentActions } from './hooks/audit-logger.js';
export { verifySender, classifyInbound } from './security/sender-verify.js';
export { scanForSecrets, assertNoSecrets } from './security/output-sanitizer.js';
export { validatePath } from './security/path-validator.js';
export { checkRateLimit, resetRateLimit, resetAllRateLimits } from './security/rate-limiter.js';
