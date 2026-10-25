import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
