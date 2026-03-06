import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';

const ConfigSchema = z.object({
  dataDir: z.string(),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // Single-principal authority
  ownerSlackUserId: z.string().optional(),

  // Model routing
  models: z.object({
    classifier: z.string().default('claude-haiku-4-5-20251001'),
    planner: z.string().default('claude-opus-4-6'),
    executor: z.string().default('claude-sonnet-4-6'),
  }).default(() => ({
    classifier: 'claude-haiku-4-5-20251001',
    planner: 'claude-opus-4-6',
    executor: 'claude-sonnet-4-6',
  })),

  // Training wheels
  trustLevel: z.number().int().min(0).max(3).default(0),

  // Filesystem sandbox
  sandboxRoots: z.array(z.string()).default([]),

  // Rate limiting
  rateLimits: z.object({
    actionsPerMinute: z.number().default(30),
    emailsPerHour: z.number().default(20),
    fileSharesPerHour: z.number().default(50),
  }).default(() => ({
    actionsPerMinute: 30,
    emailsPerHour: 20,
    fileSharesPerHour: 50,
  })),

  // Slack configuration
  slack: z.object({
    botToken: z.string().optional(),
    appToken: z.string().optional(),
    userToken: z.string().optional(),
  }).default({}),

  // Google configuration
  google: z.object({
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    agentEmail: z.string().optional(),
  }).default({}),

  // GitHub configuration
  github: z.object({
    pat: z.string().optional(),
    defaultOrg: z.string().optional(),
  }).default({}),
});

export type ClawvatoConfig = z.infer<typeof ConfigSchema>;

let currentConfig: ClawvatoConfig | null = null;

const DEFAULT_DATA_DIR = join(homedir(), '.clawvato');

function getDefaultConfig(): Partial<ClawvatoConfig> {
  return {
    dataDir: DEFAULT_DATA_DIR,
    logLevel: 'info',
    trustLevel: 0,
    models: {
      classifier: 'claude-haiku-4-5-20251001',
      planner: 'claude-opus-4-6',
      executor: 'claude-sonnet-4-6',
    },
    rateLimits: {
      actionsPerMinute: 30,
      emailsPerHour: 20,
      fileSharesPerHour: 50,
    },
    sandboxRoots: [],
    slack: {},
    google: {},
    github: {},
  };
}

export function loadConfig(overrides?: Partial<ClawvatoConfig>): ClawvatoConfig {
  const defaults = getDefaultConfig();

  // Ensure data directory exists
  const dataDir = overrides?.dataDir ?? defaults.dataDir ?? DEFAULT_DATA_DIR;
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // Load from config file if it exists
  const configPath = join(dataDir, 'config.json');
  let fileConfig: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      // Invalid config file — use defaults
    }
  }

  // Load from environment variables
  const envConfig: Record<string, unknown> = {};
  if (process.env.OWNER_SLACK_USER_ID) envConfig.ownerSlackUserId = process.env.OWNER_SLACK_USER_ID;
  if (process.env.LOG_LEVEL) envConfig.logLevel = process.env.LOG_LEVEL;
  if (process.env.DATA_DIR) envConfig.dataDir = process.env.DATA_DIR;

  // Merge: defaults < file < env < overrides
  const merged = { ...defaults, ...fileConfig, ...envConfig, ...overrides };

  currentConfig = ConfigSchema.parse(merged);
  return currentConfig;
}

export function getConfig(): ClawvatoConfig {
  if (!currentConfig) {
    return loadConfig();
  }
  return currentConfig;
}

export function saveConfig(config: ClawvatoConfig): void {
  const configPath = join(config.dataDir, 'config.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  currentConfig = config;
}

export function updateConfig(updates: Partial<ClawvatoConfig>): ClawvatoConfig {
  const config = getConfig();
  const updated = ConfigSchema.parse({ ...config, ...updates });
  saveConfig(updated);
  return updated;
}
