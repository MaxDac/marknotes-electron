import { isAttachmentPath } from './attachments';
import { sha256Hex, utf8 } from './hashing';
import { MANIFEST_PATH, SyncManifest, type ManifestEntry } from './manifest';
import { merge3, type MergeResult } from './merge';
import type { NoteEntry, NoteStore } from './noteStore';
import * as P from './paths';
import type { BaseContentStore, RemoteDriveStore, RemoteEntry, SyncMetadataStore, SyncRecord } from './types';

export const CONFLICT_SUFFIX = ' (conflicted copy)';

/** A note changed on both sides since the last sync, with edits that could not be merged automatically. */
export class SyncConflict {
  private mergeCache?: MergeResult;

  constructor(
    readonly path: string,
    readonly localContent: Uint8Array,
    readonly remoteContent: Uint8Array,
    readonly remote: RemoteEntry,
    readonly baseContent: Uint8Array | null = null,
    readonly driveId = '',
  ) {}

  get localText() {
    return utf8.decode(this.localContent);
  }
  get remoteText() {
    return utf8.decode(this.remoteContent);
  }
  get baseText() {
    return this.baseContent ? utf8.decode(this.baseContent) : null;
  }

  /** Three-way merge of the two versions; only the overlapping edits are left as conflicts. */
  get merge(): MergeResult {
    this.mergeCache ??= merge3(this.baseText, this.localText, this.remoteText);
    return this.mergeCache;
  }
}

export type ConflictResolution =
  | { kind: 'keepLocal' }
  | { kind: 'keepRemote' }
  /** Keeps the local version and saves the remote one as a "(conflicted copy)" sibling. */
  | { kind: 'keepBoth' }
  /** Saves `text` on both sides. */
  | { kind: 'merged'; text: string };

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: SyncConflict[];
  errors: string[];
  merged: number;
}

/** Number of changes made to the local note tree, which other drives need to receive. */
export const localChanges = (r: SyncResult) => r.downloaded + r.deletedLocal + r.merged;

export function summary(r: SyncResult): string {
  let s = `↑${r.uploaded} ↓${r.downloaded}`;
  if (r.merged > 0) s += `, merged ${r.merged}`;
  if (r.deletedLocal + r.deletedRemote > 0) s += `, deleted ${r.deletedLocal + r.deletedRemote}`;
  if (r.conflicts.length > 0) s += `, ${r.conflicts.length} conflict(s)`;
  if (r.errors.length > 0) s += `, ${r.errors.length} error(s)`;
  return s;
}

export function isSyncablePath(path: string): boolean {
  try {
    return path !== '' && P.normalize(path) === path;
  } catch {
    return false;
  }
}

/** Folders, markdown notes and attachments are synced; every other file is ignored. */
function isSyncedEntry(path: string, isFolder: boolean): boolean {
  return isFolder || P.isNote(path) || isAttachmentPath(path);
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e));

/**
 * Two-way sync between the local note tree and a remote folder. Port of the Android SyncEngine:
 * compares the local state, the remote state and the record saved the last time both sides agreed.
 */
export class SyncEngine {
  constructor(
    private readonly local: NoteStore,
    private readonly remote: RemoteDriveStore,
    private readonly metadata: SyncMetadataStore,
    private readonly base: BaseContentStore,
    readonly driveId = '',
    readonly deviceId = '',
    private readonly clock: () => number = Date.now,
  ) {}

  sync(): Promise<SyncResult> {
    return new SyncRun(this).execute();
  }

  async resolve(conflict: SyncConflict, resolution: ConflictResolution): Promise<void> {
    switch (resolution.kind) {
      case 'keepLocal':
        await this.keepLocal(conflict);
        break;
      case 'keepRemote':
        await this.local.writeBytes(conflict.path, conflict.remoteContent);
        await this.recordFile(conflict.path, conflict.remote, conflict.remoteContent);
        break;
      case 'keepBoth': {
        const copyPath = await this.local.uniqueSibling(conflict.path, CONFLICT_SUFFIX);
        await this.local.writeBytes(copyPath, conflict.remoteContent);
        const copy = await this.remote.uploadNew(copyPath, conflict.remoteContent);
        await this.recordFile(copyPath, copy, conflict.remoteContent);
        await this.keepLocal(conflict);
        break;
      }
      case 'merged': {
        const bytes = utf8.encode(resolution.text);
        await this.local.writeBytes(conflict.path, bytes);
        const updated = await this.remote.uploadRevision(conflict.remote, bytes);
        await this.recordFile(conflict.path, updated, bytes);
        break;
      }
    }
  }

