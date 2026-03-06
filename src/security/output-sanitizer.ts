/**
 * Output Sanitizer
 *
 * Scans ALL outbound content (emails, Slack messages, file shares) for
 * leaked secrets before sending. This is a critical safety net — even if
 * the agent somehow includes a secret in its response, this catches it.
 */

export interface ScanResult {
  hasSecrets: boolean;
  matches: SecretMatch[];
  redacted: string;
}

export interface SecretMatch {
  type: string;
  index: number;
  length: number;
}

// Secret detection patterns
const SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  // API Keys
  { name: 'anthropic_key', pattern: /sk-ant-[a-zA-Z0-9_-]{20,}/g },
  { name: 'openai_key', pattern: /sk-[a-zA-Z0-9]{20,}/g },
  { name: 'generic_api_key', pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*['"]?[a-zA-Z0-9_-]{20,}['"]?/gi },

  // Slack tokens
  { name: 'slack_bot_token', pattern: /xoxb-[0-9]+-[0-9A-Za-z-]+/g },
  { name: 'slack_user_token', pattern: /xoxp-[0-9]+-[0-9A-Za-z-]+/g },
  { name: 'slack_app_token', pattern: /xapp-[0-9]+-[0-9A-Za-z-]+/g },

  // Google
  { name: 'google_oauth', pattern: /ya29\.[0-9A-Za-z_-]+/g },

  // GitHub
  { name: 'github_pat', pattern: /ghp_[a-zA-Z0-9]{36}/g },
  { name: 'github_fine_grained', pattern: /github_pat_[a-zA-Z0-9]{22}_[a-zA-Z0-9]{59}/g },

  // AWS
  { name: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/g },
  { name: 'aws_secret_key', pattern: /(?:aws)?_?secret_?(?:access)?_?key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/gi },

  // Passwords
  { name: 'password', pattern: /(?:password|passwd|pwd)\s*[=:]\s*['"]?[^\s'"]{8,}['"]?/gi },

  // Private keys
  { name: 'private_key', pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----/g },

  // SSN
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },

  // Credit card numbers (basic Luhn-candidate patterns)
  { name: 'credit_card', pattern: /\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13}|6(?:011|5[0-9]{2})[0-9]{12})\b/g },
];

/**
 * Scan a string for potential secrets/PII.
 * Returns a redacted version with secrets replaced by [REDACTED:type].
 */
export function scanForSecrets(content: string): ScanResult {
  const matches: SecretMatch[] = [];
  let redacted = content;

  for (const { name, pattern } of SECRET_PATTERNS) {
    // Reset regex state
    pattern.lastIndex = 0;

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      matches.push({
        type: name,
        index: match.index,
        length: match[0].length,
      });
    }

    // Redact in the output string
    redacted = redacted.replace(pattern, `[REDACTED:${name}]`);
  }

  return {
    hasSecrets: matches.length > 0,
    matches,
    redacted,
  };
}

/**
 * Assert that content is safe to send outbound.
 * Throws if secrets are detected.
 */
export function assertNoSecrets(content: string, context: string): void {
  const result = scanForSecrets(content);
  if (result.hasSecrets) {
    const types = [...new Set(result.matches.map(m => m.type))];
    throw new Error(
      `Output sanitizer blocked ${context}: detected ${types.join(', ')}. ` +
      `${result.matches.length} secret(s) found and redacted.`,
    );
  }
}
