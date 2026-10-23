import { parseManifest, readId } from '@marknotes/sync';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConflictMergeBack } from '../src/shared/conflictMergeBack';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { sha256Hex, utf8 } from '../src/shared/hashing';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { localChanges, summary, SyncEngine, type SyncResult } from '../src/shared/syncEngine';
import { InMemoryBaseContentStore, InMemorySyncMetadataStore, type RemoteEntry } from '../src/shared/types';

const COPY = 'n (conflicted copy).md';
const note = (id: string, body: string) => `---\nid: ${id}\n---\n${body}`;

describe('SyncEngine', () => {
  let now: number;
  let ids: string[];
  let local: NoteStore;
  let remote: FakeRemoteDriveStore;
  let metadata: InMemorySyncMetadataStore;
  let base: InMemoryBaseContentStore;
  let engine: SyncEngine;

  beforeEach(() => {
    now = 1000;
    ids = ['xyzw0001', 'xyzw0002', 'xyzw0003'];
    local = new NoteStore(new MemoryNodeBackend(), () => now);
    remote = new FakeRemoteDriveStore();
    metadata = new InMemorySyncMetadataStore();
    base = new InMemoryBaseContentStore();
    engine = new SyncEngine(
      local,
      remote,
      metadata,
      base,
      'drive',
      'device',
      () => now,
      () => ids.shift()!,
    );
  });

  /** A note synced as `base`, then edited locally at `localAt` and on the drive at `remoteAt`. */
  async function editBothSides(
    baseText: string,
    localText: string,
    localAt: number,
    remoteText: string,
    remoteAt: number,
  ) {
    await local.write('n.md', baseText);
    await syncClean();
    now = localAt;
    await local.write('n.md', localText);
    remote.put('n.md', remoteText, remoteAt);
  }

  async function syncClean(): Promise<SyncResult> {
    const result = await engine.sync();
    expect(result.errors).toEqual([]);
    return result;
  }

  async function assertStable() {
    remote.calls.length = 0;
    const result = await syncClean();
    expect(remote.calls.filter((c) => !c.startsWith('download:'))).toEqual([]);
    expect(result.uploaded + result.downloaded + result.deletedLocal + result.deletedRemote).toBe(0);
    expect(result.conflicts).toEqual([]);
  }

  it('first sync uploads local notes', async () => {
    await local.write('root.md', 'root');
    await local.write('a/b/deep.md', 'deep');
    await local.createFolder('empty');

    const result = await syncClean();

    expect(result.uploaded).toBe(2);
    expect(remote.content('root.md')).toBe('root');
    expect(remote.content('a/b/deep.md')).toBe('deep');
    expect(remote.isFolder('empty')).toBe(true);
    await assertStable();
  });

  it('first sync downloads remote notes', async () => {
    remote.putFile('x/note.md', 'remote');
    remote.putFolder('y');

    const result = await syncClean();

    expect(result.downloaded).toBe(1);
    expect(await local.read('x/note.md')).toBe('remote');
    expect(await local.isFolder('y')).toBe(true);
    await assertStable();
  });

  it('ignores non-markdown files', async () => {
    await local.write('image.png', 'png');
    remote.putFile('doc.pdf', 'pdf');

    await syncClean();

    expect(remote.exists('image.png')).toBe(false);
    expect(await local.exists('doc.pdf')).toBe(false);
  });

  it('identical content on both sides is not a conflict', async () => {
    await local.write('n.md', 'same');
    remote.putFile('n.md', 'same');

    const result = await syncClean();

    expect(result.conflicts).toEqual([]);
    await assertStable();
  });

  it('different content without history keeps the newest and saves the other as a copy', async () => {
    now = 100;
    await local.write('n.md', 'local');
    remote.put('n.md', 'remote', 200);

    const result = await syncClean();

    expect(result.conflicts).toEqual([
      { path: 'n.md', copyPath: COPY, winner: 'remote', baseText: null, driveId: 'drive' },
    ]);
    expect(await local.read('n.md')).toBe('remote');
    expect(await local.read(COPY)).toBe('local');
    expect(remote.content('n.md')).toBe('remote');
    expect(remote.content(COPY)).toBe('local');
    await assertStable();
  });
  it('local edit uploads revision', async () => {
    await local.write('n.md', 'v1');
    await syncClean();
    await local.write('n.md', 'v2');
    remote.calls.length = 0;

    const result = await syncClean();

    expect(result.uploaded).toBe(1);
    expect(remote.calls).toEqual(['uploadRevision:n.md']);
    expect(remote.content('n.md')).toBe('v2');
    await assertStable();
  });

  it('remote edit downloads', async () => {
    await local.write('n.md', 'v1');
    await syncClean();
    remote.putFile('n.md', 'v2');

    const result = await syncClean();

    expect(result.downloaded).toBe(1);
    expect(await local.read('n.md')).toBe('v2');
    await assertStable();
  });

  it('overlapping edits: newer local version wins and the drive version becomes a copy', async () => {
    await editBothSides('a\nb\n', 'a\nlocal\n', 3000, 'a\nremote\n', 2000);
    remote.calls.length = 0;

    const result = await syncClean();

    expect(result.conflicts).toEqual([
      { path: 'n.md', copyPath: COPY, winner: 'local', baseText: 'a\nb\n', driveId: 'drive' },
    ]);
    expect(await local.read('n.md')).toBe('a\nlocal\n');
    expect(remote.content('n.md')).toBe('a\nlocal\n');
    expect(await local.read(COPY)).toBe('a\nremote\n');
    expect(remote.content(COPY)).toBe('a\nremote\n');
    expect(remote.calls).toContain(`uploadNew:${COPY}`);
    expect(localChanges(result)).toBe(1);
    await assertStable();
  });

  it('overlapping edits: newer drive version wins and the local version becomes a copy', async () => {
    await editBothSides('a\nb\n', 'a\nlocal\n', 2000, 'a\nremote\n', 3000);

    const { conflicts } = await syncClean();

    expect(conflicts.map((c) => c.winner)).toEqual(['remote']);
    expect(await local.read('n.md')).toBe('a\nremote\n');
    expect(remote.content('n.md')).toBe('a\nremote\n');
    expect(await local.read(COPY)).toBe('a\nlocal\n');
    expect(remote.content(COPY)).toBe('a\nlocal\n');
    await assertStable();
  });

  it('overlapping edits at the same time: the drive version wins', async () => {
    await editBothSides('a\nb\n', 'a\nlocal\n', 2000, 'a\nremote\n', 2000);

    const { conflicts } = await syncClean();

    expect(conflicts.map((c) => c.winner)).toEqual(['remote']);
    expect(await local.read('n.md')).toBe('a\nremote\n');
    expect(await local.read(COPY)).toBe('a\nlocal\n');
  });

  it('the conflicted copy gets a new note id and a free name', async () => {
    await local.write(COPY, 'an older copy');
    await editBothSides(
      note('abcd1234', 'base\n'),
      note('abcd1234', 'local\n'),
      3000,
      note('abcd1234', 'remote\n'),
      2000,
    );

    const { conflicts } = await syncClean();

    const copyPath = 'n (conflicted copy) 2.md';
    expect(conflicts.map((c) => c.copyPath)).toEqual([copyPath]);
    expect(readId(await local.read('n.md'))).toBe('abcd1234');
    expect(await local.read(copyPath)).toBe(note('xyzw0001', 'remote\n'));
    expect(remote.content(copyPath)).toBe(note('xyzw0001', 'remote\n'));
    expect(await local.read(COPY)).toBe('an older copy');
  });

  it('merging the copy back keeps the note id and deletes the copy everywhere', async () => {
    await editBothSides(
      note('abcd1234', 'a\nb\n'),
      note('abcd1234', 'a\nlocal\n'),
      3000,
      note('abcd1234', 'a\nremote\n'),
      2000,
    );
    const [conflict] = (await syncClean()).conflicts;
    const mergeBack = new ConflictMergeBack(local);
    expect(await mergeBack.isPending(conflict)).toBe(true);

    const merge = await mergeBack.merge(conflict);
    expect(merge.conflicts).toBe(1);
    await mergeBack.apply(conflict, note('abcd1234', 'a\nlocal and remote\n'));
    expect(await mergeBack.isPending(conflict)).toBe(false);
    await syncClean();

    expect(remote.content('n.md')).toBe(note('abcd1234', 'a\nlocal and remote\n'));
    expect(remote.exists(COPY)).toBe(false);
    expect(await local.exists(COPY)).toBe(false);
    await assertStable();
  });

  it('discarding the copy deletes it everywhere and keeps the note', async () => {
    await editBothSides('a\nb\n', 'a\nlocal\n', 3000, 'a\nremote\n', 2000);
    const [conflict] = (await syncClean()).conflicts;

    await new ConflictMergeBack(local).discardCopy(conflict);
    await syncClean();

    expect(remote.exists(COPY)).toBe(false);
    expect(remote.content('n.md')).toBe('a\nlocal\n');
    await assertStable();
  });
  it('local deletion trashes remote', async () => {
    await local.write('n.md', 'x');
    await syncClean();
    await local.delete('n.md');

    const result = await syncClean();

    expect(result.deletedRemote).toBe(1);
    expect(remote.exists('n.md')).toBe(false);
    await assertStable();
  });

  it('remote deletion deletes local', async () => {
    await local.write('n.md', 'x');
    await syncClean();
    remote.remove('n.md');

    const result = await syncClean();

    expect(result.deletedLocal).toBe(1);
    expect(await local.exists('n.md')).toBe(false);
    await assertStable();
  });

  it('local deletion loses against remote edit', async () => {
    await local.write('n.md', 'v1');
    await syncClean();
    await local.delete('n.md');
    remote.putFile('n.md', 'v2');

    await syncClean();

    expect(await local.read('n.md')).toBe('v2');
    await assertStable();
  });

  it('remote deletion loses against local edit', async () => {
    await local.write('n.md', 'v1');
    await syncClean();
    remote.remove('n.md');
    await local.write('n.md', 'v2');

    await syncClean();

    expect(remote.content('n.md')).toBe('v2');
    await assertStable();
  });

  it('local folder deletion trashes remote folder once', async () => {
    await local.write('a/x.md', 'x');
    await local.write('a/b/y.md', 'y');
    await syncClean();
    await local.delete('a');
    remote.calls.length = 0;

    await syncClean();

    expect(remote.calls).toEqual(['delete:a']);
    expect(remote.exists('a')).toBe(false);
    expect(await metadata.all()).toEqual([]);
    await assertStable();
  });

  it('remote folder deletion deletes local folder', async () => {
    await local.write('a/x.md', 'x');
    await local.write('a/b/y.md', 'y');
    await syncClean();
    remote.remove('a');

    await syncClean();

    expect(await local.exists('a')).toBe(false);
    expect(await metadata.all()).toEqual([]);
    await assertStable();
  });

  it('remote folder deletion keeps locally edited notes', async () => {
    await local.write('a/x.md', 'x');
    await local.write('a/y.md', 'y');
    await syncClean();
    remote.remove('a');
    await local.write('a/x.md', 'edited');

    await syncClean();

    expect(remote.isFolder('a')).toBe(true);
    expect(remote.content('a/x.md')).toBe('edited');
    expect(await local.exists('a/y.md')).toBe(false);
    await assertStable();
  });

  it('non-overlapping edits on both sides are merged automatically', async () => {
    await editBothSides('a\nb\nc\n', 'A\nb\nc\n', 2000, 'a\nb\nC\n', 3000);

    const result = await syncClean();

    expect(result.merged).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(await local.read('n.md')).toBe('A\nb\nC\n');
    expect(remote.content('n.md')).toBe('A\nb\nC\n');
    await assertStable();
  });

  it('a failing step is reported and the sync goes on', async () => {
    await local.write('bad.md', 'bad');
    await local.write('good.md', 'good');
    const uploadNew = remote.uploadNew.bind(remote);
    remote.uploadNew = (path: string, bytes: Uint8Array): Promise<RemoteEntry> =>
      path === 'bad.md' ? Promise.reject(new Error('quota exceeded')) : uploadNew(path, bytes);

    const result = await engine.sync();

    expect(result.errors).toEqual(['bad.md: quota exceeded']);
    expect(remote.content('good.md')).toBe('good');
    expect(remote.exists('bad.md')).toBe(false);
    remote.uploadNew = uploadNew;
    await syncClean();
    expect(remote.content('bad.md')).toBe('bad');
  });

  it('an unreadable manifest is ignored', async () => {
    await local.write('n.md', 'x');
    remote.readManifest = () => Promise.reject(new Error('offline'));
    await syncClean();
    expect(remote.content('n.md')).toBe('x');
  });
  it('manifest describes synced notes and is only rewritten on change', async () => {
    await local.write('a/n.md', 'x');
    await syncClean();

    const manifest = parseManifest(utf8.decode(remote.manifest!))!;
    expect(manifest).not.toBeNull();
    expect(manifest.deviceId).toBe('device');
    expect(Object.keys(manifest.files)).toEqual(['a/n.md']);
    expect(manifest.files['a/n.md'].sha256).toBe(await sha256Hex(utf8.encode('x')));
    expect(remote.manifestWrites).toBe(1);

    await syncClean();
    expect(remote.manifestWrites).toBe(1);

    now = 2000;
    await local.write('a/n.md', 'y');
    await syncClean();
    expect(remote.manifestWrites).toBe(2);
  });

  it('manifest avoids downloading notes that are already identical', async () => {
    await local.write('n.md', 'same');
    await syncClean();
    // A second device with the same note connects the same drive.
    const other = new NoteStore(new MemoryNodeBackend());
    await other.write('n.md', 'same');
    remote.calls.length = 0;

    const result = await new SyncEngine(
      other,
      remote,
      new InMemorySyncMetadataStore(),
      new InMemoryBaseContentStore(),
      '',
      '',
      () => 2000,
    ).sync();

    expect(result.conflicts).toEqual([]);
    expect(remote.calls).toEqual([]);
  });

  it('a note saved while the sync runs is never overwritten by a download', async () => {
    await local.write('n.md', 'v1');
    await syncClean();
    remote.putFile('n.md', 'v2');
    const download = remote.download.bind(remote);
    remote.download = async (entry) => {
      await local.write('n.md', 'typed meanwhile');
      return download(entry);
    };

    const result = await syncClean();

    expect(result.downloaded).toBe(0);
    expect(await local.read('n.md')).toBe('typed meanwhile');
  });

  it('a note saved while the sync runs is never deleted', async () => {
    await local.write('z.md', 'v1');
    await syncClean();
    remote.remove('z.md');
    remote.putFile('a.md', 'new');
    const download = remote.download.bind(remote);
    remote.download = async (entry) => {
      await local.write('z.md', 'typed meanwhile');
      return download(entry);
    };

    const result = await syncClean();

    expect(result.deletedLocal).toBe(0);
    expect(await local.read('z.md')).toBe('typed meanwhile');
    remote.download = download;
    await syncClean();
    expect(remote.content('z.md')).toBe('typed meanwhile');
  });

  it('a drive file changed after planning is not deleted and keeps its record', async () => {
    await local.write('n.md', 'v1');
    await syncClean();
    await local.delete('n.md');
    const snapshot = remote.snapshot.bind(remote);
    remote.snapshot = async () => {
      const entries = await snapshot();
      remote.put('n.md', 'edited on another device', 5000);
      return entries;
    };

    const result = await engine.sync();

    expect(result.errors).toEqual(['n.md: n.md changed on the drive since the sync started']);
    expect(result.deletedRemote).toBe(0);
    expect(remote.content('n.md')).toBe('edited on another device');
    expect((await metadata.all()).map((r) => r.path)).toContain('n.md');
    remote.snapshot = snapshot;
    await syncClean();
    expect(await local.read('n.md')).toBe('edited on another device');
  });

  it('the local edit time travels with uploads and downloads', async () => {
    now = 1234;
    await local.write('mine.md', 'mine');
    remote.put('theirs.md', 'theirs', 777);
    now = 9999;

    await syncClean();

    expect(remote.nodes.get('mine.md')!.modified).toBe(1234);
    expect((await local.entry('theirs.md'))!.modifiedMillis).toBe(777);
  });

  it('counts folders created locally as local changes', async () => {
    remote.putFolder('y');
    const result = await syncClean();
    expect(result.foldersCreated).toBe(1);
    expect(localChanges(result)).toBe(1);
  });

  it('a conflict writes the copy locally, then the note, then uploads the copy', async () => {
    await editBothSides('a\nb\n', 'a\nlocal\n', 2000, 'a\nremote\n', 3000);
    const steps: string[] = [];
    const writeBytes = local.writeBytes.bind(local);
    local.writeBytes = async (path, bytes, modified) => {
      steps.push(`write:${path}`);
      return writeBytes(path, bytes, modified);
    };
    const uploadNew = remote.uploadNew.bind(remote);
    remote.uploadNew = async (path, bytes, modified) => {
      steps.push(`upload:${path}`);
      return uploadNew(path, bytes, modified);
    };

    await syncClean();

    expect(steps).toEqual([`write:${COPY}`, 'write:n.md', `upload:${COPY}`]);
  });

  it('a conflicted copy that cannot be written leaves the note untouched', async () => {
    await editBothSides('a\nb\n', 'a\nlocal\n', 2000, 'a\nremote\n', 3000);
    const writeBytes = local.writeBytes.bind(local);
    local.writeBytes = async (path, bytes, modified) => {
      if (path === COPY) throw new Error('disk full');
      return writeBytes(path, bytes, modified);
    };

    const result = await engine.sync();

    expect(result.errors).toEqual(['n.md: disk full']);
    expect(await local.read('n.md')).toBe('a\nlocal\n');
    expect(remote.exists(COPY)).toBe(false);
  });

  it('summary and localChanges describe a result', () => {
    const result: SyncResult = {
      uploaded: 1,
      downloaded: 2,
      deletedLocal: 3,
      deletedRemote: 4,
      conflicts: [{ path: 'n.md', copyPath: COPY, winner: 'local', baseText: null, driveId: 'd' }],
      errors: ['e'],
      merged: 5,
      foldersCreated: 0,
    };
    expect(summary(result)).toBe('↑1 ↓2, merged 5, deleted 7, 1 conflicted copy(ies), 1 error(s)');
    expect(localChanges(result)).toBe(11);
    expect(localChanges({ ...result, foldersCreated: 2 })).toBe(13);
  });
});