  private async keepLocal(conflict: SyncConflict) {
    const bytes = await this.local.readBytes(conflict.path);
    const updated = await this.remote.uploadRevision(conflict.remote, bytes);
    await this.recordFile(conflict.path, updated, bytes);
  }

  /** @internal */
  async recordFile(path: string, entry: RemoteEntry, content: Uint8Array | string) {
    const hash = typeof content === 'string' ? content : await sha256Hex(content);
    await this.metadata.upsert({
      path,
      isFolder: false,
      remoteId: entry.id,
      remoteVersion: entry.version,
      localHash: hash,
      syncedAt: this.clock(),
    });
    // Attachments are immutable and never merged, so they need no merge ancestor.
    if (typeof content !== 'string' && !isAttachmentPath(path)) await this.base.put(path, content);
  }

  /** @internal */
  get deps() {
    return this as unknown as {
      local: NoteStore;
      remote: RemoteDriveStore;
      metadata: SyncMetadataStore;
      base: BaseContentStore;
      driveId: string;
      deviceId: string;
      clock: () => number;
    };
  }
}

class SyncRun {
  private uploaded = 0;
  private downloaded = 0;
  private deletedLocal = 0;
  private deletedRemote = 0;
  private merged = 0;
  private conflicts: SyncConflict[] = [];
  private errors: string[] = [];
  private localHashes = new Map<string, string>();

  private localAll: NoteEntry[] = [];
  private remoteAll: RemoteEntry[] = [];
  private records = new Map<string, SyncRecord>();
  private localFolders = new Set<string>();
  private localFiles = new Set<string>();
  private remoteFolders = new Map<string, RemoteEntry>();
  private remoteFiles = new Map<string, RemoteEntry>();
  private manifest: SyncManifest | null = null;
  private skipped = new Set<string>();
  private pendingLocalFolderDeletes = new Set<string>();
  private pendingRemoteFolderDeletes = new Map<string, RemoteEntry>();

  private readonly d;

  constructor(private readonly engine: SyncEngine) {
    this.d = engine.deps;
  }

  async execute(): Promise<SyncResult> {
    const { local, remote, metadata } = this.d;
    this.localAll = (await local.listAll()).filter((e) => isSyncedEntry(e.path, e.isFolder));
    this.remoteAll = (await remote.snapshot()).filter(
      (e) => isSyncablePath(e.path) && isSyncedEntry(e.path, e.isFolder),
    );
    this.records = new Map((await metadata.all()).map((r) => [r.path, r]));
    this.manifest = await this.readManifest();

    for (const e of this.localAll) (e.isFolder ? this.localFolders : this.localFiles).add(e.path);
    for (const e of this.remoteAll) (e.isFolder ? this.remoteFolders : this.remoteFiles).set(e.path, e);

    for (const p of [
      ...[...this.localFolders].filter((p) => this.remoteFiles.has(p)),
      ...[...this.localFiles].filter((p) => this.remoteFolders.has(p)),
    ]) {
      this.skipped.add(p);
      this.errors.push(`${p}: is a file on one side and a folder on the other`);
    }

    const recorded = [...this.records.values()];
    // Phase 1: folders, parents first.
    const folderPaths = new Set([
      ...this.localFolders,
      ...this.remoteFolders.keys(),
      ...recorded.filter((r) => r.isFolder).map((r) => r.path),
    ]);
    for (const path of [...folderPaths].sort(P.compareByDepthThenPath)) {
      if (!this.skipped.has(path)) await this.guarded(path, () => this.syncFolder(path));
    }

    // Phase 2: notes and attachments.
    const filePaths = new Set([
      ...this.localFiles,
      ...this.remoteFiles.keys(),
      ...recorded.filter((r) => !r.isFolder).map((r) => r.path),
    ]);
    for (const path of [...filePaths].sort()) {
      if (!this.skipped.has(path)) await this.guarded(path, () => this.syncNote(path));
    }

    // Phase 3: folder deletions, top-most folders only.
    await this.applyFolderDeletes();

    // Phase 4: publish the map of synced notes.
    await this.guarded(MANIFEST_PATH, () => this.writeManifest());

    return {
      uploaded: this.uploaded,
      downloaded: this.downloaded,
      deletedLocal: this.deletedLocal,
      deletedRemote: this.deletedRemote,
      conflicts: this.conflicts,
      errors: this.errors,
      merged: this.merged,
    };
  }

  private async readManifest(): Promise<SyncManifest | null> {
    try {
      const bytes = await this.d.remote.readManifest();
      return bytes ? SyncManifest.parse(utf8.decode(bytes)) : null;
    } catch {
      // The manifest is an optimisation: sync works without it.
      return null;
    }
  }

