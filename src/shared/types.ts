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

/** Abstraction over a remote drive, scoped to the synced folder. */
export interface RemoteDriveStore {
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

export class InMemorySyncMetadataStore implements SyncMetadataStore {
  private records = new Map<string, SyncRecord>();
  private intents = new Map<string, PendingConflictCopy>();
  private renames = new Map<string, PendingRename>();
  async all() {
    return [...this.records.values()];
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
  async clear() {
    this.items.clear();
  }
}
