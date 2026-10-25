import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MarkNotesApi } from '../src/preload/api';
import {
  deleteLocalData,
  IdbBaseContentStore,
  IdbNodeBackend,
  IdbSyncMetadataStore,
  openDatabase,
  Settings,
  type Db,
} from '../src/renderer/src/data/db';
import { SyncManager } from '../src/renderer/src/data/syncManager';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { MultiDriveSync } from '../src/shared/multiDriveSync';
import { NoteStore } from '../src/shared/noteStore';
import { SyncEngine } from '../src/shared/syncEngine';
import { REMOTE_FOLDER_DELETION, type DriveAccount, type SyncRecord } from '../src/shared/types';

let counter = 0;
const newDb = () =>
  openDatabase({ name: `deferred-${++counter}`, key: crypto.getRandomValues(new Uint8Array(32)) });

const folder = (path: string, remoteId: string, extra: Partial<SyncRecord> = {}): SyncRecord => ({
  path,
  isFolder: true,
  remoteId,
  remoteVersion: '',
  localHash: '',
  syncedAt: 1,
  ...extra,
});
const file = (path: string, remoteId: string): SyncRecord => ({
  path,
  isFolder: false,
  remoteId,
  remoteVersion: 'v1',
  localHash: 'h',
  syncedAt: 1,
});

async function rawDump(name: string): Promise<string> {
  const db = await openDB(name);
  const parts: string[] = [];
  for (const store of Array.from(db.objectStoreNames as ArrayLike<string>)) {
    for (const record of await db.getAll(store)) {
      parts.push(
        JSON.stringify(record, (_k, v: unknown) =>
          v instanceof Uint8Array ? Buffer.from(v).toString('latin1') : v,
        ),
      );
    }
  }
  db.close();
  return parts.join('\n');
}

