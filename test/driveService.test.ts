import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeConnector } from '../src/main/connectors/fake';
import { DriveService } from '../src/main/driveService';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { MultiDriveSync, type DriveSyncTarget } from '../src/shared/multiDriveSync';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { InMemoryBaseContentStore, InMemorySyncMetadataStore } from '../src/shared/types';

const service = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'marknotes-')), 'drives.json');
  return {
    file,
    service: new DriveService(file, {
      proton: new FakeConnector('proton'),
      dropbox: new FakeConnector('dropbox'),
      onedrive: new FakeConnector('onedrive'),
    }),
  };
};

describe('DriveService', () => {
  it.each(['dropbox', 'onedrive', 'proton'] as const)(
    'cancels a late %s authentication result without touching the connected drive',
    async (provider) => {
      const { file, service: s } = service();
      const first = (await s.signIn(provider))!;
      const drive = await s.addDrive(first.id, {
        remoteFolder: 'Keep',
        createRootFolder: false,
        rootFolderName: 'Notes',
      });
      const before = readFileSync(file, 'utf8');
      let finish!: () => void;
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(s.connectors[provider], 'signIn').mockImplementation(async () => {
        await waiting;
        return { id: 'late', provider, label: 'same', providerAccountId: 'test' };
      });
      const signOut = vi.spyOn(s.connectors[provider], 'signOut');
      const authenticating = s.signIn(provider);
      s.cancelSignIn();
      finish();
      expect(await authenticating).toBeNull();
      expect(signOut).toHaveBeenCalledWith('late');
      expect(await s.drives()).toEqual([drive]);
      expect(readFileSync(file, 'utf8')).toBe(before);
    },
  );

  it.each(['dropbox', 'onedrive', 'proton'] as const)(
    'reconnects %s without changing its persistent drive configuration and replaces the cached store',
    async (provider) => {
      const { file, service: s } = service();
      const first = (await s.signIn(provider))!;
      const drive = await s.addDrive(first.id, {
        remoteFolder: 'Documents',
        createRootFolder: true,
        rootFolderName: 'Personal notes',
      });
      const oldStore = await s.store(drive.id);
      const config = readFileSync(file, 'utf8');
      const staged =
        provider === 'proton'
          ? await s
              .protonLogin('test@example.com', 'secret', true)
              .then((r) => (r.kind === 'signedIn' ? r.account : null))
          : await s.signIn(provider);
      if (!staged) throw new Error('not signed in');
      expect(staged.id).not.toBe(drive.id);
      expect(await s.reconnect(drive.id, staged.id)).toEqual(drive);
      expect(readFileSync(file, 'utf8')).toBe(config);
      expect(await s.store(drive.id)).not.toBe(oldStore);
      await s.remote(drive.id, { op: 'uploadNew', path: 'after.md', bytes: new TextEncoder().encode('new') });
      expect(
        (s.connectors[provider] as FakeConnector).drive(drive.id).text('Documents/Personal notes/after.md'),
      ).toBe('new');
      const restarted = new DriveService(file, s.connectors);
      expect(await restarted.drives()).toEqual([drive]);
      await expect(s.reconnect(drive.id, staged.id)).rejects.toThrow('Sign in again');
    },
  );

  it('leaves config and cache untouched when credential verification fails or the sign-in was discarded', async () => {
    const { file, service: s } = service();
    const first = (await s.signIn('dropbox'))!;
    const drive = await s.addDrive(first.id, {
      remoteFolder: '',
      createRootFolder: false,
      rootFolderName: 'Notes',
    });
    const store = await s.store(drive.id);
    const config = readFileSync(file, 'utf8');
    const staged = (await s.signIn('dropbox'))!;
    vi.spyOn(s.connectors.dropbox, 'replaceCredentials').mockRejectedValue(new Error('Account mismatch'));
    await expect(s.reconnect(drive.id, staged.id)).rejects.toThrow('Account mismatch');
    expect(await s.store(drive.id)).toBe(store);
    expect(readFileSync(file, 'utf8')).toBe(config);
    await s.discardSignIn(staged.id);
    await expect(s.reconnect(drive.id, staged.id)).rejects.toThrow('Sign in again');
    expect(await s.drives()).toEqual([drive]);
  });

  it('records the provider identity of a drive added before it was tracked', async () => {
    const { file, service: s } = service();
    const first = (await s.signIn('onedrive'))!;
    const added = await s.addDrive(first.id, {
      remoteFolder: '',
      createRootFolder: false,
      rootFolderName: 'Notes',
    });
    const config = JSON.parse(readFileSync(file, 'utf8'));
    for (const d of config.drives) delete d.providerAccountId;
    writeFileSync(file, JSON.stringify(config));
    const legacy = new DriveService(file, s.connectors);
    const { providerAccountId: _, ...drive } = added;
    expect(await legacy.drives()).toEqual([drive]);
    const replace = vi.spyOn(s.connectors.onedrive, 'replaceCredentials').mockResolvedValue();
    const staged = (await legacy.signIn('onedrive'))!;
    expect(await legacy.reconnect(drive.id, staged.id)).toEqual(added);
    expect(replace).toHaveBeenCalledWith(drive, expect.objectContaining({ id: staged.id }));
    expect(await new DriveService(file, s.connectors).drives()).toEqual([added]);
  });

  it('serializes remote operations, reconnect and disconnect; a removed target cannot be resurrected', async () => {
    const { service: s } = service();
    const first = (await s.signIn('dropbox'))!;
    const drive = await s.addDrive(first.id, {
      remoteFolder: '',
      createRootFolder: false,
      rootFolderName: 'Notes',
    });
    const store = await s.store(drive.id);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    vi.spyOn(store, 'snapshot').mockImplementation(async () => {
      order.push('remote');
      await waiting;
      return [];
    });
    const replace = vi.spyOn(s.connectors.dropbox, 'replaceCredentials').mockImplementation(async () => {
      order.push('reconnect');
    });
    const staged = (await s.signIn('dropbox'))!;
    const remote = s.remote(drive.id, { op: 'snapshot' });
    const reconnect = s.reconnect(drive.id, staged.id);
    await vi.waitFor(() => expect(order).toEqual(['remote']));
    release();
    await Promise.all([remote, reconnect]);
    expect(order).toEqual(['remote', 'reconnect']);
    expect(replace).toHaveBeenCalledOnce();
    const another = (await s.signIn('dropbox'))!;
    await s.removeDrive(drive.id);
    await expect(s.reconnect(drive.id, another.id)).rejects.toThrow('no longer connected');
    expect(await s.drives()).toEqual([]);
  });

  it('keeps a stable device id', async () => {
    const { file, service: s } = service();
    const id = await s.deviceId();
    expect(id).toMatch(/[0-9a-f-]{36}/);
    expect(JSON.parse(readFileSync(file, 'utf8')).deviceId).toBe(id);
  });

  it('adds a signed-in drive with the chosen folder and syncs through its store', async () => {
    const { file, service: s } = service();
    const account = await s.signIn('dropbox');
    expect(account?.label).toBe('test@example.com');
    expect(await s.listFolders(account!.id, '')).toEqual([{ path: 'Documents', name: 'Documents' }]);
    const drive = await s.addDrive(account!.id, {
      remoteFolder: 'Documents',
      createRootFolder: true,
      rootFolderName: 'Notes',
    });
    expect(drive).toMatchObject({ provider: 'dropbox', remoteFolder: 'Documents', rootFolderName: 'Notes' });
    expect(JSON.parse(readFileSync(file, 'utf8')).drives).toHaveLength(1);

    await s.remote(drive.id, { op: 'uploadNew', path: 'a.md', bytes: new TextEncoder().encode('hi') });
    const entries = (await s.remote(drive.id, { op: 'snapshot' })) as { path: string }[];
    expect(entries.map((e) => e.path)).toEqual(['a.md']);
    const fake = (s.connectors.dropbox as FakeConnector).drive(drive.id);
    expect(fake.text('Documents/Notes/a.md')).toBe('hi');

    await s.remote(drive.id, { op: 'writeManifest', bytes: new TextEncoder().encode('{}') });
    expect(fake.text('Documents/Notes/.marknotes/manifest.json')).toBe('{}');
    expect(((await s.remote(drive.id, { op: 'snapshot' })) as unknown[]).length).toBe(1);

    await s.removeDrive(drive.id);
    expect(await s.drives()).toEqual([]);
    await expect(s.remote(drive.id, { op: 'snapshot' })).rejects.toThrow('no longer connected');
  });

  it('rejects adding an account that was discarded or an invalid folder name', async () => {
    const { service: s } = service();
    const account = await s.signIn('onedrive');
    await expect(
      s.addDrive(account!.id, { remoteFolder: '', createRootFolder: true, rootFolderName: 'a/b' }),
    ).rejects.toThrow();
    await s.discardSignIn(account!.id);
    await expect(
      s.addDrive(account!.id, { remoteFolder: '', createRootFolder: true, rootFolderName: 'MarkNotes' }),
    ).rejects.toThrow('Sign in again');
  });

  it('refuses to re-add a connected account, whose sync records would then delete every note', async () => {
    const { service: s } = service();
    const local = new NoteStore(new MemoryNodeBackend(), () => 1000);
    const multi = new MultiDriveSync(local, 'device', undefined, () => 1000);
    const other = new FakeRemoteDriveStore();
    const records = new Map<string, Omit<DriveSyncTarget, 'remote'>>();
    const sync = async () => {
      const targets: DriveSyncTarget[] = [];
      for (const [driveId, remote] of [
        ...(await s.drives()).map((d) => [d.id, s.store(d.id)] as const),
        ['other', Promise.resolve(other)] as const,
      ]) {
        if (!records.has(driveId)) {
          records.set(driveId, {
            driveId,
            metadata: new InMemorySyncMetadataStore(),
            base: new InMemoryBaseContentStore(),
          });
        }
        targets.push({ ...records.get(driveId)!, remote: await remote });
      }
      for (const outcome of (await multi.sync(targets)).outcomes) expect(outcome.error).toBeNull();
    };

    // Proton account ids are per user, so signing in to the same user again yields the connected drive's id.
    const first = await s.signIn('proton');
    const drive = await s.addDrive(first!.id, {
      remoteFolder: 'Documents',
      createRootFolder: true,
      rootFolderName: 'MarkNotes',
    });
    await local.write('n.md', 'hello');
    await sync();
    const fake = (s.connectors.proton as FakeConnector).drive(drive.id);
    expect(fake.text('Documents/MarkNotes/n.md')).toBe('hello');

    const again = await s.signIn('proton');
    expect(again!.id).toBe(drive.id);
    await expect(
      s.addDrive(again!.id, { remoteFolder: '', createRootFolder: true, rootFolderName: 'Elsewhere' }),
    ).rejects.toThrow('already connected');
    expect(await s.drives()).toEqual([drive]);

    await sync();
    expect(await local.read('n.md')).toBe('hello');
    expect(fake.text('Documents/MarkNotes/n.md')).toBe('hello');
    expect(other.content('n.md')).toBe('hello');
  });
});
