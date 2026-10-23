import {
  buildManifest,
  isAttachmentPath,
  isSyncedEntry,
  MANIFEST_PATH,
  plan,
  reconcile,
  sha256Hex,
  type Action,
  type LocalEntry,
  type Side,
} from '@marknotes/sync';
import { generateNoteId } from './frontMatter';
import { utf8 } from './hashing';
import type { NoteStore } from './noteStore';
import * as P from './paths';
import type { BaseContentStore, RemoteDriveStore, RemoteEntry, SyncMetadataStore } from './types';

/**
 * A note edited on both sides whose edits could not be merged. The newest version (`winner`) was kept at `path` and
 * the other one was saved as a new note at `copyPath`; see `ConflictMergeBack` to merge it back.
 */
export interface SyncConflict {
  path: string;
  copyPath: string;
  winner: Side;
  /** Text of the note the last time both sides agreed, if known. */
  baseText: string | null;
  /** The drive the conflict was found on. */
  driveId: string;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: SyncConflict[];
  errors: string[];
  merged: number;
  /** Local folders created for folders found on the drive. */
  foldersCreated: number;
}

/** Number of changes made to the local note tree (conflicted copies and folders included), which other drives need. */
export const localChanges = (r: SyncResult) =>
  r.downloaded + r.deletedLocal + r.merged + r.conflicts.length + r.foldersCreated;

export function summary(r: SyncResult): string {
  let s = `↑${r.uploaded} ↓${r.downloaded}`;
  if (r.merged > 0) s += `, merged ${r.merged}`;
  if (r.deletedLocal + r.deletedRemote > 0) s += `, deleted ${r.deletedLocal + r.deletedRemote}`;
  if (r.conflicts.length > 0) s += `, ${r.conflicts.length} conflicted copy(ies)`;
  if (r.errors.length > 0) s += `, ${r.errors.length} error(s)`;
  return s;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e));

/** Attachments are named after the SHA-256 of their bytes: a download that doesn't match is rejected. */
function checkAttachment(path: string, bytes: Uint8Array) {
  if (!isAttachmentPath(path)) return;
  const expected = P.name(path).split('.')[0];
  if (sha256Hex(bytes) !== expected) throw new Error("downloaded bytes don't match the attachment name");
}

/**
 * Two-way sync between the local note tree and one drive.
 *
 * The plan and the conflict handling come from the shared sync core
 * ([marknotes-sync](https://github.com/MaxDac/marknotes-sync)), which implements the marknotes-spec sync rules for
 * every MarkNotes app. This class only lists both sides, runs the planned actions against the stores and writes the
 * drive's `.marknotes/manifest.json`.
 */
export class SyncEngine {
  constructor(
    readonly local: NoteStore,
    readonly remote: RemoteDriveStore,
    readonly metadata: SyncMetadataStore,
    readonly base: BaseContentStore,
    readonly driveId = '',
    readonly deviceId = '',
    readonly clock: () => number = Date.now,
    readonly newId: () => string = () => generateNoteId(),
  ) {}

  sync(): Promise<SyncResult> {
    return new SyncRun(this).execute();
  }
}

class SyncRun {
  private uploaded = 0;
  private downloaded = 0;
  private deletedLocal = 0;
  private deletedRemote = 0;
  private merged = 0;
  private foldersCreated = 0;
  private readonly conflicts: SyncConflict[] = [];
  private readonly errors: string[] = [];
  private readonly modified = new Map<string, number>();
  /** SHA-256 of every local file the plan saw, by path. */
  private readonly planned = new Map<string, string>();
  private readonly knownPaths = new Set<string>();

  constructor(private readonly e: SyncEngine) {}

  async execute(): Promise<SyncResult> {
    const { local, remote, metadata } = this.e;
    const localEntries: LocalEntry[] = [];
    for (const entry of await local.listAll()) {
      if (!isSyncedEntry(entry.path, entry.isFolder)) continue;
      this.modified.set(entry.path, entry.modifiedMillis);
      const sha256 = entry.isFolder ? null : sha256Hex(await local.readBytes(entry.path));
      if (sha256 !== null) this.planned.set(entry.path, sha256);
      localEntries.push({
        path: entry.path,
        isFolder: entry.isFolder,
        modifiedMillis: entry.modifiedMillis,
        sha256,
      });
    }
    const remoteEntries = (await remote.snapshot()).map(toCore);
    for (const entry of [...localEntries, ...remoteEntries]) this.knownPaths.add(entry.path);
    const manifest = await this.readManifest();

    const { actions } = plan({
      local: localEntries,
      remote: remoteEntries,
      records: await metadata.all(),
      manifest,
    });
    for (const action of actions) await this.guarded(action.path, () => this.apply(action));

    await this.guarded(MANIFEST_PATH, async () => {
      const json = buildManifest(await metadata.all(), this.e.deviceId, this.e.clock(), manifest);
      // null (undefined from the WASM binding) means unchanged.
      if (json != null) await remote.writeManifest(utf8.encode(json));
    });

    return {
      uploaded: this.uploaded,
      downloaded: this.downloaded,
      deletedLocal: this.deletedLocal,
      deletedRemote: this.deletedRemote,
      conflicts: this.conflicts,
      errors: this.errors,
      merged: this.merged,
      foldersCreated: this.foldersCreated,
    };
  }