  private async writeManifest() {
    const files: Record<string, ManifestEntry> = {};
    for (const r of await this.d.metadata.all()) {
      if (!r.isFolder)
        files[r.path] = { sha256: r.localHash, version: r.remoteVersion, syncedAt: r.syncedAt };
    }
    const updated = new SyncManifest(this.d.deviceId, this.d.clock(), files);
    if (!updated.sameFilesAs(this.manifest)) await this.d.remote.writeManifest(utf8.encode(updated.toJson()));
  }

  private manifestHash(remoteFile: RemoteEntry): string | undefined {
    const e = this.manifest?.files[remoteFile.path];
    return e && e.version === remoteFile.version ? e.sha256 : undefined;
  }

  private async recordFolder(path: string, remoteId: string) {
    await this.d.metadata.upsert({
      path,
      isFolder: true,
      remoteId,
      remoteVersion: '',
      localHash: '',
      syncedAt: this.d.clock(),
    });
  }

  private async forget(path: string) {
    await this.d.metadata.delete(path);
    await this.d.base.delete(path);
  }

  private async syncFolder(path: string) {
    const inLocal = this.localFolders.has(path);
    const remoteFolder = this.remoteFolders.get(path);
    const r = this.records.get(path);
    const record = r?.isFolder ? r : undefined;
    if (inLocal && remoteFolder) {
      if (!record || record.remoteId !== remoteFolder.id) await this.recordFolder(path, remoteFolder.id);
    } else if (inLocal) {
      if (!record || (await this.hasLocalSurvivors(path))) {
        const created = await this.d.remote.createFolder(path);
        await this.recordFolder(path, created.id);
      } else {
        this.pendingLocalFolderDeletes.add(path);
      }
    } else if (remoteFolder) {
      if (!record || this.hasRemoteSurvivors(path)) {
        await this.d.local.createFolder(path);
        await this.recordFolder(path, remoteFolder.id);
      } else {
        this.pendingRemoteFolderDeletes.set(path, remoteFolder);
      }
    } else {
      await this.d.metadata.delete(path);
    }
  }

  private async syncNote(path: string) {
    const inLocal = this.localFiles.has(path);
    const remoteFile = this.remoteFiles.get(path);
    const r = this.records.get(path);
    const record = r && !r.isFolder ? r : undefined;
    if (inLocal && remoteFile && isAttachmentPath(path))
      await this.syncAttachmentOnBothSides(path, remoteFile, record);
    else if (inLocal && remoteFile) await this.syncNoteOnBothSides(path, remoteFile, record);
    else if (inLocal) await this.syncLocalOnlyNote(path, record);
    else if (remoteFile) await this.syncRemoteOnlyNote(path, remoteFile, record);
    else await this.forget(path);
  }

  private async syncNoteOnBothSides(path: string, remoteFile: RemoteEntry, record?: SyncRecord) {
    if (!record) {
      await this.compareOrMerge(path, remoteFile, record);
      return;
    }
    const localChanged = (await this.localHash(path)) !== record.localHash;
    let remoteChanged = this.remoteChanged(remoteFile, record);
    if (remoteChanged && this.manifestHash(remoteFile) === record.localHash) {
      // A new remote version with the same content (e.g. re-uploaded by another device).
      await this.engine.recordFile(path, remoteFile, record.localHash);
      remoteChanged = false;
    }
    if (localChanged && remoteChanged) await this.compareOrMerge(path, remoteFile, record);
    else if (localChanged) await this.uploadRevision(path, remoteFile);
    else if (remoteChanged) await this.download(path, remoteFile);
  }

  /**
   * Attachments are named after the hash of their content, so both sides hold the same bytes: they are never
   * merged and never conflict. A local copy that no longer matches its record is re-uploaded.
   */
  private async syncAttachmentOnBothSides(path: string, remoteFile: RemoteEntry, record?: SyncRecord) {
    const localHash = await this.localHash(path);
    if (record && localHash !== record.localHash) await this.uploadRevision(path, remoteFile);
    else if (!record || this.remoteChanged(remoteFile, record))
      await this.engine.recordFile(path, remoteFile, localHash);
  }

  private async syncLocalOnlyNote(path: string, record?: SyncRecord) {
    if (!record || (await this.localHash(path)) !== record.localHash) {
      await this.uploadNew(path);
    } else if (this.hasPendingAncestor(path, this.pendingLocalFolderDeletes)) {
      await this.forget(path);
    } else {
      await this.d.local.delete(path);
      await this.forget(path);
      this.deletedLocal++;
    }
  }

