import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@marknotes/sync';
import { openDB } from 'idb';
import { executorSafety } from '../parity/executorSafety';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { SyncEngine } from '../src/shared/syncEngine';
import { InMemoryBaseContentStore, InMemorySyncMetadataStore } from '../src/shared/types';
import {
  IdbBaseContentStore,
  IdbNodeBackend,
  IdbSyncMetadataStore,
  openDatabase,
} from '../src/renderer/src/data/db';
import { deriveDbKeys, seal, tag } from '../src/renderer/src/data/crypto';

const bytes = (s: string) => new TextEncoder().encode(s);

describe('sync execution safety', () => {
  it.each(['intent', 'copy', 'winner', 'winner-record', 'copy-upload', 'copy-record'])(
    'recovers after %s without duplicating or retiming the copy',
    async (crashAfter) => {
      expect(await executorSafety({ scenario: 'conflict-copy-restart', crashAfter })).toEqual({
        errors: 0,
        copyCount: 1,
        copyModifiedMillis: 1000,
        losingTextPreserved: true,
        intentCleared: true,
      });
    },
  );

  it('new local sync files and folders never adopt existing or case-colliding entries', async () => {
    const local = new NoteStore(new MemoryNodeBackend());
    await local.write('Note.md', 'original');
    await expect(local.writeSyncedBytes('note.md', bytes('replacement'), 1)).rejects.toThrow(
      /already exists/,
    );
    await expect(local.createSyncedFolder('Note.md')).rejects.toThrow();
    await local.createFolder('F');
    await expect(local.createSyncedFolder('f')).rejects.toThrow(/already exists/);
    expect(await local.read('Note.md')).toBe('original');
  });

  it('the local compare-and-swap catches an edit between validation and commit', async () => {
    const backend = new MemoryNodeBackend();
    const local = new NoteStore(backend);
    await local.write('note.md', 'before');
    const apply = backend.applyIfUnchanged.bind(backend);
    backend.applyIfUnchanged = async (expected, puts, deletes) => {
      await local.write('note.md', 'typed meanwhile');
      return apply(expected, puts, deletes);
    };
    await expect(
      local.writeSyncedBytes('note.md', bytes('remote'), 1, sha256Hex(bytes('before'))),
    ).rejects.toThrow(/changed/);
    expect(await local.read('note.md')).toBe('typed meanwhile');
  });

  it.each([
    ['\u017f', 'S'],
    ['\u03c2', '\u03a3'],
  ])('uses shared Unicode folding for create-only guards (%s / %s)', async (existing, alias) => {
    const local = new NoteStore(new MemoryNodeBackend());
    await local.write(`${existing}.md`, 'original');
    await expect(local.writeSyncedBytes(`${alias}.md`, bytes('replacement'), 0)).rejects.toThrow(
      /already exists/,
    );
    await local.createFolder(existing);
    await expect(local.createSyncedFolder(alias)).rejects.toThrow(/already exists/);
    await expect(local.writeSyncedBytes(`${alias}/n.md`, bytes('new'), 0)).rejects.toThrow(/already exists/);
    expect(await local.read(`${existing}.md`)).toBe('original');
  });

  it('does not conflate dotted I with the two-codepoint lowercase spelling', async () => {
    const local = new NoteStore(new MemoryNodeBackend());
    await local.writeSyncedBytes('\u0130.md', bytes('dotted I'), 0);
    await local.writeSyncedBytes('i\u0307.md', bytes('combining dot'), 0);
    expect(await local.read('\u0130.md')).toBe('dotted I');
    expect(await local.read('i\u0307.md')).toBe('combining dot');
    expect((await local.entry('\u0130.md'))?.modifiedMillis).toBe(0);
  });

  it('empty-only local deletion preserves hidden and unsynced descendants', async () => {
    const backend = new MemoryNodeBackend();
    const local = new NoteStore(backend);
    await local.createFolder('F');
    await backend.apply(
      [{ path: 'F/.hidden', isFolder: false, content: bytes('secret'), size: 6, modifiedMillis: 1 }],
      [],
    );
    await local.write('F/unrelated.txt', 'other');
    await expect(local.deleteSynced('F')).rejects.toThrow(/not empty/);
    expect((await backend.get('F/.hidden'))?.content).toEqual(bytes('secret'));
    expect(await local.read('F/unrelated.txt')).toBe('other');
  });

  it('upgrades the encrypted database without losing existing notes', async () => {
    const name = `upgrade-${crypto.randomUUID()}`;
    const key = crypto.getRandomValues(new Uint8Array(32));
    const keys = await deriveDbKeys(key);
    const old = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('nodes', { keyPath: 'k' });
        for (const store of ['syncRecords', 'baseContent']) {
          db.createObjectStore(store, { keyPath: 'k' }).createIndex('driveId', 'd');
        }
        db.createObjectStore('settings', { keyPath: 'k' });
      },
    });
    const k = await tag(keys, 'nodes\u0000n.md');
    await old.put('nodes', {
      k,
      ...(await seal(keys, `nodes\u0000${k}`, {
        path: 'n.md',
        isFolder: false,
        modifiedMillis: 0,
        size: 8,
        content: bytes('original'),
      })),
    });
    old.close();
    const db = await openDatabase({ name, key });
    expect(await new NoteStore(new IdbNodeBackend(db)).read('n.md')).toBe('original');
    const metadata = new IdbSyncMetadataStore(db, 'drive');
    expect(await metadata.pendingConflicts()).toEqual([]);
    expect(await metadata.pendingRenames()).toEqual([]);
    db.close();
  });

  it('real IndexedDB create-only writes reject one of two concurrent creators', async () => {
    const db = await openDatabase({
      name: `concurrent-${crypto.randomUUID()}`,
      key: crypto.getRandomValues(new Uint8Array(32)),
    });
    const local = new NoteStore(new IdbNodeBackend(db));
    const writes = await Promise.allSettled([
      local.writeSyncedBytes('n.md', bytes('first'), 0),
      local.writeSyncedBytes('n.md', bytes('second'), 0),
    ]);
    expect(writes.filter((w) => w.status === 'fulfilled')).toHaveLength(1);
    expect(writes.filter((w) => w.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(await local.read('n.md'));
    db.close();
  });

  it('case-only local convergence migrates only the current drive state', async () => {
    const local = new NoteStore(new MemoryNodeBackend());
    const remote = new FakeRemoteDriveStore();
    const metadata = new InMemorySyncMetadataStore();
    const otherDrive = new InMemorySyncMetadataStore();
    const base = new InMemoryBaseContentStore();
    const engine = new SyncEngine(local, remote, metadata, base);
    await local.write('Note.md', 'unchanged');
    expect((await engine.sync()).errors).toEqual([]);
    const [record] = await metadata.all();
    await otherDrive.upsert(record);
    await remote.rename((await remote.snapshot())[0], 'note.md');
    expect((await engine.sync()).errors).toEqual([]);
    expect(await local.exists('Note.md')).toBe(false);
    expect(await local.read('note.md')).toBe('unchanged');
    expect(await metadata.all()).toEqual([{ ...record, path: 'note.md' }]);
    expect(await otherDrive.all()).toEqual([record]);
    expect(await base.get('note.md')).toEqual(bytes('unchanged'));
    expect(await base.get('Note.md')).toBeNull();
    expect((await engine.sync()).errors).toEqual([]);
  });

  it('a real database restart preserves the intent and the original generated copy ID', async () => {
    const name = `retry-${crypto.randomUUID()}`;
    const key = crypto.getRandomValues(new Uint8Array(32));
    let db = await openDatabase({ name, key });
    let local = new NoteStore(new IdbNodeBackend(db), () => 1000);
    let metadata = new IdbSyncMetadataStore(db, 'drive');
    let base = new IdbBaseContentStore(db, 'drive');
    const remote = new FakeRemoteDriveStore();
    const engine = () =>
      new SyncEngine(
        local,
        remote,
        metadata,
        base,
        'drive',
        '',
        () => 3000,
        () => 'cpyr0001',
      );
    await local.write('n.md', 'base');
    await engine().sync();
    await local.write('n.md', 'losing');
    remote.put('n.md', 'winning', 2000);
    const write = local.writeSyncedBytes.bind(local);
    local.writeSyncedBytes = async (path, content, modified, hash) => {
      await write(path, content, modified, hash);
      if (path.includes('(conflicted copy)')) throw new Error('crash');
    };
    expect((await engine().sync()).errors).toHaveLength(1);
    const [pending] = await metadata.pendingConflicts();
    expect(pending.intent.newId).toBe('cpyr0001');
    db.close();
    db = await openDatabase({ name, key });
    local = new NoteStore(new IdbNodeBackend(db));
    metadata = new IdbSyncMetadataStore(db, 'drive');
    base = new IdbBaseContentStore(db, 'drive');
    expect((await engine().sync()).errors).toEqual([]);
    expect(await local.read('n (conflicted copy).md')).toContain('id: cpyr0001');
    expect((await local.listAll()).filter((e) => e.path.includes('(conflicted copy)'))).toHaveLength(1);
    expect(await metadata.pendingConflicts()).toEqual([]);
    await metadata.clear();
    expect(await metadata.pendingConflicts()).toEqual([]);
    db.close();
  });

  it('unsupported remote renames remain step errors without blocking unrelated future sync', async () => {
    const local = new NoteStore(new MemoryNodeBackend());
    const remote = Object.assign(new FakeRemoteDriveStore(), { supportsCaseOnlyRename: false });
    const metadata = new InMemorySyncMetadataStore();
    const base = new InMemoryBaseContentStore();
    const engine = () => new SyncEngine(local, remote, metadata, base);
    await local.write('Note.md', 'original');
    expect((await engine().sync()).errors).toEqual([]);
    await local.rename('Note.md', 'note.md');
    expect((await engine().sync()).errors).toHaveLength(1);
    expect(await metadata.pendingRenames()).toEqual([]);
    await local.write('other.md', 'unrelated');
    expect((await engine().sync()).errors).toHaveLength(1);
    expect(remote.text('other.md')).toBe('unrelated');
    expect(remote.text('Note.md')).toBe('original');
    expect((await metadata.all()).some((r) => r.path === 'Note.md')).toBe(true);
  });

  it('abandons an unexecuted stale remote rename without losing its old history or blocking other notes', async () => {
    const local = new NoteStore(new MemoryNodeBackend());
    const remote = new FakeRemoteDriveStore();
    const metadata = new InMemorySyncMetadataStore();
    const base = new InMemoryBaseContentStore();
    const engine = () => new SyncEngine(local, remote, metadata, base);
    await local.write('Note.md', 'original');
    expect((await engine().sync()).errors).toEqual([]);
    const [record] = await metadata.all();
    await local.rename('Note.md', 'note.md');
    const rename = remote.rename.bind(remote);
    remote.rename = async (entry, target) => {
      remote.put(entry.path, 'concurrent drive edit', 3000);
      await rename(entry, target);
    };
    expect((await engine().sync()).errors).toHaveLength(1);
    expect(await metadata.pendingRenames()).toHaveLength(1);
    await local.write('other.md', 'unrelated');
    expect((await engine().sync()).errors.length).toBeGreaterThan(0);
    expect(await metadata.pendingRenames()).toEqual([]);
    expect(remote.text('other.md')).toBe('unrelated');
    expect(remote.text('Note.md')).toBe('concurrent drive edit');
    expect(await local.read('note.md')).toBe('original');
    expect((await metadata.all()).find((r) => r.path === 'Note.md')).toEqual({
      ...record,
      localDeleted: true,
    });
    expect(await base.get('Note.md')).toEqual(bytes('original'));
  });

  it.each([false, true])(
    'migrates already-renamed %s file/folder history without another physical move',
    async (folder) => {
      const local = new NoteStore(new MemoryNodeBackend());
      const remote = new FakeRemoteDriveStore();
      const metadata = new InMemorySyncMetadataStore();
      const otherDrive = new InMemorySyncMetadataStore();
      const base = new InMemoryBaseContentStore();
      const engine = () => new SyncEngine(local, remote, metadata, base);
      const source = folder ? 'Work' : 'Note.md';
      const target = folder ? 'work' : 'note.md';
      const oldNote = folder ? `${source}/Nested/n.md` : source;
      const newNote = folder ? `${target}/Nested/n.md` : target;
      await local.write(oldNote, 'original');
      expect((await engine().sync()).errors).toEqual([]);
      const records = await metadata.all();
      for (const record of records) await otherDrive.upsert(record);
      await local.rename(source, target);
      await remote.rename(
        (await remote.snapshot()).find((e) => e.path === source)!,
        target,
      );
      const movesBefore = remote.calls.filter((c) => c.startsWith('rename:')).length;
      expect((await engine().sync()).errors).toEqual([]);
      expect(await local.read(newNote)).toBe('original');
      expect(await metadata.all()).toEqual(
        records.map((r) => ({
          ...r,
          path: target + r.path.substring(source.length),
        })),
      );
      expect(await otherDrive.all()).toEqual(records);
      expect(await base.get(newNote)).toEqual(bytes('original'));
      expect(await base.get(oldNote)).toBeNull();
      expect(remote.calls.filter((c) => c.startsWith('rename:'))).toHaveLength(movesBefore);
      expect((await engine().sync()).errors).toEqual([]);
    },
  );

  it('replays history-only migration after a crash without overwriting a later target edit', async () => {
    let now = 1000;
    const local = new NoteStore(new MemoryNodeBackend(), () => now);
    const remote = new FakeRemoteDriveStore();
    const metadata = new InMemorySyncMetadataStore();
    const base = new InMemoryBaseContentStore();
    const engine = () => new SyncEngine(local, remote, metadata, base);
    await local.write('Work/n.md', 'original');
    expect((await engine().sync()).errors).toEqual([]);
    await local.rename('Work', 'work');
    await remote.rename(
      (await remote.snapshot()).find((e) => e.path === 'Work')!,
      'work',
    );
    const upsert = metadata.upsert.bind(metadata);
    let fail = true;
    metadata.upsert = async (record) => {
      if (fail && record.path === 'work/n.md') {
        fail = false;
        throw new Error('crash during history-only migration');
      }
      await upsert(record);
    };
    expect((await engine().sync()).errors).toHaveLength(1);
    expect((await metadata.pendingRenames())[0].historyOnly).toBe(true);
    now = 3000;
    await local.write('work/n.md', 'edited after history migration began');
    expect((await engine().sync()).errors).toEqual([]);
    expect(await local.read('work/n.md')).toBe('edited after history migration began');
    expect(remote.text('work/n.md')).toBe('edited after history migration began');
    expect((await metadata.all()).map((r) => r.path).sort()).toEqual(['work', 'work/n.md']);
    expect(await metadata.pendingRenames()).toEqual([]);
  });

  it.each(['local', 'remote'] as const)(
    'replays a %s rename interrupted before history migration without losing later edits',
    async (side) => {
      let now = 1000;
      const local = new NoteStore(new MemoryNodeBackend(), () => now);
      const remote = new FakeRemoteDriveStore();
      const metadata = new InMemorySyncMetadataStore();
      const base = new InMemoryBaseContentStore();
      const engine = () => new SyncEngine(local, remote, metadata, base);
      await local.write('Note.md', 'original');
      expect((await engine().sync()).errors).toEqual([]);
      if (side === 'local') await remote.rename((await remote.snapshot())[0], 'note.md');
      else await local.rename('Note.md', 'note.md');
      const upsert = metadata.upsert.bind(metadata);
      let fail = true;
      metadata.upsert = async (record) => {
        if (record.path === 'note.md' && fail) {
          fail = false;
          throw new Error('crash before history migration');
        }
        await upsert(record);
      };
      expect((await engine().sync()).errors).toHaveLength(1);
      expect(await metadata.pendingRenames()).toHaveLength(1);
      now = 3000;
      if (side === 'local') await local.write('note.md', 'edited after rename');
      else remote.put('note.md', 'edited after rename', now);
      expect((await engine().sync()).errors).toEqual([]);
      expect(await local.read('note.md')).toBe('edited after rename');
      expect(remote.text('note.md')).toBe('edited after rename');
      expect((await metadata.all()).map((r) => r.path)).toEqual(['note.md']);
      expect(await metadata.pendingRenames()).toEqual([]);
    },
  );

  it.each(['local', 'remote'] as const)(
    'recovers a %s subtree rename journal across a real encrypted database restart',
    async (side) => {
      const name = `rename-${crypto.randomUUID()}`;
      const key = crypto.getRandomValues(new Uint8Array(32));
      let db = await openDatabase({ name, key });
      let local = new NoteStore(new IdbNodeBackend(db), () => 1000);
      let metadata = new IdbSyncMetadataStore(db, 'drive');
      let base = new IdbBaseContentStore(db, 'drive');
      const remote = new FakeRemoteDriveStore();
      const engine = () => new SyncEngine(local, remote, metadata, base);
      await local.write('Work/n.md', 'original');
      expect((await engine().sync()).errors).toEqual([]);
      if (side === 'local')
        await remote.rename(
          (await remote.snapshot()).find((e) => e.path === 'Work')!,
          'work',
        );
      else await local.rename('Work', 'work');
      const upsert = metadata.upsert.bind(metadata);
      metadata.upsert = async (record) => {
        if (record.path === 'work') throw new Error('crash after physical move');
        await upsert(record);
      };
      expect((await engine().sync()).errors).toHaveLength(1);
      expect(await metadata.pendingRenames()).toHaveLength(1);
      db.close();
      db = await openDatabase({ name, key });
      local = new NoteStore(new IdbNodeBackend(db), () => 3000);
      metadata = new IdbSyncMetadataStore(db, 'drive');
      base = new IdbBaseContentStore(db, 'drive');
      if (side === 'local') await local.write('work/n.md', 'edited after restart');
      else remote.put('work/n.md', 'edited after restart', 3000);
      expect((await engine().sync()).errors).toEqual([]);
      expect(await local.read('work/n.md')).toBe('edited after restart');
      expect(remote.text('work/n.md')).toBe('edited after restart');
      expect(await metadata.pendingRenames()).toEqual([]);
      expect((await metadata.all()).map((r) => r.path).sort()).toEqual(['work', 'work/n.md']);
      expect(await base.get('Work/n.md')).toBeNull();
      expect(await base.get('work/n.md')).toEqual(bytes('edited after restart'));
      db.close();
    },
  );

  it('reuses an uploaded copy at the provider timestamp precision after an interrupted upload', async () => {
    let now = 1000;
    const local = new NoteStore(new MemoryNodeBackend(), () => now);
    const remote = new FakeRemoteDriveStore(1000);
    const metadata = new InMemorySyncMetadataStore();
    const base = new InMemoryBaseContentStore();
    const engine = () =>
      new SyncEngine(
        local,
        remote,
        metadata,
        base,
        '',
        '',
        () => 4000,
        () => 'cpyr0001',
      );
    await local.write('n.md', 'base');
    await engine().sync();
    now = 1234;
    await local.write('n.md', 'losing');
    remote.put('n.md', 'winning', 3000);
    const upload = remote.uploadNew.bind(remote);
    let fail = true;
    remote.uploadNew = async (path, content, modified) => {
      const result = await upload(path, content, modified);
      if (fail) {
        fail = false;
        throw new Error('crash after upload');
      }
      return result;
    };
    expect((await engine().sync()).errors).toHaveLength(1);
    expect((await engine().sync()).errors).toEqual([]);
    expect((await local.listAll()).filter((e) => e.path.includes('(conflicted copy)'))).toHaveLength(1);
    expect((await local.entry('n (conflicted copy).md'))?.modifiedMillis).toBe(1234);
    expect(remote.nodes.get('n (conflicted copy).md')?.modified).toBe(1000);
    expect(await metadata.pendingConflicts()).toEqual([]);
  });

  it('repairs the winner base after a crash between its record and base writes', async () => {
    const local = new NoteStore(new MemoryNodeBackend(), () => 1000);
    const remote = new FakeRemoteDriveStore();
    const metadata = new InMemorySyncMetadataStore();
    const base = new InMemoryBaseContentStore();
    const engine = () =>
      new SyncEngine(
        local,
        remote,
        metadata,
        base,
        '',
        '',
        () => 3000,
        () => 'cpyr0001',
      );
    await local.write('n.md', 'base');
    await engine().sync();
    await local.write('n.md', 'losing');
    remote.put('n.md', 'winning', 2000);
    const put = base.put.bind(base);
    let fail = true;
    base.put = async (path, content) => {
      if (fail && path === 'n.md') {
        fail = false;
        throw new Error('crash before winner base write');
      }
      await put(path, content);
    };
    expect((await engine().sync()).errors).toHaveLength(1);
    expect(await base.get('n.md')).toEqual(bytes('base'));
    expect((await engine().sync()).errors).toEqual([]);
    expect(await base.get('n.md')).toEqual(bytes('winning'));
    expect(await metadata.pendingConflicts()).toEqual([]);
  });
});
