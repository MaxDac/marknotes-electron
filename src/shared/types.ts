import { join } from './paths';
import type { ConflictCopyIntent, Side } from '@marknotes/sync';

/** A file or folder in the synced remote folder. `path` is relative to the synced folder. */
export interface RemoteEntry {
  path: string;
  /** Stable remote identifier. */
  id: string;
  isFolder: boolean;
  /** Identifier of the current content version; empty for folders. */
  version: string;
  modifiedMillis: number;
}

/**
 * Whether a drive can delete a folder atomically and only while it is empty (spec "Deferred drive folder removal").
 * `unsupported` keeps folders deleted locally on the drive with a one-time manual-removal notice; an omitted
 * capability means `atomicEmptyOnly`, so a failing strict delete is reported as an error.
 */
export type RemoteFolderDeletion = 'atomicEmptyOnly' | 'unsupported';

/** Dropbox, OneDrive and Proton Drive have no atomic empty-only folder deletion. */
export const REMOTE_FOLDER_DELETION: Record<DriveProvider, RemoteFolderDeletion> = {
  proton: 'unsupported',
  dropbox: 'unsupported',
  onedrive: 'unsupported',
};

/** Abstraction over a remote drive, scoped to the synced folder. */
export interface RemoteDriveStore {
  /** Declared folder deletion capability; never inferred from failed deletes. */
  readonly remoteFolderDeletion?: RemoteFolderDeletion;
  /** Known unsupported moves fail before a durable rename is reserved. */
  readonly supportsCaseOnlyRename?: boolean;
  /** Precision of provider modification times (Dropbox stores whole seconds). */
  readonly timestampResolutionMillis?: number;
  snapshot(): Promise<RemoteEntry[]>;
  download(entry: RemoteEntry): Promise<Uint8Array>;
  /**
   * Creates a file at an unoccupied `path`, failing if any entry already exists (even identical content).
   * Creates missing parent folders. `modifiedMillis` is the local edit time, stored
   * as the file's modification time (Dropbox `client_modified`, OneDrive `fileSystemInfo`, Proton claimed time).
   */
  uploadNew(path: string, bytes: Uint8Array, modifiedMillis?: number): Promise<RemoteEntry>;
  /** Uploads new content for an existing file, only if it is still at `entry.version`. */
  uploadRevision(entry: RemoteEntry, bytes: Uint8Array, modifiedMillis?: number): Promise<RemoteEntry>;
  /** Creates a folder at an unoccupied `path`, creating missing parents; never adopts an existing target. */
  createFolder(path: string): Promise<RemoteEntry>;
  /**
   * Moves the entry to the remote trash. Files are only deleted while still at `entry.version`: otherwise it
   * throws (a step error, so the record is kept and the next sync downloads the change).
   * Folders require an atomic empty-only delete; unsupported providers must throw without deleting anything.
   */
  delete(entry: RemoteEntry): Promise<void>;
  /** A stable-id, no-clobber case-only move; unsupported providers throw without mutating anything. */
  rename(entry: RemoteEntry, toPath: string): Promise<void>;
  /** Reads the sync manifest; null when missing. */
  readManifest(): Promise<Uint8Array | null>;
  /** Creates or overwrites the sync manifest. */
  writeManifest(bytes: Uint8Array): Promise<void>;
}

export class RemoteUnavailableError extends Error {
  override name = 'RemoteUnavailableError';
}

/** A conditional write or delete found the remote file at another version than the one planned. */
export class RemoteChangedError extends Error {
  override name = 'RemoteChangedError';
  constructor(path: string) {
    super(`${path} changed on the drive since the sync started`);
  }
}

export type DriveProvider = 'proton' | 'dropbox' | 'onedrive';

export const PROVIDER_NAMES: Record<DriveProvider, string> = {
  proton: 'Proton Drive',
  dropbox: 'Dropbox',
  onedrive: 'OneDrive',
};

export const DEFAULT_ROOT_FOLDER = 'MarkNotes';

/** Shown when a sign-in matches a drive that is already connected; the new sign-in replaced its session. */
export const alreadyConnectedMessage = (label: string) =>
  `${label} is already connected (its sign-in was renewed). To sync a different folder, disconnect it first.`;

/** A connected cloud drive. Every connected drive mirrors the same local note tree. */
export interface DriveAccount {
  id: string;
  provider: DriveProvider;
  label: string;
  /** Immutable provider identity, independent of the local drive id and display label. */
  providerAccountId?: string;
  /** Folder picked by the user, relative to the drive root ("" = root). */
  remoteFolder: string;
  /** Whether the app syncs into a `rootFolderName` folder created inside `remoteFolder`. */
  createRootFolder: boolean;
  rootFolderName: string;
}

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '');

/** The folder that is mirrored with the local note tree, relative to the drive root. */
export function syncFolder(
  account: Pick<DriveAccount, 'remoteFolder' | 'createRootFolder' | 'rootFolderName'>,
) {
  const folder = trimSlashes(account.remoteFolder);
  return account.createRootFolder ? join(folder, account.rootFolderName) : folder;
}

