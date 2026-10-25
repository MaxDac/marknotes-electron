import { describe, expect, it, vi } from 'vitest';
import { DropboxConnector } from '../src/main/connectors/dropbox';
import { OneDriveConnector } from '../src/main/connectors/onedrive';
import { ProtonConnector } from '../src/main/connectors/proton';
import type { DriveConnector } from '../src/main/connectors/types';
import { MemorySecretVault } from '../src/main/vault';
import type { DriveAccount, DriveProvider } from '../src/shared/types';

const credential = (provider: DriveProvider, identity: string, token: string) => {
  switch (provider) {
    case 'dropbox':
      return JSON.stringify({
        accountId: identity,
        accessToken: token,
        refreshToken: token,
        expiresAt: Date.now() + 3600_000,
      });
    case 'onedrive':
      return JSON.stringify({ homeAccountId: identity, cache: token });
    case 'proton':
      return JSON.stringify({
        userId: identity,
        uid: token,
        accessToken: token,
        refreshToken: token,
        username: 'same@email.test',
        keyPassphrases: { key: token },
      });
  }
};

describe.each(['dropbox', 'onedrive', 'proton'] as const)('%s credential replacement', (provider) => {
  const setup = async (identity = 'same') => {
    const vault = new MemorySecretVault();
    await vault.set('original', credential(provider, 'same', 'old'));
    await vault.set('staged', credential(provider, identity, 'fresh'));
    const connectors: Record<DriveProvider, DriveConnector> = {
      dropbox: new DropboxConnector({ vault, appKey: 'app', openExternal: async () => {} }),
      onedrive: new OneDriveConnector({ vault, clientId: 'app', openExternal: async () => {} }),
      proton: new ProtonConnector({ vault, fetch: async () => new Response('{"Code":1000}') }),
    };
    const drive: DriveAccount = {
      id: 'original',
      provider,
      label: 'same@email.test',
      remoteFolder: 'Folder',
      createRootFolder: false,
      rootFolderName: 'Keep',
    };
    const staged = { id: 'staged', provider, label: drive.label, providerAccountId: identity };
    return { vault, connector: connectors[provider], drive, staged };
  };

  it('validates immutable identity rather than the matching display label', async () => {
    const { vault, connector, drive, staged } = await setup('different');
    const before = new Map(vault.data);
    await expect(connector.replaceCredentials!(drive, staged)).rejects.toThrow(/same .* account/);
    expect(vault.data).toEqual(before);
  });

  it('keeps original credentials when the atomic vault write fails', async () => {
    const { vault, connector, drive, staged } = await setup();
    const before = await vault.get(drive.id);
    vi.spyOn(vault, 'set').mockRejectedValue(new Error('Disk full'));
    await expect(connector.replaceCredentials!(drive, staged)).rejects.toThrow('Disk full');
    expect(await vault.get(drive.id)).toBe(before);
  });

  it('can reconnect after credentials expire/disappear when the drive has a pinned identity', async () => {
    const { vault, connector, drive, staged } = await setup();
    const fresh = await vault.get(staged.id);
    await vault.delete(drive.id);
    await connector.replaceCredentials!({ ...drive, providerAccountId: 'same' }, staged);
    expect(JSON.parse((await vault.get(drive.id))!)).toEqual(JSON.parse(fresh!));
    expect(await vault.get(staged.id)).toBeNull();
  });
});

describe('proton credential replacement', () => {
  it('logs out the replaced session', async () => {
    const vault = new MemorySecretVault();
    await vault.set('proton:same', credential('proton', 'same', 'old'));
    await vault.set('staged', credential('proton', 'same', 'fresh'));
    const requests: { url: string; method?: string; uid: string | null }[] = [];
    const connector = new ProtonConnector({
      vault,
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          uid: new Headers(init?.headers).get('x-pm-uid'),
        });
        return new Response('{"Code":1000}');
      },
    });
    await connector.replaceCredentials(
      {
        id: 'proton:same',
        provider: 'proton',
        label: 'same@email.test',
        remoteFolder: '',
        createRootFolder: false,
        rootFolderName: 'Notes',
      },
      { id: 'staged', provider: 'proton', label: 'same@email.test', providerAccountId: 'same' },
    );
    expect(requests).toEqual([expect.objectContaining({ method: 'DELETE', uid: 'old' })]);
    expect(requests[0].url).toMatch(/\/core\/v4\/auth$/);
    expect(JSON.parse((await vault.get('proton:same'))!).uid).toBe('fresh');
  });
});