describe('encrypted deferred folder state', () => {
  it('preserves the folder and adds its notice atomically, encrypted, once per deletion', async () => {
    const name = `deferred-${++counter}`;
    const key = crypto.getRandomValues(new Uint8Array(32));
    const db = await openDatabase({ name, key });
    const metadata = new IdbSyncMetadataStore(db, 'drive-Secret');
    await metadata.upsert(folder('SecretFolder', 'remote-SecretId'));

    await metadata.preserveFolder('SecretFolder', 'remote-SecretId');
    await metadata.preserveFolder('SecretFolder', 'remote-SecretId');
    db.close();
    const dump = await rawDump(name);
    for (const secret of ['Secret', 'drive-', 'remote-']) expect(dump).not.toContain(secret);

    const reopened = await openDatabase({ name, key });
    const again = new IdbSyncMetadataStore(reopened, 'drive-Secret');
    expect((await again.all())[0].remoteFolderPreserved).toBe(true);
    const notices = await again.folderNotices();
    expect(notices).toEqual([
      { path: 'SecretFolder', remoteId: 'remote-SecretId', generation: 1, acknowledged: false, active: true },
    ]);
    await again.acknowledgeFolderNotice(1);
    expect((await again.folderNotices())[0].acknowledged).toBe(true);
    reopened.close();
  });

  it('refuses preservation without changes when the folder is back locally or its identity changed', async () => {
    const db = await newDb();
    const metadata = new IdbSyncMetadataStore(db, 'd');
    await metadata.upsert(folder('F', 'id1'));
    await expect(metadata.preserveFolder('F', 'other')).rejects.toThrow('identity');
    await new NoteStore(new IdbNodeBackend(db)).createFolder('F');
    await expect(metadata.preserveFolder('F', 'id1')).rejects.toThrow('Local tree changed');
    expect((await metadata.all())[0].remoteFolderPreserved).toBeUndefined();
    expect(await metadata.folderNotices()).toEqual([]);
    db.close();
  });

  it('keeps a notice pending when acknowledging an unknown generation', async () => {
    const db = await newDb();
    const metadata = new IdbSyncMetadataStore(db, 'd');
    await metadata.upsert(folder('F', 'id1'));
    await metadata.preserveFolder('F', 'id1');
    await expect(metadata.acknowledgeFolderNotice(7)).rejects.toThrow();
    expect((await metadata.folderNotices())[0].acknowledged).toBe(false);
    db.close();
  });

  it('retires preserved folders of every drive in one preflight, keeping descendant history', async () => {
    const db = await newDb();
    const one = new IdbSyncMetadataStore(db, 'd1');
    const two = new IdbSyncMetadataStore(db, 'd2');
    for (const [m, id] of [
      [one, 'a'],
      [two, 'b'],
    ] as const) {
      await m.upsert(folder('F', id));
      await m.upsert(folder('F/Sub', `${id}-sub`, { remoteFolderPreserved: true }));
      await m.preserveFolder('F', id);
    }
    await one.recreateFolders([
      { metadata: one, paths: ['F'] },
      { metadata: two, paths: ['F'] },
    ]);
    for (const [m, id] of [
      [one, 'a'],
      [two, 'b'],
    ] as const) {
      expect((await m.all()).map((r) => r.path)).toEqual(['F/Sub']);
      expect(await m.folderWitnesses()).toEqual([{ path: 'F', remoteId: id }]);
      expect((await m.folderNotices()).map((n) => n.active)).toEqual([false]);
    }
    db.close();
  });

  it('rejects a preflight over stores of another backend without changing either', async () => {
    const db = await newDb();
    const other = await newDb();
    const one = new IdbSyncMetadataStore(db, 'd1');
    await one.upsert(folder('F', 'a', { remoteFolderPreserved: true }));
    await expect(
      one.recreateFolders([
        { metadata: one, paths: ['F'] },
        { metadata: new IdbSyncMetadataStore(other, 'd2'), paths: ['F'] },
      ]),
    ).rejects.toThrow('one transactional');
    expect(await one.all()).toHaveLength(1);
    db.close();
    other.close();
  });

  it('retires old descendant history with a replaced folder identity, and keeps it for the same identity', async () => {
    const db = await newDb();
    const metadata = new IdbSyncMetadataStore(db, 'd');
    const base = new IdbBaseContentStore(db, 'd');
    await metadata.upsert(folder('F', 'old'));
    await metadata.upsert(file('F/a.md', 'a'));
    await metadata.upsert(file('G.md', 'g'));
    await base.put('F/a.md', new Uint8Array([1]));
    await base.put('G.md', new Uint8Array([2]));

    await metadata.recordFolder(folder('F', 'old', { syncedAt: 2 }), base);
    expect((await metadata.all()).map((r) => r.path).sort()).toEqual(['F', 'F/a.md', 'G.md']);

    await metadata.recordFolder(folder('F', 'new'), base);
    expect((await metadata.all()).map((r) => r.path).sort()).toEqual(['F', 'G.md']);
    expect(await base.get('F/a.md')).toBeNull();
    expect(await base.get('G.md')).toEqual(new Uint8Array([2]));
    db.close();
  });

  it('clears witnesses and retires notices when records are forgotten or recorded again', async () => {
    const db = await newDb();
    const metadata = new IdbSyncMetadataStore(db, 'd');
    const base = new IdbBaseContentStore(db, 'd');
    await metadata.upsert(folder('F', 'f'));
    await metadata.upsert(folder('G', 'g'));
    await metadata.preserveFolder('F', 'f');
    await metadata.preserveFolder('G', 'g');
    await metadata.forget(['F']);
    await metadata.recordFolder(folder('G', 'g'), base);
    expect(await metadata.all()).toEqual([folder('G', 'g')]);
    expect((await metadata.folderNotices()).map((n) => [n.path, n.active])).toEqual([
      ['F', false],
      ['G', false],
    ]);
    db.close();
  });

  it('moves notices and witnesses with a case-only rename, keeping their generation', async () => {
    const db = await newDb();
    const metadata = new IdbSyncMetadataStore(db, 'd');
    await metadata.upsert(folder('A/F', 'f', { remoteFolderPreserved: true }));
    await metadata.upsert(folder('A/G', 'g'));
    await metadata.preserveFolder('A/G', 'g');
    await metadata.recreateFolders([{ metadata, paths: ['A/F'] }]);
    await metadata.migrateFolderState('A', 'a');
    expect(await metadata.folderWitnesses()).toEqual([{ path: 'a/F', remoteId: 'f' }]);
    expect((await metadata.folderNotices()).map((n) => [n.path, n.generation])).toEqual([['a/G', 1]]);
    db.close();
  });

  it('clears the notices of one drive only, and all of them with the local data', async () => {
    const db = await newDb();
    const one = new IdbSyncMetadataStore(db, 'd1');
    const two = new IdbSyncMetadataStore(db, 'd2');
    for (const m of [one, two]) {
      await m.upsert(folder('F', 'f'));
      await m.preserveFolder('F', 'f');
    }
    await one.clear();
    expect(await one.folderNotices()).toEqual([]);
    expect(await two.folderNotices()).toHaveLength(1);
    await deleteLocalData(db);
    expect(await two.folderNotices()).toEqual([]);
    db.close();
  });
});