/** A folder shown by the remote folder picker. `path` is relative to the drive root. */
export interface RemoteFolder {
  path: string;
  name: string;
}

/** What we knew about a path the last time it was in sync on both sides. */
export interface SyncRecord {
  path: string;
  isFolder: boolean;
  remoteId: string;
  remoteVersion: string;
  localHash: string;
  syncedAt: number;
  localDeleted?: boolean;
  /** The folder was deleted locally but kept on a drive without safe folder deletion (missing means false). */
  remoteFolderPreserved?: boolean;
}

/**
 * Device-local manual-removal notice for a folder kept on a drive. A notice is created once per deletion
 * generation (when the folder record becomes preserved); `active` is false once that lifecycle is retired.
 */
export interface FolderNotice {
  path: string;
  remoteId: string;
  generation: number;
  acknowledged: boolean;
  active: boolean;
}

/** The drive identity of a preserved folder that was recreated locally, kept until the folder is adopted again. */
export interface FolderWitness {
  path: string;
  remoteId: string;
}

/** Preserved folders of one drive found again in the local tree. */
export interface FolderRecreation {
  metadata: SyncMetadataStore;
  paths: string[];
}

export interface SyncMetadataStore {
  all(): Promise<SyncRecord[]>;
  upsert(record: SyncRecord): Promise<void>;
  delete(path: string): Promise<void>;
  clear(): Promise<void>;
  pendingConflicts(): Promise<PendingConflictCopy[]>;
  putConflict(conflict: PendingConflictCopy): Promise<void>;
  deleteConflict(path: string): Promise<void>;
  pendingRenames(): Promise<PendingRename[]>;
  putRename(rename: PendingRename): Promise<void>;
  deleteRename(path: string): Promise<void>;
  folderNotices(): Promise<FolderNotice[]>;
  folderWitnesses(): Promise<FolderWitness[]>;
  /**
   * Marks the folder record preserved and, on the false→true transition, adds a pending notice with a new
   * generation, in one transaction. Throws without changes when the record is missing or has another identity, or
   * when a backend that sees the local tree finds the folder there again.
   */
  preserveFolder(path: string, remoteId: string): Promise<void>;
  /** Durably acknowledges a notice; a failed save throws and keeps it pending. */
  acknowledgeFolderNotice(generation: number): Promise<void>;
  /**
   * The all-drive local recreation preflight, in one transaction over every store of `changes` (one backend):
   * removes the preserved folder records, retires their active notices and keeps their drive identity as a
   * witness. Descendant records and base copies are kept.
   */
  recreateFolders(changes: FolderRecreation[]): Promise<void>;
  /**
   * Saves a folder record and clears the path's witness and active notices in one transaction. When the previous
   * record has another identity, the old descendant records, base copies and notices are retired with it.
   */
  recordFolder(record: SyncRecord, base: BaseContentStore): Promise<void>;
  /** Retires the descendant records, base copies and active notices below `path` in one transaction. */
  retireFolderDescendants(path: string, base: BaseContentStore): Promise<void>;
  /** Deletes the records of `paths`, retiring their active notices and witnesses, in one transaction. */
  forget(paths: string[]): Promise<void>;
  /** Moves the notices and witnesses at or below `path` to `toPath` (case-only rename, same generation). */
  migrateFolderState(path: string, toPath: string): Promise<void>;
}

export interface PendingRename {
  path: string;
  toPath: string;
  side: 'local' | 'remote';
  remote: RemoteEntry;
  token: string;
  historyOnly?: boolean;
  records: SyncRecord[];
  bases: { path: string; bytes: Uint8Array }[];
}

/** Written durably before any conflicted copy or winning note is changed. */
export interface PendingConflictCopy {
  intent: ConflictCopyIntent;
  copyText: string;
  localText: string;
  remoteText: string;
  remote: RemoteEntry;
  baseText: string | null;
  winner: Side;
}

/** Per drive, the content of every note the last time it was in sync (merge ancestor). */
export interface BaseContentStore {
  get(path: string): Promise<Uint8Array | null>;
  put(path: string, bytes: Uint8Array): Promise<void>;
  /** Deletes `path` and everything below it. */
  delete(path: string): Promise<void>;
  clear(): Promise<void>;
}

const isBelow = (folder: string, path: string) => path.startsWith(`${folder}/`);
const atOrBelow = (folder: string, path: string) => path === folder || isBelow(folder, path);

