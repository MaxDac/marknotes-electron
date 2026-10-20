import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeConnector } from '../src/main/connectors/fake';
import { DriveService } from '../src/main/driveService';

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
});
