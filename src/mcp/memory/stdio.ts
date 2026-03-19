#!/usr/bin/env npx tsx
/**
 * Memory MCP Server — stdio entrypoint for Claude Code SDK subprocess.
 *
 * Usage: npx tsx src/mcp/memory/stdio.ts --data-dir /path/to/data
 *
 * Initializes the database and starts the MCP server over stdin/stdout.
 */

import { parseArgs } from 'node:util';
import { initDb } from '../../db/index.js';
import { loadConfig } from '../../config.js';
import { startMemoryMcpServer } from './server.js';

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
