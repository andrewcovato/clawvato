import { describe, it, expect } from 'vitest';
import { validatePath } from '../../src/security/path-validator.js';

const SANDBOX_ROOTS = ['/Users/test/Documents', '/Users/test/Projects'];

describe('path-validator', () => {
  it('allows paths within sandbox', () => {
    const result = validatePath('/Users/test/Documents/report.pdf', SANDBOX_ROOTS);
    expect(result.allowed).toBe(true);
  });

  it('allows nested paths within sandbox', () => {
    const result = validatePath('/Users/test/Projects/app/src/index.ts', SANDBOX_ROOTS);
    expect(result.allowed).toBe(true);
  });

  it('blocks paths outside sandbox', () => {
    const result = validatePath('/Users/test/Desktop/notes.txt', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('outside all sandbox roots');
  });

  it('blocks .ssh directory', () => {
    const result = validatePath('/Users/test/Documents/.ssh/id_rsa', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('forbidden pattern');
  });

  it('blocks .env files', () => {
    const result = validatePath('/Users/test/Projects/app/.env', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
  });

  it('blocks .env.local files', () => {
    const result = validatePath('/Users/test/Projects/app/.env.local', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
  });

  it('blocks credential files', () => {
    const result = validatePath('/Users/test/Documents/credentials.json', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
  });

  it('blocks .pem key files', () => {
    const result = validatePath('/Users/test/Documents/server.pem', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
  });

  it('blocks /etc paths', () => {
    const result = validatePath('/etc/passwd', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
  });

  it('blocks dotfiles/dotdirs', () => {
    const result = validatePath('/Users/test/Documents/.config/something', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
  });

  it('blocks node_modules', () => {
    const result = validatePath('/Users/test/Projects/app/node_modules/pkg/index.js', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
  });

  it('fails when no sandbox roots configured', () => {
    const result = validatePath('/Users/test/Documents/ok.txt', []);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('No sandbox roots configured');
  });

  it('resolves relative path components', () => {
    // Attempting directory traversal
    const result = validatePath('/Users/test/Documents/../.ssh/id_rsa', SANDBOX_ROOTS);
    expect(result.allowed).toBe(false);
  });
});