  private async readManifest(): Promise<string | null> {
    try {
      const bytes = await this.e.remote.readManifest();
      return bytes ? utf8.decode(bytes) : null;
    } catch {
      // The manifest is an optimisation: sync works without it.
      return null;
    }
  }

  private async guarded(path: string, block: () => Promise<void>) {
    try {
      await block();
    } catch (e) {
      this.errors.push(`${path}: ${errorMessage(e)}`);
    }
  }

  /** SHA-256 of the local file at `path` now; undefined when it is missing or a folder. */
  private async localHash(path: string): Promise<string | undefined> {
    const entry = await this.e.local.entry(path);
    if (!entry || entry.isFolder) return undefined;
    return sha256Hex(await this.e.local.readBytes(path));
  }

  /**
   * True when the local file still has `expected` hash (undefined: still missing). Checked before every local write
   * or delete: an edit saved since planning is never overwritten, the step is left for the next sync.
   */
  private async localIs(path: string, expected = this.planned.get(path)): Promise<boolean> {
    return (await this.localHash(path)) === expected;
  }

  /** True when no file below `folder` was added, changed or removed locally since planning. */
  private async localTreeUnchanged(folder: string): Promise<boolean> {
    const below = (path: string) => path === folder || P.isAncestor(folder, path);
    const now = (await this.e.local.listAll()).filter(
      (e) => !e.isFolder && below(e.path) && isSyncedEntry(e.path, false),
    );
    if (now.length !== [...this.planned.keys()].filter(below).length) return false;
    for (const e of now) if (!(await this.localIs(e.path))) return false;
    return true;
  }

  private async mtime(path: string): Promise<number | undefined> {
    return (await this.e.local.entry(path))?.modifiedMillis;
  }

  private async apply(action: Action): Promise<void> {
    const { local, remote, base } = this.e;
    switch (action.kind) {
      case 'error':
        this.errors.push(`${action.path}: ${action.message}`);
        return;
      case 'recordFolder':
        return this.recordFolder(action.path, action.remoteId);
      case 'createRemoteFolder':
        return this.recordFolder(action.path, (await remote.createFolder(action.path)).id);
      case 'createLocalFolder':
        await local.createFolder(action.path);
        this.foldersCreated++;
        return this.recordFolder(action.path, action.remoteId);
      case 'forget':
        return this.forget(action.path);
      case 'uploadNew': {
        const bytes = await local.readBytes(action.path);
        const entry = await remote.uploadNew(action.path, bytes, await this.mtime(action.path));
        await this.recordFile(action.path, entry, bytes);
        this.uploaded++;
        return;
      }
      case 'uploadRevision': {
        const bytes = await local.readBytes(action.path);
        const entry = await remote.uploadRevision(action.remote, bytes, await this.mtime(action.path));
        await this.recordFile(action.path, entry, bytes);
        this.uploaded++;
        return;
      }
      case 'download': {
        const bytes = await remote.download(action.remote);
        checkAttachment(action.path, bytes);
        if (!(await this.localIs(action.path))) return;
        await local.writeBytes(action.path, bytes, action.remote.modifiedMillis || undefined);
        await this.recordFile(action.path, action.remote, bytes);
        this.downloaded++;
        return;
      }
      case 'record':
        if (action.updateBase) {
          const bytes = await local.readBytes(action.path);
          if (sha256Hex(bytes) !== action.sha256) return;
          await this.upsertFile(action.path, action.remote, action.sha256);
          await base.put(action.path, bytes);
        } else {
          await this.upsertFile(action.path, action.remote, action.sha256);
        }
        return;
      case 'deleteLocal':
        if (!(await this.localIs(action.path))) return;
        await local.delete(action.path);
        await this.forget(action.path);
        this.deletedLocal++;
        return;
      case 'deleteRemote':
        await remote.delete(action.remote);
        await this.forget(action.path);
        this.deletedRemote++;
        return;
      case 'deleteLocalFolder':
        if (!(await this.localTreeUnchanged(action.path))) return;
        await local.delete(action.path);
        await this.forgetTree(action.path, action.forget);
        this.deletedLocal++;
        return;
      case 'deleteRemoteFolder':
        await remote.delete(action.remote);
        await this.forgetTree(action.path, action.forget);
        this.deletedRemote++;
        return;
      case 'reconcile':
        return this.reconcileNote(action.path, action.remote, action.hasRecord);
    }
  }

