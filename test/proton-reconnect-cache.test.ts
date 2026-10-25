import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { ProtonDriveClientParameters } from '../src/main/connectors/proton/sdk';
import { ProtonConnector } from '../src/main/connectors/proton';
import { FakeConnector } from '../src/main/connectors/fake';
import { DriveService } from '../src/main/driveService';
import { MemorySecretVault } from '../src/main/vault';

const { clients } = vi.hoisted(() => ({ clients: [] as ProtonDriveClientParameters[] }));

vi.mock('../src/main/connectors/proton/sdk', () => ({
  NodeType: { Folder: 'folder', File: 'file', Album: 'album' },
  DriveEventType: {},
  MemoryCache: class {},
  ProtonDriveClient: class {
    private token = '';
    constructor(private readonly params: ProtonDriveClientParameters) {
      clients.push(params);
    }
    async getMyFilesRootFolder() {
      const response = await this.params.httpClient.fetchJson({
        url: 'https://proton.test/root',
        method: 'GET',
        headers: new Headers(),
        timeoutMs: 1000,
      });
      this.token = (await response.json()).token;
      return { uid: 'root', treeEventScopeId: 'scope' };
    }
    async *iterateFolderChildren() {
      yield {
        uid: 'file',
        name: { ok: true, value: `${this.token}.md` },
        type: 'file',
        creationTime: new Date(0),
        modificationTime: new Date(0),
        activeRevision: { uid: 'rev', creationTime: new Date(0) },
      };
    }
    async *iterateEvents() {
      yield* [];
    }
  },
}));

it('replaces DriveService, SDK store and live Proton session caches, and restores the new session on restart', async () => {
  const vault = new MemorySecretVault();
  const session = (token: string) =>
    JSON.stringify({
      uid: token,
      userId: 'user',
      username: 'alice',
      accessToken: token,
      refreshToken: token,
      keyPassphrases: { key: token },
    });
  const fetchFn: typeof fetch = async (_input, init) =>
    new Response(
      JSON.stringify({
        token: new Headers(init?.headers).get('authorization')?.slice('Bearer '.length),
      }),
      { status: 200 },
    );
  const proton = new ProtonConnector({ vault, fetch: fetchFn, baseUrl: 'https://proton.test' });
  // Exercise the real service remember/commit paths without SRP (covered by proton-auth.test.ts).
  vi.spyOn(proton, 'login')
    .mockResolvedValueOnce({
      kind: 'signedIn',
      account: { id: 'proton:user', provider: 'proton', label: 'alice', providerAccountId: 'user' },
    })
    .mockResolvedValueOnce({
      kind: 'signedIn',
      account: { id: 'staged', provider: 'proton', label: 'alice', providerAccountId: 'user' },
    });
  await vault.set('proton:user', session('old'));
  const file = join(mkdtempSync(join(tmpdir(), 'marknotes-reconnect-')), 'drives.json');
  const connectors = {
    proton,
    dropbox: new FakeConnector('dropbox'),
    onedrive: new FakeConnector('onedrive'),
  };
  const service = new DriveService(file, connectors);
  await service.protonLogin('alice', 'password');
  const drive = await service.addDrive('proton:user', {
    remoteFolder: '',
    createRootFolder: false,
    rootFolderName: 'Kept',
  });
  expect(await service.remote(drive.id, { op: 'snapshot' })).toMatchObject([{ path: 'old.md' }]);
  const old = await service.store(drive.id);
  await vault.set('staged', session('fresh'));
  await service.protonLogin('alice', 'password', true);
  await service.reconnect(drive.id, 'staged');
  expect(await service.store(drive.id)).not.toBe(old);
  expect(await service.remote(drive.id, { op: 'snapshot' })).toMatchObject([{ path: 'fresh.md' }]);
  expect(clients).toHaveLength(2);
  await expect(
    clients[0].httpClient.fetchJson({
      url: 'https://proton.test/root',
      method: 'GET',
      headers: new Headers(),
      timeoutMs: 1000,
    }),
  ).rejects.toThrow();
  const restarted = new DriveService(file, {
    ...connectors,
    proton: new ProtonConnector({ vault, fetch: fetchFn, baseUrl: 'https://proton.test' }),
  });
  expect(await restarted.remote(drive.id, { op: 'snapshot' })).toMatchObject([{ path: 'fresh.md' }]);
});
