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

  // ── Operational tunables ──
  // See CLAUDE.md "Context Limits" section for documentation

  agent: z.object({
    maxTurns: z.number().int().min(1).default(30),
    timeoutMs: z.number().int().min(10_000).default(600_000),
  }).default(() => ({ maxTurns: 30, timeoutMs: 600_000 })),

  context: z.object({
    shortTermMessageLimit: z.number().int().default(50),
    shortTermMsgCharLimit: z.number().int().default(1000),
    shortTermTokenBudget: z.number().int().default(2000),
    longTermTokenBudget: z.number().int().default(1500),
    workingContextTokenBudget: z.number().int().default(1000),
  }).default(() => ({
    shortTermMessageLimit: 50,
    shortTermMsgCharLimit: 1000,
    shortTermTokenBudget: 2000,
    longTermTokenBudget: 1500,
    workingContextTokenBudget: 1000,
  })),

  slack: z.object({
    botToken: z.string().optional(),
    appToken: z.string().optional(),
    userToken: z.string().optional(),
    accumulationWindows: z.object({
      snappy: z.number().int().default(2000),
      patient: z.number().int().default(4000),
      waitForMe: z.number().int().default(15_000),
    }).default(() => ({ snappy: 2000, patient: 4000, waitForMe: 15_000 })),
    hardCapMs: z.number().int().default(30_000),
    typingGraceMs: z.number().int().default(4000),
    progressDelayMs: z.number().int().default(20_000),
    progressStaleIntervalMs: z.number().int().default(60_000),
  }).default(() => ({
    accumulationWindows: { snappy: 2000, patient: 4000, waitForMe: 15_000 },
    hardCapMs: 30_000,
    typingGraceMs: 4000,
    progressDelayMs: 20_000,
    progressStaleIntervalMs: 60_000,
  })),

  memory: z.object({
    consolidationIntervalHours: z.number().default(24),
    workingContextArchiveDays: z.number().int().default(14),
    decayThresholdDays30: z.number().int().default(30),
    decayThresholdDays90: z.number().int().default(90),
    archiveThreshold: z.number().default(1),
    mergeSimilarityThreshold: z.number().default(0.85),
    reflectionThreshold: z.number().int().default(50),
  }).default(() => ({
    consolidationIntervalHours: 24,
    workingContextArchiveDays: 14,
    decayThresholdDays30: 30,
    decayThresholdDays90: 90,
    archiveThreshold: 1,
    mergeSimilarityThreshold: 0.85,
    reflectionThreshold: 50,
  })),

  drive: z.object({
    syncBatchSize: z.number().int().default(10),
    maxFileSizeBytes: z.number().int().default(50 * 1024 * 1024),
    maxExtractedChars: z.number().int().default(10_000),
  }).default(() => ({
    syncBatchSize: 10,
    maxFileSizeBytes: 50 * 1024 * 1024,
    maxExtractedChars: 10_000,
  })),

  fireflies: z.object({
    syncIntervalHours: z.number().default(6),
    maxTranscriptsPerSync: z.number().int().default(20),
    defaultDaysBack: z.number().int().default(7),
  }).default(() => ({
    syncIntervalHours: 6,
    maxTranscriptsPerSync: 20,
    defaultDaysBack: 7,
  })),
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
    google: {},
    github: {},
    agent: { maxTurns: 30, timeoutMs: 600_000 },
    context: {
      shortTermMessageLimit: 50,
      shortTermMsgCharLimit: 1000,
      shortTermTokenBudget: 2000,
      longTermTokenBudget: 1500,
      workingContextTokenBudget: 1000,
    },
    slack: {
      accumulationWindows: { snappy: 2000, patient: 4000, waitForMe: 15_000 },
      hardCapMs: 30_000,
      typingGraceMs: 4000,
      progressDelayMs: 20_000,
      progressStaleIntervalMs: 60_000,
    },
    memory: {
      consolidationIntervalHours: 24,
      workingContextArchiveDays: 14,
      decayThresholdDays30: 30,
      decayThresholdDays90: 90,
      archiveThreshold: 1,
      mergeSimilarityThreshold: 0.85,
      reflectionThreshold: 50,
    },
    drive: {
      syncBatchSize: 10,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxExtractedChars: 10_000,
    },
    fireflies: {
      syncIntervalHours: 6,
      maxTranscriptsPerSync: 20,
      defaultDaysBack: 7,
    },
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
  if (process.env.TRUST_LEVEL) envConfig.trustLevel = Number(process.env.TRUST_LEVEL);
  if (process.env.GOOGLE_AGENT_EMAIL) {
    envConfig.google = { ...(envConfig.google as Record<string, unknown> ?? {}), agentEmail: process.env.GOOGLE_AGENT_EMAIL };
  }

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
