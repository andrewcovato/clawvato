#!/usr/bin/env npx tsx
/**
 * Memory MCP Server — stdio entrypoint for Claude Code SDK subprocess.
 *
 * Usage: npx tsx src/mcp/memory/stdio.ts --data-dir /path/to/data
 *
 * IMPORTANT: MCP protocol uses stdin/stdout for JSON-RPC. All logging
 * MUST go to stderr, not stdout. We set LOG_DESTINATION=stderr before
 * importing anything that uses the logger.
 */

// Force all pino logging to stderr BEFORE any imports touch the logger
process.env.LOG_DESTINATION = 'stderr';

import { parseArgs } from 'node:util';
import pino from 'pino';
import { initDb } from '../../db/index.js';
import { loadConfig } from '../../config.js';
import { startMemoryMcpServer } from './server.js';

// Also override console.log/warn/error to stderr (some deps use console)
const stderrWrite = (msg: string) => process.stderr.write(msg + '\n');
console.log = stderrWrite;
console.warn = stderrWrite;
console.error = stderrWrite;

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
  },
  strict: false,
});

// Load config with data dir override if provided
const overrides: Record<string, string> = {};
if (values['data-dir']) {
  overrides.dataDir = values['data-dir'] as string;
}
loadConfig(overrides);

// Initialize database
const db = initDb();

// Start MCP server
startMemoryMcpServer(db);
