#!/usr/bin/env node

import { Command } from 'commander';
import { startAgent } from './start.js';
import { showStatus } from './status.js';
import { getConfig, loadConfig, updateConfig } from '../config.js';
import { listCredentials, setCredential, deleteCredential, type CredentialKey } from '../credentials.js';
import { getRecentActions } from '../hooks/audit-logger.js';
import { initDb } from '../db/index.js';
import { initLogger } from '../logger.js';

const program = new Command();

program
  .name('clawvato')
  .description('Always-on personal AI agent — your chief of staff')
  .version('0.1.0');

// --- Lifecycle commands ---

program
  .command('start')
  .description('Start the Clawvato agent')
  .option('--log-level <level>', 'Log level (debug, info, warn, error)')
  .action(async (opts) => {
    const config = loadConfig(opts.logLevel ? { logLevel: opts.logLevel } : undefined);
    initLogger(config.logLevel);
    initDb();
    await startAgent();
  });

program
  .command('status')
  .description('Show agent status, uptime, and pending workflows')
  .action(async () => {
    loadConfig();
    initDb();
    showStatus();
  });

// --- Config commands ---

const configCmd = program
  .command('config')
  .description('Manage configuration');

configCmd
  .command('show')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfig();
    // Redact sensitive fields
    const safe = { ...config, slack: { ...config.slack }, google: { ...config.google }, github: { ...config.github } };
    if (safe.slack.botToken) safe.slack.botToken = '***';
    if (safe.slack.appToken) safe.slack.appToken = '***';
    if (safe.slack.userToken) safe.slack.userToken = '***';
    if (safe.google.clientSecret) safe.google.clientSecret = '***';
    if (safe.github.pat) safe.github.pat = '***';
    console.log(JSON.stringify(safe, null, 2));
  });

configCmd
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    loadConfig();
    try {
      // Parse value as JSON if possible (for arrays, numbers, booleans)
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        parsed = value;
      }
      updateConfig({ [key]: parsed });
      console.log(`Config updated: ${key} = ${value}`);
    } catch (err) {
      console.error(`Failed to update config: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// --- Credentials commands ---

const credCmd = program
  .command('credentials')
  .description('Manage stored credentials');

credCmd
  .command('list')
  .description('Show credential availability status')
  .action(async () => {
    const creds = await listCredentials();
    console.log('\nCredential Status:');
    for (const [key, available] of Object.entries(creds)) {
      const status = available ? '✓ set' : '✗ missing';
      console.log(`  ${key}: ${status}`);
    }
    console.log();
  });

credCmd
  .command('set <key> <value>')
  .description('Store a credential in macOS Keychain')
  .action(async (key: string, value: string) => {
    try {
      await setCredential(key as CredentialKey, value);
      console.log(`Credential '${key}' stored in Keychain.`);
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

credCmd
  .command('delete <key>')
  .description('Remove a credential from Keychain')
  .action(async (key: string) => {
    try {
      await deleteCredential(key as CredentialKey);
      console.log(`Credential '${key}' deleted.`);
    } catch (err) {
      console.error(`Failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

// --- Audit commands ---

program
  .command('audit')
  .description('Show recent action audit log')
  .option('-n, --limit <n>', 'Number of entries', '20')
  .option('-t, --type <type>', 'Filter by action type')
  .action((opts) => {
    loadConfig();
    initDb();
    const entries = getRecentActions(parseInt(opts.limit), opts.type);
    if (entries.length === 0) {
      console.log('No actions recorded yet.');
      return;
    }
    console.log('\nRecent Actions:');
    for (const entry of entries) {
      console.log(`  [${entry.status}] ${entry.type} — ${entry.plannedAction?.slice(0, 80)}`);
    }
    console.log();
  });

// --- Trust level commands ---

program
  .command('trust-level')
  .description('Show or set training wheels trust level')
  .argument('[level]', 'New trust level (0-3)')
  .action((level?: string) => {
    const config = loadConfig();
    if (level === undefined) {
      const labels = ['FULL SUPERVISION', 'TRUSTED READS', 'TRUSTED ROUTINE', 'FULL AUTONOMY'];
      console.log(`Current trust level: ${config.trustLevel} (${labels[config.trustLevel]})`);
    } else {
      const n = parseInt(level);
      if (isNaN(n) || n < 0 || n > 3) {
        console.error('Trust level must be 0-3');
        process.exit(1);
      }
      updateConfig({ trustLevel: n });
      console.log(`Trust level updated to ${n}.`);
    }
  });

program.parse();
