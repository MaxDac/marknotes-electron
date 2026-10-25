import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { sameNodes, type NodeBackend, type StoredNode } from '../../../shared/noteStore';
import {
  nextGeneration,
  type BaseContentStore,
  type FolderNotice,
  type FolderRecreation,
  type FolderWitness,
  type PendingConflictCopy,
  type PendingRename,
  type SyncMetadataStore,
  type SyncRecord,
} from '../../../shared/types';
import { deriveDbKeys, open, seal, tag, type DbKeys } from './crypto';

/** Every record: `k` is a keyed tag of the logical key, `d` of the drive id; the value is AES-GCM encrypted. */
interface EncryptedRecord {
  k: string;
  d?: string;
  iv: Uint8Array;
  ct: Uint8Array;
}

type DriveStoreName =
  'syncRecords' | 'baseContent' | 'conflictIntents' | 'renameIntents' | 'folderNotices' | 'folderWitnesses';
type StoreName = 'nodes' | 'settings' | DriveStoreName;

interface EncryptedDbSchema extends DBSchema {
  nodes: { key: string; value: EncryptedRecord };
  syncRecords: { key: string; value: EncryptedRecord; indexes: { driveId: string } };
  baseContent: { key: string; value: EncryptedRecord; indexes: { driveId: string } };
  settings: { key: string; value: EncryptedRecord };
  conflictIntents: { key: string; value: EncryptedRecord; indexes: { driveId: string } };
  renameIntents: { key: string; value: EncryptedRecord; indexes: { driveId: string } };
  folderNotices: { key: string; value: EncryptedRecord; indexes: { driveId: string } };
  folderWitnesses: { key: string; value: EncryptedRecord; indexes: { driveId: string } };
}

/** The unencrypted database of earlier versions, migrated on first start. */
interface LegacyDbSchema extends DBSchema {
  nodes: { key: string; value: StoredNode };
  syncRecords: { key: [string, string]; value: SyncRecord & { driveId: string } };
  baseContent: { key: [string, string]; value: { driveId: string; path: string; bytes: Uint8Array } };
  settings: { key: string; value: unknown };
}

export const DB_NAME = 'marknotes-enc';
export const LEGACY_DB_NAME = 'marknotes';
const MIGRATED_KEY = 'legacyMigrated';

const STORES: StoreName[] = [
  'nodes',
  'syncRecords',
  'baseContent',
  'settings',
  'conflictIntents',
  'renameIntents',
  'folderNotices',
  'folderWitnesses',
];
const DRIVE_STORES: DriveStoreName[] = [
  'syncRecords',
  'baseContent',
  'conflictIntents',
  'renameIntents',
  'folderNotices',
  'folderWitnesses',
];
const driveKey = (driveId: string, path: string) => JSON.stringify([driveId, path]);
const aad = (store: StoreName, k: string) => `${store}\u0000${k}`;

export interface Put {
  key: string;
  value: unknown;
  driveId?: string;
}

export interface StoreChange {
  store: StoreName;
  puts?: Put[];
  deletes?: string[];
}

/** A record (as read with `getRaw`, undefined when missing) that must be unchanged when a transaction commits. */
export interface Expectation {
  store: StoreName;
  key: string;
  record: EncryptedRecord | undefined;
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameRecord = (a: EncryptedRecord | undefined, b: EncryptedRecord | undefined) =>
  a === undefined || b === undefined
    ? a === b
    : a.k === b.k && sameBytes(a.iv, b.iv) && sameBytes(a.ct, b.ct);

/** IndexedDB with every record encrypted by the local key (see `crypto.ts`). */
export class Db {
  constructor(
    readonly idb: IDBPDatabase<EncryptedDbSchema>,
    private keys: DbKeys,
    private readonly rotateKey?: () => Promise<Uint8Array>,
  ) {}

  private tagOf(store: StoreName, key: string) {
    return tag(this.keys, `${store}\u0000${key}`);
  }

  private driveTag(driveId: string) {
    return tag(this.keys, `drive\u0000${driveId}`);
  }

  private async sealRecord(store: StoreName, put: Put): Promise<EncryptedRecord> {
    const k = await this.tagOf(store, put.key);
    const sealed = await seal(this.keys, aad(store, k), put.value);
    return put.driveId === undefined
      ? { k, ...sealed }
      : { k, d: await this.driveTag(put.driveId), ...sealed };
  }

