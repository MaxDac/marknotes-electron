import { beforeEach, describe, expect, it } from 'vitest';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { sha256Hex, utf8 } from '../src/shared/hashing';
import { SyncManifest } from '../src/shared/manifest';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import {
  CONFLICT_SUFFIX,
  localChanges,
  summary,
  SyncEngine,
  type SyncResult,
} from '../src/shared/syncEngine';
import { InMemoryBaseContentStore, InMemorySyncMetadataStore } from '../src/shared/types';

describe('SyncEngine', () => {
  let local: NoteStore;
  let remote: FakeRemoteDriveStore;
  let metadata: InMemorySyncMetadataStore;
  let engine: SyncEngine;

  beforeEach(() => {
    local = new NoteStore(new MemoryNodeBackend());
    remote = new FakeRemoteDriveStore();
    metadata = new InMemorySyncMetadataStore();
    engine = new SyncEngine(local, remote, metadata, new InMemoryBaseContentStore(), '', '', () => 1000);
  });

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

  it('different content without history is a conflict', async () => {
    await local.write('n.md', 'local');
    remote.putFile('n.md', 'remote');

    const result = await syncClean();

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].localText).toBe('local');
    expect(result.conflicts[0].remoteText).toBe('remote');
    expect(await local.read('n.md')).toBe('local');
    expect(remote.content('n.md')).toBe('remote');
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

  it('edits on both sides produce conflict and keepLocal resolves', async () => {
    await local.write('n.md', 'base');
    await syncClean();
    await local.write('n.md', 'local');
    remote.putFile('n.md', 'remote');

    const { conflicts } = await syncClean();
    expect(conflicts).toHaveLength(1);
    await engine.resolve(conflicts[0], { kind: 'keepLocal' });

    expect(await local.read('n.md')).toBe('local');
    expect(remote.content('n.md')).toBe('local');
    await assertStable();
  });

  it('keepRemote resolution', async () => {
    await local.write('n.md', 'base');
    await syncClean();
    await local.write('n.md', 'local');
    remote.putFile('n.md', 'remote');

    const { conflicts } = await syncClean();
    expect(conflicts).toHaveLength(1);
    await engine.resolve(conflicts[0], { kind: 'keepRemote' });

    expect(await local.read('n.md')).toBe('remote');
    expect(remote.content('n.md')).toBe('remote');
    await assertStable();
  });

  it('keepBoth resolution duplicates remote version', async () => {
    await local.write('dir/n.md', 'base');
    await syncClean();
    await local.write('dir/n.md', 'local');
    remote.putFile('dir/n.md', 'remote');

    const { conflicts } = await syncClean();
    expect(conflicts).toHaveLength(1);
    await engine.resolve(conflicts[0], { kind: 'keepBoth' });

    const copy = `dir/n${CONFLICT_SUFFIX}.md`;
    expect(await local.read('dir/n.md')).toBe('local');
    expect(await local.read(copy)).toBe('remote');
    expect(remote.content('dir/n.md')).toBe('local');
    expect(remote.content(copy)).toBe('remote');
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

  it('conflict is reported again until resolved', async () => {
    await local.write('n.md', 'base');
    await syncClean();
    await local.write('n.md', 'local');
    remote.putFile('n.md', 'remote');

    expect((await syncClean()).conflicts).toHaveLength(1);
    expect((await syncClean()).conflicts).toHaveLength(1);
  });

  it('non-overlapping edits on both sides are merged automatically', async () => {
    await local.write('n.md', 'a\nb\nc\n');
    await syncClean();
    await local.write('n.md', 'A\nb\nc\n');
    remote.putFile('n.md', 'a\nb\nC\n');

    const result = await syncClean();

    expect(result.merged).toBe(1);
    expect(result.conflicts).toEqual([]);
    expect(await local.read('n.md')).toBe('A\nb\nC\n');
    expect(remote.content('n.md')).toBe('A\nb\nC\n');
    await assertStable();
  });

  it('conflict carries base and merged resolution is saved on both sides', async () => {
    await local.write('n.md', 'a\nb\n');
    await syncClean();
    await local.write('n.md', 'a\nlocal\n');
    remote.putFile('n.md', 'a\nremote\n');

    const { conflicts } = await syncClean();
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict.baseText).toBe('a\nb\n');
    expect(conflict.merge.conflicts).toHaveLength(1);

    await engine.resolve(conflict, { kind: 'merged', text: 'a\nlocal and remote\n' });

    expect(await local.read('n.md')).toBe('a\nlocal and remote\n');
    expect(remote.content('n.md')).toBe('a\nlocal and remote\n');
    await assertStable();
  });

  it('manifest describes synced notes and is only rewritten on change', async () => {
    await local.write('a/n.md', 'x');
    await syncClean();

    const manifest = SyncManifest.parse(utf8.decode(remote.manifest!))!;
    expect(manifest).not.toBeNull();
    expect(Object.keys(manifest.files)).toEqual(['a/n.md']);
    expect(manifest.files['a/n.md'].sha256).toBe(await sha256Hex(utf8.encode('x')));
    expect(remote.manifestWrites).toBe(1);

    await syncClean();
    expect(remote.manifestWrites).toBe(1);

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

  it('summary and localChanges describe a result', () => {
    const result: SyncResult = {
      uploaded: 1,
      downloaded: 2,
      deletedLocal: 3,
      deletedRemote: 4,
      conflicts: [],
      errors: ['e'],
      merged: 5,
    };
    expect(summary(result)).toBe('↑1 ↓2, merged 5, deleted 7, 1 error(s)');
    expect(localChanges(result)).toBe(10);
  });
});
