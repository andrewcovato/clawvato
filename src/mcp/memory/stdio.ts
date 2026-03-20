#!/usr/bin/env npx tsx
/**
 * Memory MCP Server — stdio entrypoint for Claude Code SDK subprocess.
 *
 * Usage: npx tsx src/mcp/memory/stdio.ts
 *
 * IMPORTANT: MCP protocol uses stdin/stdout for JSON-RPC. All logging
 * MUST go to stderr, not stdout. We set LOG_DESTINATION=stderr before
 * importing anything that uses the logger.
 */

// Force all pino logging to stderr BEFORE any imports touch the logger
process.env.LOG_DESTINATION = 'stderr';

import { initDb } from '../../db/index.js';
import { loadConfig } from '../../config.js';
import { startMemoryMcpServer } from './server.js';

// Also override console.log/warn/error to stderr (some deps use console)
const stderrWrite = (msg: string) => process.stderr.write(msg + '\n');
console.log = stderrWrite;
console.warn = stderrWrite;
console.error = stderrWrite;

// Load config
loadConfig({});

// Initialize database (async) and start MCP server
const sql = await initDb();
startMemoryMcpServer(sql);