  private openRecord<T>(store: StoreName, record: EncryptedRecord): Promise<T> {
    return open<T>(this.keys, aad(store, record.k), record);
  }

  async get<T>(store: StoreName, key: string): Promise<T | undefined> {
    const record = await this.idb.get(store, await this.tagOf(store, key));
    return record ? this.openRecord<T>(store, record) : undefined;
  }

  /** The encrypted record (for `Expectation`s) and its value. */
  async getRaw<T>(store: StoreName, key: string): Promise<{ record?: EncryptedRecord; value?: T }> {
    const record = await this.idb.get(store, await this.tagOf(store, key));
    return record ? { record, value: await this.openRecord<T>(store, record) } : {};
  }

  async getAll<T>(store: StoreName): Promise<T[]> {
    return Promise.all((await this.idb.getAll(store)).map((r) => this.openRecord<T>(store, r)));
  }

  async getAllForDrive<T>(store: DriveStoreName, driveId: string): Promise<T[]> {
    const records = await this.idb.getAllFromIndex(store, 'driveId', await this.driveTag(driveId));
    return Promise.all(records.map((r) => this.openRecord<T>(store, r)));
  }

  /** Writes the puts and deletes in one transaction (everything is encrypted first). */
  async apply(store: StoreName, puts: Put[], deletes: string[] = []) {
    const records = await Promise.all(puts.map((p) => this.sealRecord(store, p)));
    const deleted = await Promise.all(deletes.map((key) => this.tagOf(store, key)));
    const tx = this.idb.transaction(store, 'readwrite');
    for (const k of deleted) void tx.store.delete(k);
    for (const record of records) void tx.store.put(record);
    await tx.done;
  }

  /**
   * Writes the changes of several stores in one transaction. It aborts without changes when an expected record
   * changed or a node of `absentNodes` exists (parent folders always exist, so this covers the whole subtree).
   */
  async transact(changes: StoreChange[], options: { expect?: Expectation[]; absentNodes?: string[] } = {}) {
    const sealed = await Promise.all(
      changes.map(async (c) => ({
        store: c.store,
        records: await Promise.all((c.puts ?? []).map((p) => this.sealRecord(c.store, p))),
        deleted: await Promise.all((c.deletes ?? []).map((key) => this.tagOf(c.store, key))),
      })),
    );
    const expected = await Promise.all(
      (options.expect ?? []).map(async (e) => ({ ...e, k: await this.tagOf(e.store, e.key) })),
    );
    const absent = await Promise.all((options.absentNodes ?? []).map((p) => this.tagOf('nodes', p)));
    const names = [
      ...new Set<StoreName>([
        ...sealed.map((s) => s.store),
        ...expected.map((e) => e.store),
        ...(absent.length > 0 ? ['nodes' as const] : []),
      ]),
    ];
    if (names.length === 0) return;
    const tx = this.idb.transaction(names, 'readwrite');
    let error: string | undefined;
    for (const e of expected) {
      if (!sameRecord(await tx.objectStore(e.store).get(e.k), e.record))
        error = 'Sync metadata changed during sync';
    }
    for (const k of absent) {
      if ((await tx.objectStore('nodes').getKey(k)) !== undefined) error = 'Local tree changed during sync';
    }
    if (error !== undefined) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new Error(error);
    }
    for (const s of sealed) {
      const store = tx.objectStore(s.store);
      for (const k of s.deleted) void store.delete(k);
      for (const record of s.records) void store.put(record);
    }
    await tx.done;
  }

  put(store: StoreName, key: string, value: unknown, driveId?: string) {
    return this.apply(store, [{ key, value, driveId }]);
  }

  async applyNodesIfUnchanged(expected: StoredNode[], puts: StoredNode[], deletes: string[]) {
    const before = await this.idb.getAll('nodes');
    const decoded = await Promise.all(before.map((r) => this.openRecord<StoredNode>('nodes', r)));
    if (!sameNodes(expected, decoded)) throw new Error('Local tree changed during sync');
    const records = await Promise.all(puts.map((n) => this.sealRecord('nodes', { key: n.path, value: n })));
    const keys = await Promise.all(deletes.map((p) => this.tagOf('nodes', p)));
    const tx = this.idb.transaction('nodes', 'readwrite');
    const current = await tx.store.getAll();
    const unchanged =
      current.length === before.length &&
      current.every(
        (r, i) =>
          r.k === before[i].k &&
          r.iv.length === before[i].iv.length &&
          r.ct.length === before[i].ct.length &&
          r.iv.every((b, j) => b === before[i].iv[j]) &&
          r.ct.every((b, j) => b === before[i].ct[j]),
      );
    if (!unchanged) {
      tx.abort();
      await tx.done.catch(() => undefined);
      throw new Error('Local tree changed during sync');
    }
    for (const key of keys) void tx.store.delete(key);
    for (const record of records) void tx.store.put(record);
    await tx.done;
  }

