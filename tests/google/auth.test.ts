/**
 * Tests for Google OAuth2 authentication module.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock credentials module
vi.mock('../../src/credentials.js', () => ({
  getCredential: vi.fn(),
}));

// Mock googleapis
vi.mock('googleapis', () => {
  const mockOAuth2Instance = {
    setCredentials: vi.fn(),
    getAccessToken: vi.fn(),
  };
  const MockOAuth2 = vi.fn(() => mockOAuth2Instance);
  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      _mockOAuth2Instance: mockOAuth2Instance,
    },
  };
});

import { getCredential } from '../../src/credentials.js';
import { google } from 'googleapis';

// We need to re-import the module fresh each test to reset the cached oauth2Client
// Since it's a module-level let, we use dynamic import + resetModules
describe('Google Auth', () => {
  const mockGetCredential = vi.mocked(getCredential);
  const mockOAuth2Instance = (google as any)._mockOAuth2Instance;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module-level oauth2Client by re-importing
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when credentials are missing', async () => {
    mockGetCredential.mockResolvedValue(null);

    // Dynamic import to get fresh module state
    const { getGoogleAuth } = await import('../../src/google/auth.js');
    const result = await getGoogleAuth();

    expect(result).toBeNull();
    expect(mockGetCredential).toHaveBeenCalledWith('google-client-id');
    expect(mockGetCredential).toHaveBeenCalledWith('google-client-secret');
    expect(mockGetCredential).toHaveBeenCalledWith('google-refresh-token');
  });

  it('returns null when only some credentials are present', async () => {
    mockGetCredential.mockImplementation(async (key) => {
      if (key === 'google-client-id') return 'some-id';
      return null;
    });

    const { getGoogleAuth } = await import('../../src/google/auth.js');
    const result = await getGoogleAuth();

    expect(result).toBeNull();
  });

  it('creates OAuth2 client when all credentials are present', async () => {
    mockGetCredential.mockImplementation(async (key) => {
      if (key === 'google-client-id') return 'test-client-id';
      if (key === 'google-client-secret') return 'test-client-secret';
      if (key === 'google-refresh-token') return 'test-refresh-token';
      return null;
    });
    mockOAuth2Instance.getAccessToken.mockResolvedValue({ token: 'access-token' });

    const { getGoogleAuth } = await import('../../src/google/auth.js');
    const result = await getGoogleAuth();

    expect(result).not.toBeNull();
    expect(mockOAuth2Instance.setCredentials).toHaveBeenCalledWith({ refresh_token: 'test-refresh-token' });
    expect(mockOAuth2Instance.getAccessToken).toHaveBeenCalled();
  });

  it('returns null when token refresh fails', async () => {
    mockGetCredential.mockImplementation(async (key) => {
      if (key === 'google-client-id') return 'test-client-id';
      if (key === 'google-client-secret') return 'test-client-secret';
      if (key === 'google-refresh-token') return 'test-refresh-token';
      return null;
    });
    mockOAuth2Instance.getAccessToken.mockRejectedValue(new Error('Token expired'));

    const { getGoogleAuth } = await import('../../src/google/auth.js');
    const result = await getGoogleAuth();

    expect(result).toBeNull();
  });

  describe('hasGoogleCredentials', () => {
    it('returns true when client-id and refresh-token are present', async () => {
      mockGetCredential.mockImplementation(async (key) => {
        if (key === 'google-client-id') return 'id';
        if (key === 'google-refresh-token') return 'token';
        return null;
      });

      const { hasGoogleCredentials } = await import('../../src/google/auth.js');
      const result = await hasGoogleCredentials();

      expect(result).toBe(true);
    });

    it('returns false when credentials are missing', async () => {
      mockGetCredential.mockResolvedValue(null);

      const { hasGoogleCredentials } = await import('../../src/google/auth.js');
      const result = await hasGoogleCredentials();

      expect(result).toBe(false);
    });
  });
});