  /** The note changed on both sides: keep it, merge it, or keep the newest and save the other as a copy. */
  private async reconcileNote(path: string, entry: RemoteEntry, hasRecord: boolean) {
    const { local, remote, base } = this.e;
    const localBytes = await local.readBytes(path);
    const localHash = sha256Hex(localBytes);
    const remoteBytes = await remote.download(entry);
    const baseBytes = hasRecord ? await base.get(path) : null;
    const baseText = baseBytes ? utf8.decode(baseBytes) : null;
    const outcome = reconcile({
      path,
      local: utf8.decode(localBytes),
      localModifiedMillis: (await this.mtime(path)) ?? this.modified.get(path) ?? 0,
      remote: utf8.decode(remoteBytes),
      remoteEntry: toCore(entry),
      base: baseText,
      existingPaths: [...this.knownPaths],
      newId: this.e.newId(),
    });
    switch (outcome.kind) {
      case 'same':
        await this.recordFile(path, entry, localBytes);
        return;
      case 'merged': {
        const bytes = utf8.encode(outcome.text);
        if (!(await this.localIs(path, localHash))) return;
        const now = this.e.clock();
        await local.writeBytes(path, bytes, now);
        await this.recordFile(path, await remote.uploadRevision(entry, bytes, now), bytes);
        this.merged++;
        return;
      }
      case 'newestWins': {
        // The losing version is saved locally as the conflicted copy before the note is overwritten.
        if (!(await this.localIs(path, localHash))) return;
        const copyBytes = utf8.encode(outcome.copyText);
        if (await local.exists(outcome.copyPath)) throw new Error(`${outcome.copyPath} already exists`);
        await local.writeBytes(outcome.copyPath, copyBytes);
        this.knownPaths.add(outcome.copyPath);
        if (outcome.winner === 'local') {
          const uploaded = await remote.uploadRevision(entry, localBytes, await this.mtime(path));
          await this.recordFile(path, uploaded, localBytes);
          this.uploaded++;
        } else {
          // An edit saved meanwhile is kept; the copy stays as a new note for the next sync.
          if (!(await this.localIs(path, localHash))) return;
          await local.writeBytes(path, remoteBytes, entry.modifiedMillis || undefined);
          await this.recordFile(path, entry, remoteBytes);
          this.downloaded++;
        }
        this.conflicts.push({
          path,
          copyPath: outcome.copyPath,
          winner: outcome.winner,
          baseText,
          driveId: this.e.driveId,
        });
        const copy = await remote.uploadNew(outcome.copyPath, copyBytes, await this.mtime(outcome.copyPath));
        await this.recordFile(outcome.copyPath, copy, copyBytes);
        this.uploaded++;
        return;
      }
    }
  }

  /** Records a synced file and, for notes, keeps `bytes` as the base copy for later merges. */
  private async recordFile(path: string, entry: RemoteEntry, bytes: Uint8Array) {
    await this.upsertFile(path, entry, sha256Hex(bytes));
    if (!isAttachmentPath(path)) await this.e.base.put(path, bytes);
  }

  private async upsertFile(path: string, entry: RemoteEntry, hash: string) {
    await this.e.metadata.upsert({
      path,
      isFolder: false,
      remoteId: entry.id,
      remoteVersion: entry.version,
      localHash: hash,
      syncedAt: this.e.clock(),
    });
  }

  private async recordFolder(path: string, remoteId: string) {
    await this.e.metadata.upsert({
      path,
      isFolder: true,
      remoteId,
      remoteVersion: '',
      localHash: '',
      syncedAt: this.e.clock(),
    });
  }

  private async forget(path: string) {
    await this.e.metadata.delete(path);
    await this.e.base.delete(path);
  }

  private async forgetTree(folder: string, paths: string[]) {
    for (const p of paths) await this.e.metadata.delete(p);
    await this.e.base.delete(folder);
  }
}

/** Only the fields the core knows: drive stores may return richer entries. */
const toCore = (e: RemoteEntry): RemoteEntry => ({
  path: e.path,
  id: e.id,
  isFolder: e.isFolder,
  version: e.version,
  modifiedMillis: e.modifiedMillis,
});