describe('deferred folder removal on encrypted stores', () => {
  async function world(drives = 1) {
    const db = await newDb();
    const local = new NoteStore(new IdbNodeBackend(db));
    const targets = Array.from({ length: drives }, (_, i) => ({
      driveId: `d${i}`,
      remote: new FakeRemoteDriveStore(),
      metadata: new IdbSyncMetadataStore(db, `d${i}`),
      base: new IdbBaseContentStore(db, `d${i}`),
    }));
    const sync = async (i = 0) => {
      const t = targets[i];
      return new SyncEngine(local, t.remote, t.metadata, t.base, t.driveId, 'device').sync();
    };
    await local.write('F/a.md', 'a\n');
    for (let i = 0; i < drives; i++) await sync(i);
    await local.delete('F');
    for (const t of targets) t.remote.remoteFolderDeletion = 'unsupported';
    return { db, local, targets, sync };
  }

  it('keeps the folder on a drive without safe deletion and notifies once', async () => {
    const { db, targets, sync } = await world();
    const [{ remote, metadata }] = targets;
    expect((await sync()).errors).toEqual([]);
    expect(remote.exists('F')).toBe(true);
    expect(remote.exists('F/a.md')).toBe(false);
    expect(await metadata.folderNotices()).toMatchObject([{ path: 'F', active: true, acknowledged: false }]);

    remote.calls.length = 0;
    expect((await sync()).errors).toEqual([]);
    expect(remote.calls).toEqual([]);
    expect(await metadata.folderNotices()).toHaveLength(1);
    db.close();
  });

  it('downloads new remote content into a preserved folder and retires its notice', async () => {
    const { db, local, targets, sync } = await world();
    const [{ remote, metadata }] = targets;
    await sync();
    remote.put('F/new.md', 'new\n');
    expect((await sync()).errors).toEqual([]);
    expect(await local.read('F/new.md')).toBe('new\n');
    expect((await metadata.all()).find((r) => r.path === 'F')?.remoteFolderPreserved).toBeUndefined();
    expect((await metadata.folderNotices()).map((n) => n.active)).toEqual([false]);
    db.close();
  });

  it('recreating the folder locally retires the history of every drive before either deletes it', async () => {
    const { db, local, targets } = await world(2);
    const multi = new MultiDriveSync(local, 'device');
    await multi.sync(targets);
    await local.createFolder('F');
    targets[1].remote.remove('F');
    const { outcomes } = await multi.sync(targets);
    expect(outcomes.flatMap((o) => o.result?.errors ?? ['failed'])).toEqual([]);
    expect(await local.exists('F')).toBe(true);
    expect(targets.every((t) => t.remote.isFolder('F'))).toBe(true);
    for (const t of targets) expect((await t.metadata.folderNotices()).map((n) => n.active)).toEqual([false]);
    db.close();
  });

  it('a replaced remote folder identity retires the old descendant history before downloading', async () => {
    const { db, local, targets, sync } = await world();
    const [{ remote, metadata, base }] = targets;
    await sync();
    remote.remove('F');
    remote.putFolder('F');
    remote.put('F/a.md', 'replacement\n');
    expect((await sync()).errors).toEqual([]);
    expect(await local.read('F/a.md')).toBe('replacement\n');
    expect((await metadata.all()).find((r) => r.path === 'F')?.remoteId).toBe(remote.nodes.get('F')!.id);
    expect(await base.get('F/a.md')).toEqual(new TextEncoder().encode('replacement\n'));
    db.close();
  });
});

describe('remote folder deletion capability', () => {
  it('declares no safe folder deletion for any real provider', async () => {
    expect(REMOTE_FOLDER_DELETION).toEqual({
      proton: 'unsupported',
      dropbox: 'unsupported',
      onedrive: 'unsupported',
    });
  });
});

describe('SyncManager folder notices', () => {
  const DRIVE = { id: 'd1', provider: 'fake', label: 'Fake', folder: 'MarkNotes' } as unknown as DriveAccount;
  let db: Db;

  beforeEach(async () => {
    db = await newDb();
    const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
    (globalThis as { window?: unknown }).window = {
      marknotes: { providers: () => ok([]), drives: () => ok([DRIVE]) } as unknown as MarkNotesApi,
    };
  });

  it('shows pending notices until they are durably acknowledged', async () => {
    const metadata = new IdbSyncMetadataStore(db, DRIVE.id);
    await metadata.upsert(folder('F', 'f'));
    await metadata.preserveFolder('F', 'f');
    const notes = new NoteStore(new IdbNodeBackend(db));
    const manager = new SyncManager(notes, db, new Settings(db), 'device');
    await manager.init();
    const [notice] = manager.current.drives[0].folderNotices;
    expect(notice).toMatchObject({ path: 'F', acknowledged: false });

    await manager.acknowledgeFolder(DRIVE.id, { ...notice, generation: 99 });
    expect(manager.current.message).toContain('Could not acknowledge the notice for F');
    expect(manager.current.drives[0].folderNotices).toHaveLength(1);

    await manager.acknowledgeFolder(DRIVE.id, notice);
    expect(manager.current.drives[0].folderNotices).toEqual([]);
    const restarted = new SyncManager(notes, db, new Settings(db), 'device');
    await restarted.init();
    expect(restarted.current.drives[0].folderNotices).toEqual([]);
    db.close();
  });
});