  delete(store: StoreName, key: string) {
    return this.apply(store, [], [key]);
  }

  async clearDrive(store: DriveStoreName, driveId: string) {
    const d = await this.driveTag(driveId);
    const tx = this.idb.transaction(store, 'readwrite');
    for (const k of await tx.store.index('driveId').getAllKeys(d)) void tx.store.delete(k);
    await tx.done;
  }

  async clearAll() {
    const tx = this.idb.transaction(STORES, 'readwrite');
    for (const store of STORES) void tx.objectStore(store).clear();
    await tx.done;
  }

  /**
   * Replaces the local key with a new one from the main process (when this database was opened with one), so the
   * deleted records left on disk can't be decrypted. Returns whether the key changed; the caller rewrites the data
   * it keeps.
   */
  async rotate(): Promise<boolean> {
    if (!this.rotateKey) return false;
    this.keys = await deriveDbKeys(await this.rotateKey());
    return true;
  }

  close() {
    this.idb.close();
  }
}

export interface OpenOptions {
  /** The local key (32 random bytes from the main process). */
  key: Uint8Array;
  name?: string;
  /** Asks the main process for a new local key (used when the local data is deleted). */
  rotateKey?: () => Promise<Uint8Array>;
  /** Name of the unencrypted database to migrate, if it exists. */
  legacyName?: string;
}

export async function openDatabase(options: OpenOptions): Promise<Db> {
  const idb = await openDB<EncryptedDbSchema>(options.name ?? DB_NAME, 3, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('nodes')) db.createObjectStore('nodes', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('syncRecords'))
        db.createObjectStore('syncRecords', { keyPath: 'k' }).createIndex('driveId', 'd');
      if (!db.objectStoreNames.contains('baseContent'))
        db.createObjectStore('baseContent', { keyPath: 'k' }).createIndex('driveId', 'd');
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'k' });
      if (!db.objectStoreNames.contains('conflictIntents'))
        db.createObjectStore('conflictIntents', { keyPath: 'k' }).createIndex('driveId', 'd');
      if (!db.objectStoreNames.contains('renameIntents'))
        db.createObjectStore('renameIntents', { keyPath: 'k' }).createIndex('driveId', 'd');
      if (!db.objectStoreNames.contains('folderNotices'))
        db.createObjectStore('folderNotices', { keyPath: 'k' }).createIndex('driveId', 'd');
      if (!db.objectStoreNames.contains('folderWitnesses'))
        db.createObjectStore('folderWitnesses', { keyPath: 'k' }).createIndex('driveId', 'd');
    },
  });
  const db = new Db(idb, await deriveDbKeys(options.key), options.rotateKey);
  await migrateLegacy(db, options.legacyName ?? LEGACY_DB_NAME);
  return db;
}

async function databaseExists(name: string) {
  return (await indexedDB.databases()).some((d) => d.name === name);
}

/**
 * Copies the unencrypted database of earlier versions into the encrypted one, then deletes it. Safe to interrupt:
 * the copy is redone (same record keys) until the marker setting, written last, is there.
 */
export async function migrateLegacy(db: Db, legacyName: string) {
  if (!(await databaseExists(legacyName))) return;
  if ((await db.get('settings', MIGRATED_KEY)) === undefined) {
    const legacy = await openDB<LegacyDbSchema>(legacyName);
    try {
      if (legacy.objectStoreNames.contains('nodes')) {
        const nodes = await legacy.getAll('nodes');
        await db.apply(
          'nodes',
          nodes.map((n) => ({ key: n.path, value: n })),
        );
      }
      if (legacy.objectStoreNames.contains('syncRecords')) {
        const records = await legacy.getAll('syncRecords');
        await db.apply(
          'syncRecords',
          records.map(({ driveId, ...record }) => ({
            key: driveKey(driveId, record.path),
            value: record,
            driveId,
          })),
        );
      }
      if (legacy.objectStoreNames.contains('baseContent')) {
        const base = await legacy.getAll('baseContent');
        await db.apply(
          'baseContent',
          base.map((b) => ({ key: driveKey(b.driveId, b.path), value: b, driveId: b.driveId })),
        );
      }
      if (legacy.objectStoreNames.contains('settings')) {
        const tx = legacy.transaction('settings');
        const keys = await tx.store.getAllKeys();
        const values = await tx.store.getAll();
        await tx.done;
        await db.apply(
          'settings',
          keys.map((key, i) => ({ key: String(key), value: { key: String(key), value: values[i] } })),
        );
      }
    } finally {
      legacy.close();
    }
    await new Settings(db).set(MIGRATED_KEY, true);
  }
  await deleteDB(legacyName);
}

