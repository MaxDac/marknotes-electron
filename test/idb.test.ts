import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { NoteStore } from '../src/shared/noteStore';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { MultiDriveSync } from '../src/shared/multiDriveSync';
import {
  IdbBaseContentStore,
  IdbNodeBackend,
  IdbSyncMetadataStore,
  openDatabase,
  Settings,
  type Db,
} from '../src/renderer/src/data/db';

let db: Db;
let counter = 0;

beforeEach(async () => {
  db = await openDatabase(`test-${++counter}`);
});

describe('IndexedDB stores', () => {
  it('persists the note tree across store instances', async () => {
    const notes = new NoteStore(new IdbNodeBackend(db));
    await notes.createChildFolder('', 'Work');
    const path = await notes.createNote('Work', 'Plan');
    await notes.write(path, '# Plan');
    const again = new NoteStore(new IdbNodeBackend(db));
    expect(await again.read('Work/Plan.md')).toBe('# Plan');
    expect((await again.list('')).map((e) => e.path)).toEqual(['Work']);
    await again.move('Work/Plan.md', '');
    expect(await again.exists('Plan.md')).toBe(true);
    await again.delete('Work');
    expect(await again.listFolders()).toEqual([]);
  });

  it('keeps sync records and base content per drive', async () => {
    const a = new IdbSyncMetadataStore(db, 'a');
    const b = new IdbSyncMetadataStore(db, 'b');
    const record = {
      path: 'x.md',
      isFolder: false,
      remoteId: '1',
      remoteVersion: 'v',
      localHash: 'h',
      syncedAt: 1,
    };
    await a.upsert(record);
    await b.upsert({ ...record, remoteId: '2' });
    expect(await a.all()).toEqual([record]);
    await a.clear();
    expect(await a.all()).toEqual([]);
    expect((await b.all())[0].remoteId).toBe('2');

    const base = new IdbBaseContentStore(db, 'a');
    await base.put('dir/one.md', new Uint8Array([1]));
    await base.put('dir/sub/two.md', new Uint8Array([2]));
    await base.put('dirx.md', new Uint8Array([3]));
    await base.delete('dir');
    expect(await base.get('dir/one.md')).toBeNull();
    expect(await base.get('dir/sub/two.md')).toBeNull();
    expect(await base.get('dirx.md')).toEqual(new Uint8Array([3]));
  });

  it('stores settings', async () => {
    const settings = new Settings(db);
    expect(await settings.get('themeMode', 'system')).toBe('system');
    await settings.set('themeMode', 'dark');
    expect(await settings.get('themeMode', 'system')).toBe('dark');
  });

  it('syncs two drives through IndexedDB-backed stores', async () => {
    const notes = new NoteStore(new IdbNodeBackend(db));
    await notes.write('a.md', 'hello');
    const one = new FakeRemoteDriveStore();
    const two = new FakeRemoteDriveStore();
    two.put('b.md', 'from two');
    const sync = new MultiDriveSync(notes, 'device');
    const target = (id: string, remote: FakeRemoteDriveStore) => ({
      driveId: id,
      remote,
      metadata: new IdbSyncMetadataStore(db, id),
      base: new IdbBaseContentStore(db, id),
    });
    const outcomes = await sync.sync([target('one', one), target('two', two)]);
    expect(outcomes.every((o) => o.error === null)).toBe(true);
    expect(one.text('b.md')).toBe('from two');
    expect(two.text('a.md')).toBe('hello');
    expect(await notes.read('b.md')).toBe('from two');
  });
});
