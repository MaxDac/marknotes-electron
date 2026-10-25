import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('DROPBOX_APP_KEY', undefined);
  vi.stubEnv('MSAL_CLIENT_ID', undefined);
  vi.stubGlobal('__DROPBOX_APP_KEY__', undefined);
  vi.stubGlobal('__MSAL_CLIENT_ID__', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('public cloud provider registrations', () => {
  // The first import of the connector registry transforms the provider SDKs, which can exceed the default timeout on a
  // busy machine.
  it(
    'enables real connectors without environment or build-time registration values',
    { timeout: 30_000 },
    async () => {
      const { DROPBOX_APP_KEY, MSAL_CLIENT_ID } = await import('../src/main/config');
      expect(DROPBOX_APP_KEY).toBe('sdjefhss3elcfp3');
      expect(MSAL_CLIENT_ID).toBe('eb2e8605-a611-4b3d-a087-31a9c2ae4945');

      const { createConnectors } = await import('../src/main/connectors/registry');
      const connectors = createConnectors({
        vault: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
        openExternal: vi.fn(),
      });
      expect(connectors.dropbox.unavailableReason()).toBeNull();
      expect(connectors.onedrive.unavailableReason()).toBeNull();
    },
  );

  it('falls back to the public registrations for empty build and environment values', async () => {
    vi.stubEnv('DROPBOX_APP_KEY', '');
    vi.stubEnv('MSAL_CLIENT_ID', '');
    vi.stubGlobal('__DROPBOX_APP_KEY__', '');
    vi.stubGlobal('__MSAL_CLIENT_ID__', '');
    const config = await import('../src/main/config');
    expect(config.DROPBOX_APP_KEY).toBe('sdjefhss3elcfp3');
    expect(config.MSAL_CLIENT_ID).toBe('eb2e8605-a611-4b3d-a087-31a9c2ae4945');
  });

  it('allows build-time registrations to override the defaults', async () => {
    vi.stubGlobal('__DROPBOX_APP_KEY__', 'build-dropbox');
    vi.stubGlobal('__MSAL_CLIENT_ID__', 'build-microsoft');
    const config = await import('../src/main/config');
    expect(config.DROPBOX_APP_KEY).toBe('build-dropbox');
    expect(config.MSAL_CLIENT_ID).toBe('build-microsoft');
  });

  it('prefers runtime environment registrations over build-time values', async () => {
    vi.stubGlobal('__DROPBOX_APP_KEY__', 'build-dropbox');
    vi.stubGlobal('__MSAL_CLIENT_ID__', 'build-microsoft');
    vi.stubEnv('DROPBOX_APP_KEY', 'runtime-dropbox');
    vi.stubEnv('MSAL_CLIENT_ID', 'runtime-microsoft');
    const config = await import('../src/main/config');
    expect(config.DROPBOX_APP_KEY).toBe('runtime-dropbox');
    expect(config.MSAL_CLIENT_ID).toBe('runtime-microsoft');
  });
});