/** Note tree persisted in the `nodes` object store. */
export class IdbNodeBackend implements NodeBackend {
  constructor(private readonly db: Db) {}
  get(path: string) {
    return this.db.get<StoredNode>('nodes', path);
  }
  all() {
    return this.db.getAll<StoredNode>('nodes');
  }
  async apply(puts: StoredNode[], deletes: string[]) {
    await this.db.apply(
      'nodes',
      puts.map((p) => ({ key: p.path, value: p })),
      deletes,
    );
  }
  applyIfUnchanged(expected: StoredNode[], puts: StoredNode[], deletes: string[]) {
    return this.db.applyNodesIfUnchanged(expected, puts, deletes);
  }
}

const below = (path: string, candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
const strictlyBelow = (path: string, candidate: string) => candidate.startsWith(`${path}/`);
const noticeKey = (driveId: string, generation: number) => driveKey(driveId, `#${generation}`);

export class IdbSyncMetadataStore implements SyncMetadataStore {
  constructor(
    private readonly db: Db,
    private readonly driveId: string,
  ) {}
  all(): Promise<SyncRecord[]> {
    return this.db.getAllForDrive<SyncRecord>('syncRecords', this.driveId);
  }
  async upsert(record: SyncRecord) {
    await this.db.put('syncRecords', driveKey(this.driveId, record.path), record, this.driveId);
  }
  async delete(path: string) {
    await this.db.delete('syncRecords', driveKey(this.driveId, path));
  }
  /** Deletes everything this drive keeps, its folder notices included (only when the drive is disconnected). */
  async clear() {
    for (const store of DRIVE_STORES)
      if (store !== 'baseContent') await this.db.clearDrive(store, this.driveId);
  }
  pendingConflicts(): Promise<PendingConflictCopy[]> {
    return this.db.getAllForDrive('conflictIntents', this.driveId);
  }
  async putConflict(conflict: PendingConflictCopy) {
    await this.db.put(
      'conflictIntents',
      driveKey(this.driveId, conflict.intent.path),
      conflict,
      this.driveId,
    );
  }
  async deleteConflict(path: string) {
    await this.db.delete('conflictIntents', driveKey(this.driveId, path));
  }
  pendingRenames(): Promise<PendingRename[]> {
    return this.db.getAllForDrive('renameIntents', this.driveId);
  }
  async putRename(rename: PendingRename) {
    await this.db.put('renameIntents', driveKey(this.driveId, rename.path), rename, this.driveId);
  }
  async deleteRename(path: string) {
    await this.db.delete('renameIntents', driveKey(this.driveId, path));
  }
  async folderNotices(): Promise<FolderNotice[]> {
    const notices = await this.db.getAllForDrive<FolderNotice>('folderNotices', this.driveId);
    return notices.sort((a, b) => a.generation - b.generation);
  }
  folderWitnesses(): Promise<FolderWitness[]> {
    return this.db.getAllForDrive<FolderWitness>('folderWitnesses', this.driveId);
  }
  async preserveFolder(path: string, remoteId: string) {
    const key = driveKey(this.driveId, path);
    const { record: raw, value: record } = await this.db.getRaw<SyncRecord>('syncRecords', key);
    if (!record?.isFolder || record.remoteId !== remoteId) throw new Error('Folder record identity changed');
    if (record.remoteFolderPreserved) return;
    const notice: FolderNotice = {
      path,
      remoteId,
      generation: nextGeneration(await this.folderNotices()),
      acknowledged: false,
      active: true,
    };
    const nKey = noticeKey(this.driveId, notice.generation);
    await this.db.transact(
      [
        { store: 'syncRecords', puts: [this.put(key, { ...record, remoteFolderPreserved: true })] },
        { store: 'folderNotices', puts: [this.put(nKey, notice)] },
      ],
      {
        expect: [
          { store: 'syncRecords', key, record: raw },
          { store: 'folderNotices', key: nKey, record: undefined },
        ],
        absentNodes: [path],
      },
    );
  }
  async acknowledgeFolderNotice(generation: number) {
    const key = noticeKey(this.driveId, generation);
    const notice = await this.db.get<FolderNotice>('folderNotices', key);
    if (!notice) throw new Error('Folder notice not found');
    await this.db.put('folderNotices', key, { ...notice, acknowledged: true }, this.driveId);
  }
  async recreateFolders(changes: FolderRecreation[]) {
    const all: StoreChange[] = [];
    const expect: Expectation[] = [];
    for (const { metadata, paths } of changes) {
      if (!(metadata instanceof IdbSyncMetadataStore) || metadata.db !== this.db)
        throw new Error('Folder recreation needs one transactional metadata backend');
      const change = await metadata.recreation(paths);
      all.push(...change.changes);
      expect.push(...change.expect);
    }
    await this.db.transact(all, { expect });
  }
  private async recreation(paths: string[]) {
    const deletes: string[] = [];
    const witnesses: Put[] = [];
    const expect: Expectation[] = [];
    const retired = new Set<string>();
    for (const path of paths) {
      const key = driveKey(this.driveId, path);
      const { record: raw, value: record } = await this.db.getRaw<SyncRecord>('syncRecords', key);
      if (!record?.isFolder || !record.remoteFolderPreserved) continue;
      deletes.push(key);
      expect.push({ store: 'syncRecords', key, record: raw });
      witnesses.push(this.put(key, { path, remoteId: record.remoteId } satisfies FolderWitness));
      retired.add(path);
    }
    const notices = await this.retiredNotices((p) => retired.has(p));
    return {
      changes: [
        { store: 'syncRecords', deletes },
        { store: 'folderWitnesses', puts: witnesses },
        { store: 'folderNotices', puts: notices },
      ] satisfies StoreChange[],
      expect,
    };
  }
  async recordFolder(record: SyncRecord, base: BaseContentStore) {
    const old = await this.db.get<SyncRecord>('syncRecords', driveKey(this.driveId, record.path));
    const retire =
      old?.isFolder && old.remoteId !== record.remoteId
        ? await this.descendantRetirement(record.path, base)
        : { records: [], copies: [], notices: [] };
    const notices = [
      ...(await this.retiredNotices((p) => p === record.path)),
      ...retire.notices.map((n) => this.put(noticeKey(this.driveId, n.generation), n)),
    ];
    await this.db.transact([
      {
        store: 'syncRecords',
        deletes: retire.records,
        puts: [this.put(driveKey(this.driveId, record.path), record)],
      },
      { store: 'baseContent', deletes: retire.copies },
      { store: 'folderNotices', puts: notices },
      { store: 'folderWitnesses', deletes: [driveKey(this.driveId, record.path)] },
    ]);
  }
  async retireFolderDescendants(path: string, base: BaseContentStore) {
    const retire = await this.descendantRetirement(path, base);
    await this.db.transact([
      { store: 'syncRecords', deletes: retire.records },
      { store: 'baseContent', deletes: retire.copies },
      {
        store: 'folderNotices',
        puts: retire.notices.map((n) => this.put(noticeKey(this.driveId, n.generation), n)),
      },
    ]);
  }
  async forget(paths: string[]) {
    const gone = new Set(paths);
    const keys = paths.map((p) => driveKey(this.driveId, p));
    await this.db.transact([
      { store: 'syncRecords', deletes: keys },
      { store: 'folderWitnesses', deletes: keys },
      { store: 'folderNotices', puts: await this.retiredNotices((p) => gone.has(p)) },
    ]);
  }
  async migrateFolderState(path: string, toPath: string) {
    const moved = (p: string) => toPath + p.substring(path.length);
    const notices = (await this.folderNotices()).filter((n) => below(path, n.path));
    const witnesses = (await this.folderWitnesses()).filter((w) => below(path, w.path));
    if (notices.length === 0 && witnesses.length === 0) return;
    await this.db.transact([
      {
        store: 'folderNotices',
        puts: notices.map((n) =>
          this.put(noticeKey(this.driveId, n.generation), { ...n, path: moved(n.path) }),
        ),
      },
      {
        store: 'folderWitnesses',
        deletes: witnesses.map((w) => driveKey(this.driveId, w.path)),
        puts: witnesses.map((w) =>
          this.put(driveKey(this.driveId, moved(w.path)), { ...w, path: moved(w.path) }),
        ),
      },
    ]);
  }
  private put(key: string, value: unknown): Put {
    return { key, value, driveId: this.driveId };
  }
  /** The active notices matching `matches`, retired (to be written in a transaction). */
  private async retiredNotices(matches: (path: string) => boolean): Promise<Put[]> {
    return (await this.folderNotices())
      .filter((n) => n.active && matches(n.path))
      .map((n) => this.put(noticeKey(this.driveId, n.generation), { ...n, active: false }));
  }
  /** The records and base copies strictly below `path` and its active descendant notices, retired. */
  private async descendantRetirement(path: string, base: BaseContentStore) {
    if (!(base instanceof IdbBaseContentStore) || base.db !== this.db || base.driveId !== this.driveId)
      throw new Error('Folder history retirement needs one transactional metadata backend');
    const records = (await this.all())
      .filter((r) => strictlyBelow(path, r.path))
      .map((r) => driveKey(this.driveId, r.path));
    const copies = (await base.paths())
      .filter((p) => strictlyBelow(path, p))
      .map((p) => driveKey(this.driveId, p));
    const notices = (await this.folderNotices())
      .filter((n) => n.active && strictlyBelow(path, n.path))
      .map((n) => ({ ...n, active: false }));
    return { records, copies, notices };
  }
}

interface BaseCopy {
  driveId: string;
  path: string;
  bytes: Uint8Array;
}

export class IdbBaseContentStore implements BaseContentStore {
  constructor(
    readonly db: Db,
    readonly driveId: string,
  ) {}
  async paths() {
    return (await this.db.getAllForDrive<BaseCopy>('baseContent', this.driveId)).map((c) => c.path);
  }
  async get(path: string) {
    return (await this.db.get<BaseCopy>('baseContent', driveKey(this.driveId, path)))?.bytes ?? null;
  }
  async put(path: string, bytes: Uint8Array) {
    await this.db.put(
      'baseContent',
      driveKey(this.driveId, path),
      { driveId: this.driveId, path, bytes },
      this.driveId,
    );
  }
  async delete(path: string) {
    const copies = await this.db.getAllForDrive<BaseCopy>('baseContent', this.driveId);
    const deletes = copies.filter((c) => below(path, c.path)).map((c) => driveKey(this.driveId, c.path));
    if (deletes.length > 0) await this.db.apply('baseContent', [], deletes);
  }
  async clear() {
    await this.db.clearDrive('baseContent', this.driveId);
  }
}

/** Settings about the app itself, not the notes: kept when the local data is deleted. */
const APP_SETTINGS = ['themeMode', 'themeColor', 'lockIdleMinutes', 'chordSequences'];

/**
 * Deletes every note, attachment, sync record and base copy stored on this device, with the sync state kept in the
 * settings, then replaces the local key so the deleted records left on disk can't be decrypted. Nothing is deleted
 * from the drives: callers disconnect them first so the deletion is never synced.
 */
export async function deleteLocalData(db: Db) {
  const settings = new Settings(db);
  const kept: [string, unknown][] = [];
  for (const key of APP_SETTINGS) {
    const value = await settings.get<unknown>(key, undefined);
    if (value !== undefined) kept.push([key, value]);
  }
  await db.clearAll();
  await db.rotate();
  for (const [key, value] of kept) await settings.set(key, value);
}

/** Deletes the local databases without reading them (forgotten passphrase or unreadable key). */
export async function deleteDatabases() {
  await deleteDB(DB_NAME);
  await deleteDB(LEGACY_DB_NAME);
}

/** Small key/value settings. */
export class Settings {
  constructor(private readonly db: Db) {}
  async get<T>(key: string, fallback: T): Promise<T> {
    const entry = await this.db.get<{ key: string; value: unknown }>('settings', key);
    return entry === undefined || entry.value === undefined ? fallback : (entry.value as T);
  }
  async set(key: string, value: unknown) {
    await this.db.put('settings', key, { key, value });
  }
  async delete(key: string) {
    await this.db.delete('settings', key);
  }
}
