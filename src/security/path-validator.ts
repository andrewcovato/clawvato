import { resolve, normalize } from 'node:path';

export interface PathValidationResult {
  allowed: boolean;
  reason?: string;
  resolvedPath?: string;
}

// Patterns that are NEVER accessible regardless of sandbox config
const FORBIDDEN_PATTERNS: RegExp[] = [
  /\.ssh/i,
  /\.gnupg/i,
  /\.aws/i,
  /\.kube/i,
  /\.docker/i,
  /\/\.[^/]+/,           // Any dotfile/dotdir at any level
  /\.env(\.[^/]*)?$/i,   // .env, .env.local, .env.production, etc.
  /credentials/i,
  /secrets?\b/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /\/etc\//i,
  /\/System\//i,
  /\/Library\/Keychains/i,
  /node_modules/i,
];

/**
 * Validate that a filesystem path is within the sandbox and doesn't match forbidden patterns.
 *
 * Defense-in-depth: even though we use the official filesystem MCP server with
 * configured roots, this PreToolUse hook provides a second layer of validation.
 */
export function validatePath(
  inputPath: string,
  sandboxRoots: string[],
): PathValidationResult {
  // Resolve to absolute path (handles .., symlinks, etc.)
  const resolvedPath = resolve(normalize(inputPath));

  // Check forbidden patterns first
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(resolvedPath)) {
      return {
        allowed: false,
        reason: `Path matches forbidden pattern: ${pattern.source}`,
        resolvedPath,
      };
    }
  }

  // Check that path is within a sandbox root
  if (sandboxRoots.length === 0) {
    return {
      allowed: false,
      reason: 'No sandbox roots configured. Set sandboxRoots in config.',
      resolvedPath,
    };
  }

  const inSandbox = sandboxRoots.some(root => {
    const resolvedRoot = resolve(normalize(root));
    return resolvedPath.startsWith(resolvedRoot + '/') || resolvedPath === resolvedRoot;
  });

  if (!inSandbox) {
    return {
      allowed: false,
      reason: `Path ${resolvedPath} is outside all sandbox roots`,
      resolvedPath,
    };
  }

  return { allowed: true, resolvedPath };
}