/** In-memory store for tests; every method changes its state synchronously, so it is atomic. */
export class InMemorySyncMetadataStore implements SyncMetadataStore {
  private records = new Map<string, SyncRecord>();
  private intents = new Map<string, PendingConflictCopy>();
  private renames = new Map<string, PendingRename>();
  private notices: FolderNotice[] = [];
  private witnesses = new Map<string, string>();
  async all() {
    return [...this.records.values()].map((r) => ({ ...r }));
  }
  async upsert(record: SyncRecord) {
    this.records.set(record.path, { ...record });
  }
  async delete(path: string) {
    this.records.delete(path);
  }
  async clear() {
    this.records.clear();
    this.intents.clear();
    this.renames.clear();
    this.notices = [];
    this.witnesses.clear();
  }
  async pendingConflicts() {
    return [...this.intents.values()];
  }
  async putConflict(conflict: PendingConflictCopy) {
    this.intents.set(conflict.intent.path, structuredClone(conflict));
  }
  async deleteConflict(path: string) {
    this.intents.delete(path);
  }
  async pendingRenames() {
    return [...this.renames.values()];
  }
  async putRename(rename: PendingRename) {
    this.renames.set(rename.path, structuredClone(rename));
  }
  async deleteRename(path: string) {
    this.renames.delete(path);
  }
  async folderNotices() {
    return this.notices.map((n) => ({ ...n }));
  }
  async folderWitnesses() {
    return [...this.witnesses].map(([path, remoteId]) => ({ path, remoteId }));
  }
  /** The local tree is not visible here: the executor rechecks that the folder is still missing first. */
  async preserveFolder(path: string, remoteId: string) {
    const record = this.records.get(path);
    if (!record?.isFolder || record.remoteId !== remoteId) throw new Error('Folder record identity changed');
    if (record.remoteFolderPreserved) return;
    this.records.set(path, { ...record, remoteFolderPreserved: true });
    this.notices.push({
      path,
      remoteId,
      generation: nextGeneration(this.notices),
      acknowledged: false,
      active: true,
    });
  }
  async acknowledgeFolderNotice(generation: number) {
    const notice = this.notices.find((n) => n.generation === generation);
    if (!notice) throw new Error('Folder notice not found');
    notice.acknowledged = true;
  }
  async recreateFolders(changes: FolderRecreation[]) {
    const stores = changes.map(({ metadata, paths }) => {
      if (!(metadata instanceof InMemorySyncMetadataStore))
        throw new Error('Folder recreation needs one transactional metadata backend');
      return { store: metadata, paths };
    });
    for (const { store, paths } of stores) {
      for (const path of paths) {
        const record = store.records.get(path);
        if (!record?.isFolder || !record.remoteFolderPreserved) continue;
        store.records.delete(path);
        store.retireNotices((p) => p === path);
        store.witnesses.set(path, record.remoteId);
      }
    }
  }
  async recordFolder(record: SyncRecord, base: BaseContentStore) {
    const copies = transactionalBase(base);
    const old = this.records.get(record.path);
    if (old?.isFolder && old.remoteId !== record.remoteId) this.retireBelow(record.path, copies);
    this.witnesses.delete(record.path);
    this.retireNotices((p) => p === record.path);
    this.records.set(record.path, { ...record });
  }
  async retireFolderDescendants(path: string, base: BaseContentStore) {
    this.retireBelow(path, transactionalBase(base));
  }
  async forget(paths: string[]) {
    const gone = new Set(paths);
    for (const path of paths) {
      this.records.delete(path);
      this.witnesses.delete(path);
    }
    this.retireNotices((p) => gone.has(p));
  }
  async migrateFolderState(path: string, toPath: string) {
    const moved = (p: string) => toPath + p.substring(path.length);
    for (const notice of this.notices) if (atOrBelow(path, notice.path)) notice.path = moved(notice.path);
    for (const [p, remoteId] of [...this.witnesses]) {
      if (!atOrBelow(path, p)) continue;
      this.witnesses.delete(p);
      this.witnesses.set(moved(p), remoteId);
    }
  }
  private retireNotices(matches: (path: string) => boolean) {
    for (const notice of this.notices) if (notice.active && matches(notice.path)) notice.active = false;
  }
  private retireBelow(path: string, base: InMemoryBaseContentStore) {
    for (const p of [...this.records.keys()]) if (isBelow(path, p)) this.records.delete(p);
    base.deleteBelow(path);
    this.retireNotices((p) => isBelow(path, p));
  }
}

/** Generations only grow per drive: retired notices are kept, so the next one is above all of them. */
export const nextGeneration = (notices: FolderNotice[]) =>
  notices.reduce((max, n) => Math.max(max, n.generation), 0) + 1;

function transactionalBase(base: BaseContentStore) {
  if (!(base instanceof InMemoryBaseContentStore))
    throw new Error('Folder history retirement needs one transactional metadata backend');
  return base;
}

export class InMemoryBaseContentStore implements BaseContentStore {
  private items = new Map<string, Uint8Array>();
  async get(path: string) {
    return this.items.get(path) ?? null;
  }
  async put(path: string, bytes: Uint8Array) {
    this.items.set(path, bytes);
  }
  async delete(path: string) {
    for (const key of [...this.items.keys()]) {
      if (key === path || key.startsWith(`${path}/`)) this.items.delete(key);
    }
  }
  /** Deletes the copies strictly below `path`, synchronously (part of a metadata transaction). */
  deleteBelow(path: string) {
    for (const key of [...this.items.keys()]) if (isBelow(path, key)) this.items.delete(key);
  }
  async clear() {
    this.items.clear();
  }
}
