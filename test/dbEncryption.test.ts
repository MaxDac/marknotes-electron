import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { decodeValue, deriveDbKeys, encodeValue, open, seal } from '../src/renderer/src/data/crypto';
import {
  deleteLocalData,
  IdbBaseContentStore,
  IdbNodeBackend,
  IdbSyncMetadataStore,
  openDatabase,
  Settings,
} from '../src/renderer/src/data/db';
import { NoteStore } from '../src/shared/noteStore';

let counter = 0;
const newKey = () => crypto.getRandomValues(new Uint8Array(32));
const names = () => ({ name: `enc-${++counter}`, legacyName: `legacy-${counter}` });

/** Every byte stored in the raw database, to check that nothing readable is left in it. */
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

describe('record encryption', () => {
  it('round-trips values with byte arrays', () => {
    const value = { a: 'x', bytes: new Uint8Array([1, 2, 3]), nested: [{ b: new Uint8Array([]) }], n: null };
    expect(decodeValue(encodeValue(value))).toEqual(value);
    expect(decodeValue(encodeValue('text'))).toBe('text');
  });

  it('rejects another key and another position', async () => {
    const keys = await deriveDbKeys(newKey());
    const sealed = await seal(keys, 'nodes\u0000a', { secret: 1 });
    expect(await open(keys, 'nodes\u0000a', sealed)).toEqual({ secret: 1 });
    await expect(open(keys, 'nodes\u0000b', sealed)).rejects.toThrow();
    await expect(open(await deriveDbKeys(newKey()), 'nodes\u0000a', sealed)).rejects.toThrow();
  });
});

describe('encrypted database', () => {
  it('stores no paths, contents or drive ids in clear', async () => {
    const n = names();
    const key = newKey();
    const db = await openDatabase({ key, ...n });
    const notes = new NoteStore(new IdbNodeBackend(db));
    await notes.createChildFolder('', 'SecretFolder');
    const path = await notes.createNote('SecretFolder', 'SecretTitle');
    await notes.write(path, 'TopSecretBody');
    await new IdbSyncMetadataStore(db, 'drive-SecretDrive').upsert({
      path,
      isFolder: false,
      remoteId: 'remote-SecretId',
      remoteVersion: 'v1',
      localHash: 'hash',
      syncedAt: 1,
    });
    await new IdbBaseContentStore(db, 'drive-SecretDrive').put(path, new TextEncoder().encode('BaseSecret'));
    await new Settings(db).set('pendingConflicts', [{ path: 'SecretConflict' }]);
    db.close();

    const dump = await rawDump(n.name);
    for (const secret of ['Secret', 'TopSecretBody', 'drive-', 'remote-', 'pendingConflicts']) {
      expect(dump).not.toContain(secret);
    }

    const reopened = await openDatabase({ key, ...n });
    expect(await new NoteStore(new IdbNodeBackend(reopened)).read(path)).toBe('TopSecretBody');
    expect(await new IdbSyncMetadataStore(reopened, 'drive-SecretDrive').all()).toHaveLength(1);
    expect(await new IdbSyncMetadataStore(reopened, 'other').all()).toHaveLength(0);
    expect(await new Settings(reopened).get('pendingConflicts', [])).toEqual([{ path: 'SecretConflict' }]);
    reopened.close();

    const wrongKey = await openDatabase({ key: newKey(), ...n });
    expect(await new IdbNodeBackend(wrongKey).get(path)).toBeUndefined();
    await expect(wrongKey.getAll('nodes')).rejects.toThrow();
    wrongKey.close();
  });

  it('deletes base copies below a path', async () => {
    const db = await openDatabase({ key: newKey(), ...names() });
    const base = new IdbBaseContentStore(db, 'd');
    for (const p of ['A/x.md', 'A/B/y.md', 'AB.md']) await base.put(p, new Uint8Array([1]));
    await base.delete('A');
    expect(await base.get('A/x.md')).toBeNull();
    expect(await base.get('A/B/y.md')).toBeNull();
    expect(await base.get('AB.md')).toEqual(new Uint8Array([1]));
    db.close();
  });

  it('rotates the key when the local data is deleted, keeping the app settings', async () => {
    const n = names();
    let key = newKey();
    const db = await openDatabase({
      key,
      ...n,
      rotateKey: async () => (key = newKey()),
    });
    const old = key;
    const settings = new Settings(db);
    await settings.set('themeMode', 'dark');
    await settings.set('driveStatus:d', { lastSyncAt: 1 });
    await new NoteStore(new IdbNodeBackend(db)).createNote('', 'Gone');
    await deleteLocalData(db);
    expect(key).not.toEqual(old);
    expect(await settings.get('themeMode', 'system')).toBe('dark');
    expect(await settings.get('driveStatus:d', null)).toBeNull();
    expect(await db.getAll('nodes')).toEqual([]);
    db.close();

    const reopened = await openDatabase({ key, ...n });
    expect(await new Settings(reopened).get('themeMode', 'system')).toBe('dark');
    reopened.close();
  });
});

