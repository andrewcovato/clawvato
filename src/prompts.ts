/**
 * Prompt Loader — loads prompt templates from config/prompts/ and resolves variables.
 *
 * Prompts are Markdown files with {{VARIABLE}} placeholders. Variables are resolved
 * at load time from a known registry. The loader validates that all placeholders
 * are resolved — unresolved placeholders cause a startup failure.
 *
 * HTML comments (<!-- ... -->) are stripped from the output since they're
 * documentation for prompt editors, not content for the model.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';

// ── Variable registry ──

/** Sentinel value — if Claude responds with this, we stay silent */
const NO_RESPONSE = '[NO_RESPONSE]';

/** All known template variables and their values */
const TEMPLATE_VARIABLES: Record<string, string> = {
  NO_RESPONSE,
};

// ── Prompt file paths ──

/**
 * Resolve the prompts directory. Checks multiple locations to handle
 * both development (project root) and production (dist/) layouts.
 */
function getPromptsDir(): string {
  // Try relative to this file's location (works in both src/ and dist/)
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(thisDir, '..', 'config', 'prompts'),   // from src/ or dist/
    join(thisDir, '..', '..', 'config', 'prompts'), // from dist/subfolder
    join(process.cwd(), 'config', 'prompts'),    // from project root
  ];

  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }

  throw new Error(`Prompts directory not found. Checked: ${candidates.join(', ')}`);
}

// ── Template resolution ──

/**
 * Replace all {{VARIABLE}} placeholders with their values.
 * Throws if any placeholders remain unresolved.
 */
function resolveTemplate(template: string, fileName: string): string {
  let result = template;

  // Strip HTML comments (documentation for editors, not for the model)
  result = result.replace(/<!--[\s\S]*?-->\n*/g, '');

  // Replace known variables
  for (const [key, value] of Object.entries(TEMPLATE_VARIABLES)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }

  // Check for unresolved placeholders
  const unresolved = result.match(/\{\{[A-Z_]+\}\}/g);
  if (unresolved) {
    throw new Error(
      `Unresolved template variables in ${fileName}: ${unresolved.join(', ')}. ` +
      `Known variables: ${Object.keys(TEMPLATE_VARIABLES).join(', ')}`
    );
  }

  return result.trim();
}

// ── Prompt loading ──

interface LoadedPrompts {
  system: string;
  summary: string;
  docExtraction: string;
  extraction: string;
  reflection: string;
  interruptClassification: string;
  meetingExtraction: string;
  emailExtraction: string;
}

let cachedPrompts: LoadedPrompts | null = null;

/**
 * Load and validate all prompts from config/prompts/.
 * Called once at startup. Results are cached for the lifetime of the process.
 * Throws on missing files or unresolved template variables.
 */
export function loadPrompts(): LoadedPrompts {
  if (cachedPrompts) return cachedPrompts;

  const dir = getPromptsDir();
  logger.info({ dir }, 'Loading prompts');

  const files: Record<keyof LoadedPrompts, string> = {
    system: 'system.md',
    summary: 'summary.md',
    docExtraction: 'doc-extraction.md',
    extraction: 'extraction.md',
    reflection: 'reflection.md',
    interruptClassification: 'interrupt-classification.md',
    meetingExtraction: 'meeting-extraction.md',
    emailExtraction: 'email-extraction.md',
  };

  const loaded: Partial<LoadedPrompts> = {};

  for (const [key, fileName] of Object.entries(files)) {
    const filePath = join(dir, fileName);
    if (!existsSync(filePath)) {
      throw new Error(`Required prompt file missing: ${filePath}`);
    }
    const raw = readFileSync(filePath, 'utf-8');
    loaded[key as keyof LoadedPrompts] = resolveTemplate(raw, fileName);
  }

  cachedPrompts = loaded as LoadedPrompts;
  logger.info({ promptCount: Object.keys(files).length }, 'Prompts loaded successfully');
  return cachedPrompts;
}

/**
 * Get cached prompts. Throws if loadPrompts() hasn't been called yet.
 */
export function getPrompts(): LoadedPrompts {
  if (!cachedPrompts) {
    return loadPrompts();
  }
  return cachedPrompts;
}

/**
 * Re-export NO_RESPONSE so consumers don't need to hardcode it.
 */
export { NO_RESPONSE };
