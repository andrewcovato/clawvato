import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig, getConfig, updateConfig, saveConfig } from '../src/config.js';

describe('config', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'clawvato-config-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads with defaults', () => {
    const config = loadConfig({ dataDir: tmpDir });
    expect(config.logLevel).toBe('info');
    expect(config.trustLevel).toBe(0);
    expect(config.models.classifier).toBe('claude-haiku-4-5-20251001');
    expect(config.models.planner).toBe('claude-opus-4-6');
    expect(config.models.executor).toBe('claude-sonnet-4-6');
  });

  it('accepts overrides', () => {
    const config = loadConfig({ dataDir: tmpDir, trustLevel: 2 });
    expect(config.trustLevel).toBe(2);
  });

  it('saves and reloads', () => {
    const config = loadConfig({ dataDir: tmpDir });
    config.ownerSlackUserId = 'U12345TEST';
    saveConfig(config);

    // Reload from file
    const reloaded = loadConfig({ dataDir: tmpDir });
    expect(reloaded.ownerSlackUserId).toBe('U12345TEST');
  });

  it('validates trust level range', () => {
    expect(() => loadConfig({ dataDir: tmpDir, trustLevel: 5 })).toThrow();
    expect(() => loadConfig({ dataDir: tmpDir, trustLevel: -1 })).toThrow();
  });

  it('validates log level', () => {
    expect(() => loadConfig({ dataDir: tmpDir, logLevel: 'verbose' as any })).toThrow();
  });

  it('creates data directory if missing', () => {
    const nestedDir = join(tmpDir, 'nested', 'deep');
    const config = loadConfig({ dataDir: nestedDir });
    expect(config.dataDir).toBe(nestedDir);
  });
});