describe('migration of the unencrypted database', () => {
  async function createLegacy(name: string) {
    const legacy = await openDB(name, 1, {
      upgrade(db) {
        db.createObjectStore('nodes', { keyPath: 'path' });
        db.createObjectStore('syncRecords', { keyPath: ['driveId', 'path'] }).createIndex(
          'driveId',
          'driveId',
        );
        db.createObjectStore('baseContent', { keyPath: ['driveId', 'path'] }).createIndex(
          'driveId',
          'driveId',
        );
        db.createObjectStore('settings');
      },
    });
    await legacy.put('nodes', {
      path: 'Old.md',
      isFolder: false,
      modifiedMillis: 1,
      size: 3,
      content: new TextEncoder().encode('old'),
    });
    await legacy.put('syncRecords', {
      driveId: 'd1',
      path: 'Old.md',
      isFolder: false,
      remoteId: 'r',
      remoteVersion: 'v',
      localHash: 'h',
      syncedAt: 2,
    });
    await legacy.put('baseContent', { driveId: 'd1', path: 'Old.md', bytes: new Uint8Array([7]) });
    await legacy.put('settings', 'dark', 'themeMode');
    legacy.close();
  }

  it('copies every record encrypted, then deletes the old database', async () => {
    const n = names();
    await createLegacy(n.legacyName);
    const key = newKey();
    const db = await openDatabase({ key, ...n });
    expect(await new NoteStore(new IdbNodeBackend(db)).read('Old.md')).toBe('old');
    expect(await new IdbSyncMetadataStore(db, 'd1').all()).toEqual([
      { path: 'Old.md', isFolder: false, remoteId: 'r', remoteVersion: 'v', localHash: 'h', syncedAt: 2 },
    ]);
    expect(await new IdbBaseContentStore(db, 'd1').get('Old.md')).toEqual(new Uint8Array([7]));
    expect(await new Settings(db).get('themeMode', 'system')).toBe('dark');
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(n.legacyName);
    db.close();

    // A second start has nothing left to migrate.
    const again = await openDatabase({ key, ...n });
    expect(await new NoteStore(new IdbNodeBackend(again)).read('Old.md')).toBe('old');
    again.close();
  });

  it('does not copy again once migrated, but still deletes a leftover database', async () => {
    const n = names();
    await createLegacy(n.legacyName);
    const key = newKey();
    const db = await openDatabase({ key, ...n });
    await new NoteStore(new IdbNodeBackend(db)).delete('Old.md');
    db.close();

    // The old database survived (e.g. the app quit before deleting it).
    await createLegacy(n.legacyName);
    const again = await openDatabase({ key, ...n });
    expect(await new NoteStore(new IdbNodeBackend(again)).exists('Old.md')).toBe(false);
    expect((await indexedDB.databases()).map((d) => d.name)).not.toContain(n.legacyName);
    again.close();
  });
});
