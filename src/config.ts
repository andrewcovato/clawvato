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
    reasoner: z.string().default('claude-opus-4-6'),
  }).default(() => ({
    classifier: 'claude-haiku-4-5-20251001',
    planner: 'claude-opus-4-6',
    executor: 'claude-sonnet-4-6',
    reasoner: 'claude-opus-4-6',
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
    timeoutMs: z.number().int().min(10_000).default(1_200_000),
    fastPathMaxTurns: z.number().int().min(1).default(10),
    fastPathTimeoutMs: z.number().int().min(1_000).default(60_000),
    fastPathMaxTokens: z.number().int().min(100).default(4096),
    deepPathMaxTurns: z.number().int().min(1).default(200),
    classifierMaxTokens: z.number().int().min(10).default(100),
    interruptPollMs: z.number().int().min(500).default(2000),
    preflightReminderMs: z.number().int().min(10_000).default(300_000),
  }).default(() => ({
    maxTurns: 30,
    timeoutMs: 1_200_000,
    fastPathMaxTurns: 10,
    fastPathTimeoutMs: 60_000,
    fastPathMaxTokens: 4096,
    deepPathMaxTurns: 200,
    classifierMaxTokens: 100,
    interruptPollMs: 2000,
    preflightReminderMs: 300_000,
  })),

  context: z.object({
    shortTermMessageLimit: z.number().int().default(50),
    shortTermMsgCharLimit: z.number().int().default(1000),
    shortTermTokenBudget: z.number().int().default(8000),
    longTermTokenBudget: z.number().int().default(1500),
    workingContextTokenBudget: z.number().int().default(1000),
    deepPathLongTermTokenBudget: z.number().int().default(50000),
    deepPathWorkingContextTokenBudget: z.number().int().default(10000),
  }).default(() => ({
    shortTermMessageLimit: 50,
    shortTermMsgCharLimit: 1000,
    shortTermTokenBudget: 8000,
    longTermTokenBudget: 1500,
    workingContextTokenBudget: 1000,
    deepPathLongTermTokenBudget: 50000,
    deepPathWorkingContextTokenBudget: 10000,
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
    interruptConfidenceThreshold: z.number().min(0).max(1).default(0.7),
  }).default(() => ({
    accumulationWindows: { snappy: 2000, patient: 4000, waitForMe: 15_000 },
    hardCapMs: 30_000,
    typingGraceMs: 4000,
    progressDelayMs: 20_000,
    progressStaleIntervalMs: 60_000,
    interruptConfidenceThreshold: 0.7,
  })),

  memory: z.object({
    consolidationIntervalHours: z.number().default(24),
    workingContextArchiveDays: z.number().int().default(14),
    decayThresholdDays30: z.number().int().default(30),
    decayThresholdDays90: z.number().int().default(90),
    archiveThreshold: z.number().default(1),
    mergeSimilarityThreshold: z.number().default(0.85),
    reflectionThreshold: z.number().int().default(50),
    extractionMaxTokens: z.number().int().default(16000),
    reflectionMaxTokens: z.number().int().default(1000),
    extractionContentMaxChars: z.number().int().min(0).default(2000),
    categoryFuzzyThreshold: z.number().min(0).max(1).default(0.8),
    rerankEnabled: z.boolean().default(true),
    rerankMaxCandidates: z.number().int().min(1).default(10),
    rerankModel: z.string().default('Xenova/ms-marco-MiniLM-L-6-v2'),
    rerankTopK: z.number().int().min(1).default(15),
    decayExemptCategories: z.array(z.string()).default(['preference', 'commitment']),
    archiveExemptCategories: z.array(z.string()).default(['preference', 'commitment', 'reflection']),
    categoryReorgIntervalHours: z.number().default(168),
    consolidationBatchSize: z.number().int().min(10).default(150),
    consolidationCheckIntervalHours: z.number().min(1).default(6),
    embeddingModel: z.string().default('nomic-ai/nomic-embed-text-v1.5'),
    domainBoostFactor: z.number().min(1).max(3).default(1.3),
    surfaceBoostFactor: z.number().min(1).max(3).default(1.1),
    dedupEnabled: z.boolean().default(true),
    dedupSimilarityThreshold: z.number().min(0).max(1).default(0.7),
    dedupMaxCandidates: z.number().int().min(1).default(5),
  }).default(() => ({
    consolidationIntervalHours: 24,
    workingContextArchiveDays: 14,
    decayThresholdDays30: 30,
    decayThresholdDays90: 90,
    archiveThreshold: 1,
    mergeSimilarityThreshold: 0.85,
    reflectionThreshold: 50,
    extractionMaxTokens: 16000,
    reflectionMaxTokens: 1000,
    extractionContentMaxChars: 2000,
    categoryFuzzyThreshold: 0.8,
    rerankEnabled: true,
    rerankMaxCandidates: 10,
    rerankModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
    rerankTopK: 15,
    decayExemptCategories: ['preference', 'commitment'],
    archiveExemptCategories: ['preference', 'commitment', 'reflection'],
    categoryReorgIntervalHours: 168,
    consolidationBatchSize: 150,
    consolidationCheckIntervalHours: 6,
    embeddingModel: 'nomic-ai/nomic-embed-text-v1.5',
    domainBoostFactor: 1.3,
    surfaceBoostFactor: 1.1,
    dedupEnabled: true,
    dedupSimilarityThreshold: 0.7,
    dedupMaxCandidates: 5,
  })),

  tasks: z.object({
    channelId: z.string().optional(),
    schedulerPollMs: z.number().int().min(10_000).default(60_000),
    allowSelfAssignment: z.boolean().default(true),
    autoApproveAgentTasks: z.boolean().default(false),
    reminderDelayMs: z.number().int().default(3_600_000),
    maxConcurrentTasks: z.number().int().min(1).default(1),
    taskExecutionTimeoutMs: z.number().int().default(300_000),
  }).default(() => ({
    schedulerPollMs: 60_000,
    allowSelfAssignment: true,
    autoApproveAgentTasks: false,
    reminderDelayMs: 3_600_000,
    maxConcurrentTasks: 1,
    taskExecutionTimeoutMs: 300_000,
  })),

  drive: z.object({
    syncBatchSize: z.number().int().default(10),
    maxFileSizeBytes: z.number().int().default(50 * 1024 * 1024),
    maxExtractedChars: z.number().int().default(50_000),
  }).default(() => ({
    syncBatchSize: 10,
    maxFileSizeBytes: 50 * 1024 * 1024,
    maxExtractedChars: 50_000,
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

  sweeps: z.object({
    enabled: z.boolean().default(true),
    cron: z.string().default('every 6 hours'),
    slack: z.object({
      enabled: z.boolean().default(true),
      excludeChannels: z.array(z.string()).default([]),
      maxMessagesPerChannel: z.number().int().default(500),
    }).default(() => ({
      enabled: true,
      excludeChannels: [],
      maxMessagesPerChannel: 500,
    })),
    gmail: z.object({
      enabled: z.boolean().default(true),
      maxThreads: z.number().int().default(2000),
    }).default(() => ({
      enabled: true,
      maxThreads: 2000,
    })),
    fireflies: z.object({
      enabled: z.boolean().default(true),
      maxMeetings: z.number().int().default(100),
    }).default(() => ({
      enabled: true,
      maxMeetings: 100,
    })),
    drive: z.object({
      enabled: z.boolean().default(true),
      maxFiles: z.number().int().default(500),
    }).default(() => ({
      enabled: true,
      maxFiles: 500,
    })),
  }).default(() => ({
    enabled: true,
    cron: 'every 6 hours',
    slack: { enabled: true, excludeChannels: [], maxMessagesPerChannel: 500 },
    gmail: { enabled: true, maxThreads: 2000 },
    fireflies: { enabled: true, maxMeetings: 100 },
    drive: { enabled: true, maxFiles: 500 },
  })),

  trainingWheels: z.object({
    graduationThreshold: z.number().int().min(1).default(10),
    maxRejectionRate: z.number().min(0).max(1).default(0.05),
    recentWindow: z.number().int().min(1).default(5),
  }).default(() => ({
    graduationThreshold: 10,
    maxRejectionRate: 0.05,
    recentWindow: 5,
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
      reasoner: 'claude-opus-4-6',
    },
    rateLimits: {
      actionsPerMinute: 30,
      emailsPerHour: 20,
      fileSharesPerHour: 50,
    },
    sandboxRoots: [],
    google: {},
    github: {},
    agent: {
      maxTurns: 30,
      timeoutMs: 1_200_000,
      fastPathMaxTurns: 10,
      fastPathTimeoutMs: 60_000,
      fastPathMaxTokens: 4096,
      deepPathMaxTurns: 200,
      classifierMaxTokens: 100,
      interruptPollMs: 2000,
      preflightReminderMs: 300_000,
    },
    context: {
      shortTermMessageLimit: 50,
      shortTermMsgCharLimit: 1000,
      shortTermTokenBudget: 8000,
      longTermTokenBudget: 1500,
      workingContextTokenBudget: 1000,
      deepPathLongTermTokenBudget: 50000,
      deepPathWorkingContextTokenBudget: 10000,
    },
    slack: {
      accumulationWindows: { snappy: 2000, patient: 4000, waitForMe: 15_000 },
      hardCapMs: 30_000,
      typingGraceMs: 4000,
      progressDelayMs: 20_000,
      progressStaleIntervalMs: 60_000,
      interruptConfidenceThreshold: 0.7,
    },
    memory: {
      consolidationIntervalHours: 24,
      workingContextArchiveDays: 14,
      decayThresholdDays30: 30,
      decayThresholdDays90: 90,
      archiveThreshold: 1,
      mergeSimilarityThreshold: 0.85,
      reflectionThreshold: 50,
      extractionMaxTokens: 16000,
      reflectionMaxTokens: 1000,
      extractionContentMaxChars: 2000,
      categoryFuzzyThreshold: 0.8,
      rerankEnabled: true,
      rerankMaxCandidates: 10,
      rerankModel: 'Xenova/ms-marco-MiniLM-L-6-v2',
      rerankTopK: 15,
      decayExemptCategories: ['preference', 'commitment'],
      archiveExemptCategories: ['preference', 'commitment', 'reflection'],
      categoryReorgIntervalHours: 168,
      consolidationBatchSize: 150,
      consolidationCheckIntervalHours: 6,
      embeddingModel: 'nomic-ai/nomic-embed-text-v1.5',
      domainBoostFactor: 1.3,
      surfaceBoostFactor: 1.1,
      dedupEnabled: true,
      dedupSimilarityThreshold: 0.7,
      dedupMaxCandidates: 5,
    },
    tasks: {
      channelId: process.env.TASK_CHANNEL_ID,
      schedulerPollMs: 60_000,
      allowSelfAssignment: true,
      autoApproveAgentTasks: false,
      reminderDelayMs: 3_600_000,
      maxConcurrentTasks: 1,
      taskExecutionTimeoutMs: 300_000,
    },
    drive: {
      syncBatchSize: 10,
      maxFileSizeBytes: 50 * 1024 * 1024,
      maxExtractedChars: 50_000,
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
  // Map Slack tokens from env so security validation can detect them
  if (process.env.SLACK_BOT_TOKEN || process.env.SLACK_APP_TOKEN) {
    const slackOverrides: Record<string, unknown> = {};
    if (process.env.SLACK_BOT_TOKEN) slackOverrides.botToken = process.env.SLACK_BOT_TOKEN;
    if (process.env.SLACK_APP_TOKEN) slackOverrides.appToken = process.env.SLACK_APP_TOKEN;
    envConfig.slack = { ...(envConfig.slack as Record<string, unknown> ?? {}), ...slackOverrides };
  }

  // Merge: defaults < file < env < overrides
  const merged = { ...defaults, ...fileConfig, ...envConfig, ...overrides };

  currentConfig = ConfigSchema.parse(merged);

  // Security: ownerSlackUserId is required when Slack is configured
  const hasSlackTokens = currentConfig.slack.botToken || currentConfig.slack.appToken;
  if (hasSlackTokens && !currentConfig.ownerSlackUserId) {
    throw new Error(
      'OWNER_SLACK_USER_ID must be set when Slack tokens are configured. ' +
      'Without it, sender verification cannot enforce single-principal authority.',
    );
  }

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
  writeFileSync(configPath, JSON.stringify(config, null, 2), { encoding: 'utf-8', mode: 0o600 });
  currentConfig = config;
}

export function updateConfig(updates: Partial<ClawvatoConfig>): ClawvatoConfig {
  const config = getConfig();
  const updated = ConfigSchema.parse({ ...config, ...updates });
  saveConfig(updated);
  return updated;
}
