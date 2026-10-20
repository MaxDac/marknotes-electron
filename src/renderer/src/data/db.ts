import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { NodeBackend, StoredNode } from '../../../shared/noteStore';
import type { BaseContentStore, SyncMetadataStore, SyncRecord } from '../../../shared/types';

interface MarkNotesDb extends DBSchema {
  nodes: { key: string; value: StoredNode };
  syncRecords: {
    key: [string, string];
    value: SyncRecord & { driveId: string };
    indexes: { driveId: string };
  };
  baseContent: {
    key: [string, string];
    value: { driveId: string; path: string; bytes: Uint8Array };
    indexes: { driveId: string };
  };
  settings: { key: string; value: unknown };
}

export type Db = IDBPDatabase<MarkNotesDb>;

export function openDatabase(name = 'marknotes'): Promise<Db> {
  return openDB<MarkNotesDb>(name, 1, {
    upgrade(db) {
      db.createObjectStore('nodes', { keyPath: 'path' });
      db.createObjectStore('syncRecords', { keyPath: ['driveId', 'path'] }).createIndex('driveId', 'driveId');
      db.createObjectStore('baseContent', { keyPath: ['driveId', 'path'] }).createIndex('driveId', 'driveId');
      db.createObjectStore('settings');
    },
  });
}

/** Note tree persisted in the `nodes` object store. */
export class IdbNodeBackend implements NodeBackend {
  constructor(private readonly db: Db) {}
  get(path: string) {
    return this.db.get('nodes', path);
  }
  all() {
    return this.db.getAll('nodes');
  }
  async apply(puts: StoredNode[], deletes: string[]) {
    const tx = this.db.transaction('nodes', 'readwrite');
    for (const d of deletes) void tx.store.delete(d);
    for (const p of puts) void tx.store.put(p);
    await tx.done;
  }
}

const below = (path: string, candidate: string) => candidate === path || candidate.startsWith(`${path}/`);

export class IdbSyncMetadataStore implements SyncMetadataStore {
  constructor(
    private readonly db: Db,
    private readonly driveId: string,
  ) {}
  async all(): Promise<SyncRecord[]> {
    const rows = await this.db.getAllFromIndex('syncRecords', 'driveId', this.driveId);
    return rows.map(({ driveId: _driveId, ...record }) => record);
  }
  async upsert(record: SyncRecord) {
    await this.db.put('syncRecords', { ...record, driveId: this.driveId });
  }
  async delete(path: string) {
    await this.db.delete('syncRecords', [this.driveId, path]);
  }
  async clear() {
    const tx = this.db.transaction('syncRecords', 'readwrite');
    for (const key of await tx.store.index('driveId').getAllKeys(this.driveId)) void tx.store.delete(key);
    await tx.done;
  }
}

export class IdbBaseContentStore implements BaseContentStore {
  constructor(
    private readonly db: Db,
    private readonly driveId: string,
  ) {}
  async get(path: string) {
    return (await this.db.get('baseContent', [this.driveId, path]))?.bytes ?? null;
  }
  async put(path: string, bytes: Uint8Array) {
    await this.db.put('baseContent', { driveId: this.driveId, path, bytes });
  }
  async delete(path: string) {
    const tx = this.db.transaction('baseContent', 'readwrite');
    for (const key of await tx.store.index('driveId').getAllKeys(this.driveId)) {
      if (below(path, key[1])) void tx.store.delete(key);
    }
    await tx.done;
  }
  async clear() {
    const tx = this.db.transaction('baseContent', 'readwrite');
    for (const key of await tx.store.index('driveId').getAllKeys(this.driveId)) void tx.store.delete(key);
    await tx.done;
  }
}

/** Small key/value settings. */
export class Settings {
  constructor(private readonly db: Db) {}
  async get<T>(key: string, fallback: T): Promise<T> {
    const value = await this.db.get('settings', key);
    return value === undefined ? fallback : (value as T);
  }
  async set(key: string, value: unknown) {
    await this.db.put('settings', value, key);
  }
  async delete(key: string) {
    await this.db.delete('settings', key);
  }
}