  private async syncRemoteOnlyNote(path: string, remoteFile: RemoteEntry, record?: SyncRecord) {
    if (!record || this.remoteChanged(remoteFile, record)) {
      await this.download(path, remoteFile);
    } else if (this.hasPendingAncestor(path, new Set(this.pendingRemoteFolderDeletes.keys()))) {
      await this.forget(path);
    } else {
      await this.d.remote.delete(remoteFile);
      await this.forget(path);
      this.deletedRemote++;
    }
  }

  private async applyFolderDeletes() {
    for (const path of this.pendingLocalFolderDeletes) {
      if (this.hasPendingAncestor(path, this.pendingLocalFolderDeletes)) continue;
      await this.guarded(path, async () => {
        await this.d.local.delete(path);
        await this.forgetTree(path);
      });
    }
    const remoteKeys = new Set(this.pendingRemoteFolderDeletes.keys());
    for (const [path, entry] of this.pendingRemoteFolderDeletes) {
      if (this.hasPendingAncestor(path, remoteKeys)) continue;
      await this.guarded(path, async () => {
        await this.d.remote.delete(entry);
        await this.forgetTree(path);
      });
    }
  }

  private async guarded(path: string, block: () => Promise<void>) {
    try {
      await block();
    } catch (e) {
      this.errors.push(`${path}: ${errorMessage(e)}`);
    }
  }

  private async localHash(path: string): Promise<string> {
    let hash = this.localHashes.get(path);
    if (hash === undefined) {
      hash = await sha256Hex(await this.d.local.readBytes(path));
      this.localHashes.set(path, hash);
    }
    return hash;
  }

  private remoteChanged(entry: RemoteEntry, record: SyncRecord) {
    return entry.version !== record.remoteVersion || entry.id !== record.remoteId;
  }

  private async hasLocalSurvivors(folder: string): Promise<boolean> {
    for (const entry of this.localAll) {
      if (!P.isAncestor(folder, entry.path)) continue;
      const record = this.records.get(entry.path);
      if (entry.isFolder ? !record : !record || (await this.localHash(entry.path)) !== record.localHash) {
        return true;
      }
    }
    return false;
  }

  private hasRemoteSurvivors(folder: string): boolean {
    return this.remoteAll.some((entry) => {
      if (!P.isAncestor(folder, entry.path)) return false;
      const record = this.records.get(entry.path);
      return entry.isFolder ? !record : !record || this.remoteChanged(entry, record);
    });
  }

  private hasPendingAncestor(path: string, pending: Set<string>) {
    for (const p of pending) if (p !== path && P.isAncestor(p, path)) return true;
    return false;
  }

  private async forgetTree(folder: string) {
    for (const key of this.records.keys()) {
      if (key === folder || P.isAncestor(folder, key)) await this.d.metadata.delete(key);
    }
    await this.d.base.delete(folder);
  }

  private async uploadNew(path: string) {
    const bytes = await this.d.local.readBytes(path);
    const entry = await this.d.remote.uploadNew(path, bytes);
    await this.engine.recordFile(path, entry, bytes);
    this.uploaded++;
  }

  private async uploadRevision(path: string, remoteFile: RemoteEntry) {
    const bytes = await this.d.local.readBytes(path);
    const entry = await this.d.remote.uploadRevision(remoteFile, bytes);
    await this.engine.recordFile(path, entry, bytes);
    this.uploaded++;
  }

  private async download(path: string, remoteFile: RemoteEntry) {
    const bytes = await this.d.remote.download(remoteFile);
    await this.d.local.writeBytes(path, bytes);
    await this.engine.recordFile(path, remoteFile, bytes);
    this.downloaded++;
  }

  /** Both sides changed: identical content is just recorded, otherwise a three-way merge is attempted. */
  private async compareOrMerge(path: string, remoteFile: RemoteEntry, record?: SyncRecord) {
    const localBytes = await this.d.local.readBytes(path);
    const localHash = await this.localHash(path);
    if (this.manifestHash(remoteFile) === localHash) {
      await this.engine.recordFile(path, remoteFile, localBytes);
      return;
    }
    const remoteBytes = await this.d.remote.download(remoteFile);
    if ((await sha256Hex(remoteBytes)) === localHash) {
      await this.engine.recordFile(path, remoteFile, localBytes);
      return;
    }
    const baseBytes = record ? await this.d.base.get(path) : null;
    const conflict = new SyncConflict(path, localBytes, remoteBytes, remoteFile, baseBytes, this.d.driveId);
    if (baseBytes && !conflict.merge.hasConflicts) {
      const mergedBytes = utf8.encode(conflict.merge.text());
      await this.d.local.writeBytes(path, mergedBytes);
      const entry = await this.d.remote.uploadRevision(remoteFile, mergedBytes);
      await this.engine.recordFile(path, entry, mergedBytes);
      this.merged++;
    } else {
      this.conflicts.push(conflict);
    }
  }
}
