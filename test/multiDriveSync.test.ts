import { beforeEach, describe, expect, it } from 'vitest';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import {
  allConflicts,
  MultiDriveSync,
  type DriveSyncOutcome,
  type DriveSyncTarget,
} from '../src/shared/multiDriveSync';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import {
  InMemoryBaseContentStore,
  InMemorySyncMetadataStore,
  type RemoteDriveStore,
} from '../src/shared/types';

describe('MultiDriveSync', () => {
  let local: NoteStore;
  let driveA: FakeRemoteDriveStore;
  let driveB: FakeRemoteDriveStore;
  let targets: DriveSyncTarget[];
  let sync: MultiDriveSync;

  const target = (driveId: string, remote: RemoteDriveStore): DriveSyncTarget => ({
    driveId,
    remote,
    metadata: new InMemorySyncMetadataStore(),
    base: new InMemoryBaseContentStore(),
  });

  beforeEach(() => {
    local = new NoteStore(new MemoryNodeBackend());
    driveA = new FakeRemoteDriveStore();
    driveB = new FakeRemoteDriveStore();
    targets = [target('a', driveA), target('b', driveB)];
    sync = new MultiDriveSync(local, 'device', undefined, () => 1000);
  });

  async function syncAll(): Promise<DriveSyncOutcome[]> {
    const outcomes = await sync.sync(targets);
    for (const o of outcomes) {
      expect(o.error).toBeNull();
      expect(o.result!.errors).toEqual([]);
    }
    return outcomes;
  }

  it('local notes are pushed to every drive', async () => {
    await local.write('f/n.md', 'hello');

    await syncAll();

    expect(driveA.content('f/n.md')).toBe('hello');
    expect(driveB.content('f/n.md')).toBe('hello');
  });

  it('note added on one drive reaches the others', async () => {
    await syncAll();
    driveB.putFile('from-b.md', 'b');

    await syncAll();

    expect(await local.read('from-b.md')).toBe('b');
    expect(driveA.content('from-b.md')).toBe('b');
  });

  it('latest edit on any drive is propagated', async () => {
    await local.write('n.md', 'v1');
    await syncAll();
    driveA.putFile('n.md', 'v2');

    await syncAll();

    expect(await local.read('n.md')).toBe('v2');
    expect(driveB.content('n.md')).toBe('v2');
  });

  it('deletion on one drive is propagated', async () => {
    await local.write('n.md', 'x');
    await syncAll();
    driveB.remove('n.md');

    await syncAll();

    expect(await local.exists('n.md')).toBe(false);
    expect(driveA.exists('n.md')).toBe(false);
  });

  it('non-overlapping edits on two drives are merged everywhere', async () => {
    await local.write('n.md', 'a\nb\nc\n');
    await syncAll();
    driveA.putFile('n.md', 'A\nb\nc\n');
    driveB.putFile('n.md', 'a\nb\nC\n');

    const outcomes = await syncAll();

    expect(allConflicts(outcomes)).toEqual([]);
    expect(await local.read('n.md')).toBe('A\nb\nC\n');
    expect(driveA.content('n.md')).toBe('A\nb\nC\n');
    expect(driveB.content('n.md')).toBe('A\nb\nC\n');
  });

  it('conflicting edits are reported with their drive', async () => {
    await local.write('n.md', 'x\n');
    await syncAll();
    driveA.putFile('n.md', 'from a\n');
    driveB.putFile('n.md', 'from b\n');

    const conflicts = allConflicts(await syncAll());

    expect(conflicts.map((c) => c.driveId)).toEqual(['b']);
    expect(await local.read('n.md')).toBe('from a\n');
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].remoteText).toBe('from b\n');
  });

  it('failing drive does not block the others', async () => {
    await local.write('n.md', 'x');
    const broken: RemoteDriveStore = {
      snapshot: () => Promise.reject(new Error('offline')),
      download: (e) => driveA.download(e),
      uploadNew: (p, b) => driveA.uploadNew(p, b),
      uploadRevision: (e, b) => driveA.uploadRevision(e, b),
      createFolder: (p) => driveA.createFolder(p),
      delete: (e) => driveA.delete(e),
      readManifest: () => driveA.readManifest(),
      writeManifest: (b) => driveA.writeManifest(b),
    };

    const outcomes = await sync.sync([target('broken', broken), targets[1]]);

    expect(outcomes[0].error).toBe('offline');
    expect(driveB.content('n.md')).toBe('x');
  });
});
