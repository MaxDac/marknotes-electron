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
}

/** Number of changes made to the local note tree (conflicted copies included), which other drives need. */
export const localChanges = (r: SyncResult) => r.downloaded + r.deletedLocal + r.merged + r.conflicts.length;

export function summary(r: SyncResult): string {
  let s = `↑${r.uploaded} ↓${r.downloaded}`;
  if (r.merged > 0) s += `, merged ${r.merged}`;
  if (r.deletedLocal + r.deletedRemote > 0) s += `, deleted ${r.deletedLocal + r.deletedRemote}`;
  if (r.conflicts.length > 0) s += `, ${r.conflicts.length} conflicted copy(ies)`;
  if (r.errors.length > 0) s += `, ${r.errors.length} error(s)`;
  return s;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message || e.name : String(e));

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
  private readonly conflicts: SyncConflict[] = [];
  private readonly errors: string[] = [];
  private readonly modified = new Map<string, number>();
  private readonly knownPaths = new Set<string>();

  constructor(private readonly e: SyncEngine) {}

  async execute(): Promise<SyncResult> {
    const { local, remote, metadata } = this.e;
    const localEntries: LocalEntry[] = [];
    for (const entry of await local.listAll()) {
      if (!isSyncedEntry(entry.path, entry.isFolder)) continue;
      this.modified.set(entry.path, entry.modifiedMillis);
      const sha256 = entry.isFolder ? null : sha256Hex(await local.readBytes(entry.path));
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
        return this.recordFolder(action.path, action.remoteId);
      case 'forget':
        return this.forget(action.path);
      case 'uploadNew': {
        const bytes = await local.readBytes(action.path);
        await this.recordFile(action.path, await remote.uploadNew(action.path, bytes), bytes);
        this.uploaded++;
        return;
      }
      case 'uploadRevision': {
        const bytes = await local.readBytes(action.path);
        await this.recordFile(action.path, await remote.uploadRevision(action.remote, bytes), bytes);
        this.uploaded++;
        return;
      }
      case 'download': {
        const bytes = await remote.download(action.remote);
        await local.writeBytes(action.path, bytes);
        await this.recordFile(action.path, action.remote, bytes);
        this.downloaded++;
        return;
      }
      case 'record':
        await this.upsertFile(action.path, action.remote, action.sha256);
        if (action.updateBase) await base.put(action.path, await local.readBytes(action.path));
        return;
      case 'deleteLocal':
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
    const remoteBytes = await remote.download(entry);
    const baseBytes = hasRecord ? await base.get(path) : null;
    const baseText = baseBytes ? utf8.decode(baseBytes) : null;
    const outcome = reconcile({
      path,
      local: utf8.decode(localBytes),
      localModifiedMillis: this.modified.get(path) ?? 0,
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
        await local.writeBytes(path, bytes);
        await this.recordFile(path, await remote.uploadRevision(entry, bytes), bytes);
        this.merged++;
        return;
      }
      case 'newestWins': {
        if (outcome.winner === 'local') {
          await this.recordFile(path, await remote.uploadRevision(entry, localBytes), localBytes);
          this.uploaded++;
        } else {
          await local.writeBytes(path, remoteBytes);
          await this.recordFile(path, entry, remoteBytes);
          this.downloaded++;
        }
        const copyBytes = utf8.encode(outcome.copyText);
        await local.writeBytes(outcome.copyPath, copyBytes);
        this.knownPaths.add(outcome.copyPath);
        await this.recordFile(
          outcome.copyPath,
          await remote.uploadNew(outcome.copyPath, copyBytes),
          copyBytes,
        );
        this.uploaded++;
        this.conflicts.push({
          path,
          copyPath: outcome.copyPath,
          winner: outcome.winner,
          baseText,
          driveId: this.e.driveId,
        });
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
