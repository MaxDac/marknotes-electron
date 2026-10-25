import {
  buildManifest,
  foldCase,
  isAttachmentPath,
  isSyncedEntry,
  localDeletions,
  MANIFEST_PATH,
  plan,
  reconcile,
  recreatedFolders,
  sha256Hex,
  type Action,
  type LocalEntry,
  type Side,
  type ReconcileOutcome,
} from '@marknotes/sync';
import { generateNoteId } from './frontMatter';
import { utf8 } from './hashing';
import type { NoteStore, NoteEntry } from './noteStore';
import * as P from './paths';
import { classifySyncFailure, type SyncFailure } from './syncFailure';
import type {
  BaseContentStore,
  PendingConflictCopy,
  PendingRename,
  RemoteDriveStore,
  RemoteEntry,
  SyncMetadataStore,
} from './types';

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
  failures?: SyncFailure[];
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

/**
 * The local recreation and deletion preflight, for every drive before any of them syncs. Preserved folders found
 * again locally lose their record (keeping their drive identity as a witness) in one transaction over all drives;
 * then every record missing locally is flagged deleted.
 */
export async function flagLocalChanges(local: NoteEntry[], stores: SyncMetadataStore[]) {
  const changes = [];
  for (const metadata of stores) {
    const paths = recreatedFolders(local, await metadata.all());
    if (paths.length > 0) changes.push({ metadata, paths });
  }
  if (changes.length > 0) await changes[0].metadata.recreateFolders(changes);
  for (const metadata of stores) {
    const records = await metadata.all();
    const deleted = new Set(localDeletions(local, records));
    for (const record of records) {
      if (deleted.has(record.path) && !record.localDeleted)
        await metadata.upsert({ ...record, localDeleted: true });
    }
  }
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

  recoverRenames(): Promise<void> {
    return new SyncRun(this).recoverRenames();
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
  private readonly failures: SyncFailure[] = [];
  private readonly modified = new Map<string, number>();
  /** SHA-256 of every local file the plan saw, by path. */
  private readonly planned = new Map<string, string>();
  private readonly knownPaths = new Set<string>();
  private readonly blocked = new Set<string>();

  constructor(private readonly e: SyncEngine) {}

  async execute(): Promise<SyncResult> {
    const { local, remote, metadata } = this.e;
    await this.recoverRenames();
    await flagLocalChanges(await local.listAll(), [metadata]);
    for (const pending of await metadata.pendingConflicts()) {
      await this.guarded(pending.intent.path, async () => {
        this.blocked.add(pending.intent.path);
        this.blocked.add(pending.intent.copyPath);
        await this.replayConflict(pending);
        this.blocked.delete(pending.intent.path);
        this.blocked.delete(pending.intent.copyPath);
      });
      if (this.blocked.has(pending.intent.path)) {
        const latest = (await metadata.pendingConflicts()).find((p) => p.intent.path === pending.intent.path);
        if (latest) this.blocked.add(latest.intent.copyPath);
      }
    }
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
    await this.retireReplacedFolders(remoteEntries);
    for (const entry of [...localEntries, ...remoteEntries]) this.knownPaths.add(entry.path);
    const manifest = await this.readManifest();

    const { actions } = plan({
      local: localEntries,
      remote: remoteEntries,
      records: await metadata.all(),
      manifest,
      remoteFolderDeletion: remote.remoteFolderDeletion,
    });
    for (const action of actions) {
      if (
        ![...this.blocked].some(
          (p) => p === action.path || P.isAncestor(p, action.path) || P.isAncestor(action.path, p),
        )
      )
        await this.guarded(action.path, () => this.apply(action));
    }

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
      failures: this.failures,
      merged: this.merged,
      foldersCreated: this.foldersCreated,
    };
  }

  /**
   * A folder recreated locally whose drive folder now has another identity: the history kept below it belongs to
   * the old folder, so it is retired before planning (a folder missing from the drive is not a replacement).
   */
  private async retireReplacedFolders(remoteEntries: RemoteEntry[]) {
    for (const witness of await this.e.metadata.folderWitnesses()) {
      const listed = remoteEntries.find((e) => e.path === witness.path && e.isFolder);
      if (listed && listed.id !== witness.remoteId)
        await this.e.metadata.retireFolderDescendants(witness.path, this.e.base);
    }
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

  /** Records a per-file error; `failures` stays index-aligned with `errors`. */
  private fail(message: string, failure: SyncFailure = { kind: 'permanent' }) {
    this.errors.push(message);
    this.failures.push(failure);
  }

  private async guarded(path: string, block: () => Promise<void>) {
    try {
      await block();
    } catch (e) {
      this.fail(`${path}: ${errorMessage(e)}`, classifySyncFailure(e));
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

  private async mtime(path: string): Promise<number | undefined> {
    return (await this.e.local.entry(path))?.modifiedMillis;
  }

  private async apply(action: Action): Promise<void> {
    const { local, remote, base } = this.e;
    switch (action.kind) {
      case 'error':
        this.fail(`${action.path}: ${action.message}`);
        return;
      case 'recordFolder':
        return this.recordFolder(action.path, action.remoteId);
      case 'createRemoteFolder':
        return this.recordFolder(action.path, (await remote.createFolder(action.path)).id);
      case 'createLocalFolder':
        await local.createSyncedFolder(action.path);
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
        await local.writeSyncedBytes(
          action.path,
          bytes,
          action.remote.modifiedMillis,
          this.planned.get(action.path),
        );
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
        await local.deleteSynced(action.path, this.planned.get(action.path));
        await this.forget(action.path);
        this.deletedLocal++;
        return;
      case 'deleteRemote':
        await remote.delete(action.remote);
        await this.forget(action.path);
        this.deletedRemote++;
        return;
      case 'deleteLocalFolder':
        await local.deleteSynced(action.path);
        await this.forgetTree(action.path, action.forget);
        this.deletedLocal++;
        return;
      case 'deleteRemoteFolder':
        await remote.delete(action.remote);
        await this.forgetTree(action.path, action.forget);
        this.deletedRemote++;
        return;
      case 'preserveRemoteFolder':
        // Recreated locally since planning: the next sync adopts the drive folder again.
        if (await local.exists(action.path)) return;
        await this.e.metadata.preserveFolder(action.path, action.remote.id);
        return;
      case 'reconcile':
        return this.reconcileNote(action.path, action.remote, action.hasRecord);
      case 'renameLocal':
      case 'renameRemote': {
        if (action.kind === 'renameRemote' && remote.supportsCaseOnlyRename === false)
          throw new Error('This drive does not support a verified no-clobber case-only move');
        const records = (await this.e.metadata.all()).filter(
          (r) => r.path === action.path || P.isAncestor(action.path, r.path),
        );
        const bases: PendingRename['bases'] = [];
        for (const record of records) {
          const bytes = await base.get(record.path);
          if (bytes) bases.push({ path: record.path, bytes });
        }
        const historyOnly = action.kind === 'renameLocal' && !(await local.exists(action.path));
        const pending: PendingRename = {
          path: action.path,
          toPath: action.toPath,
          side: action.kind === 'renameLocal' ? 'local' : 'remote',
          remote: action.remote,
          token:
            (await local.syncRenameToken(historyOnly ? action.toPath : action.path)) ?? crypto.randomUUID(),
          historyOnly,
          records,
          bases,
        };
        await this.e.metadata.putRename(pending);
        await this.completeRename(pending);
        return;
      }
    }
  }

  async recoverRenames() {
    for (const pending of await this.e.metadata.pendingRenames()) await this.completeRename(pending);
  }

  private async completeRename(pending: PendingRename) {
    const { local, remote, metadata, base } = this.e;
    if (pending.side === 'local') {
      if (!(await local.hasSyncRenameToken(pending.toPath, pending.token))) {
        if (pending.historyOnly) {
          await local.markSyncedRename(
            pending.toPath,
            pending.token,
            pending.records.map((r) => ({
              path: pending.toPath + r.path.substring(pending.path.length),
              isFolder: r.isFolder,
              hash: r.localHash,
            })),
          );
        } else {
          if (!(await local.exists(pending.path)))
            throw new Error(`${pending.path}: cannot verify interrupted local rename`);
          const hashes = new Map(
            pending.records.filter((r) => !r.isFolder).map((r) => [r.path, r.localHash]),
          );
          await local.renameSynced(
            pending.path,
            pending.toPath,
            hashes,
            pending.token,
            new Set(pending.records.map((r) => r.path)),
          );
        }
      }
      this.foldersCreated++;
    } else {
      const entry = (await remote.snapshot()).find((e) => e.id === pending.remote.id);
      if (!entry || (entry.path !== pending.path && entry.path !== pending.toPath))
        throw new Error(`${pending.path}: cannot verify interrupted drive rename`);
      if (entry.path === pending.path && entry.version !== pending.remote.version) {
        const current = await metadata.all();
        const migratedPaths = new Set(
          pending.records.map((r) => pending.toPath + r.path.substring(pending.path.length)),
        );
        const untouched =
          pending.records.every((r) =>
            current.some(
              (c) =>
                c.path === r.path &&
                c.remoteId === r.remoteId &&
                c.remoteVersion === r.remoteVersion &&
                c.localHash === r.localHash &&
                c.isFolder === r.isFolder,
            ),
          ) && !current.some((r) => migratedPaths.has(r.path));
        if (!untouched)
          throw new Error(`${pending.path}: drive changed during interrupted history migration`);
        await metadata.deleteRename(pending.path);
        this.fail(`${pending.path}: changed on the drive before the case-only move`);
        return;
      }
      if (entry.path !== pending.toPath) await remote.rename(pending.remote, pending.toPath);
    }
    for (const copy of pending.bases) {
      await base.put(pending.toPath + copy.path.substring(pending.path.length), copy.bytes);
    }
    for (const record of pending.records) {
      const migrated = { ...record, path: pending.toPath + record.path.substring(pending.path.length) };
      delete migrated.localDeleted;
      await metadata.upsert(migrated);
    }
    for (const record of pending.records) await metadata.delete(record.path);
    await base.delete(pending.path);
    await metadata.migrateFolderState(pending.path, pending.toPath);
    await metadata.deleteRename(pending.path);
  }

  /** The note changed on both sides: keep it, merge it, or keep the newest and save the other as a copy. */
  private async reconcileNote(path: string, entry: RemoteEntry, hasRecord: boolean) {
    const { local, remote, base } = this.e;
    const localBytes = await local.readBytes(path);
    const localHash = sha256Hex(localBytes);
    const remoteBytes = await remote.download(entry);
    const baseBytes = hasRecord ? await base.get(path) : null;
    const baseText = baseBytes ? utf8.decode(baseBytes) : null;
    const pending = (await this.e.metadata.pendingConflicts()).find((p) => p.intent.path === path);
    const outcome = reconcile({
      path,
      local: utf8.decode(localBytes),
      localModifiedMillis: (await this.mtime(path)) ?? this.modified.get(path) ?? 0,
      remote: utf8.decode(remoteBytes),
      remoteEntry: toCore(entry),
      base: baseText,
      existingPaths: [...this.knownPaths],
      newId: this.e.newId(),
      conflictCopyIntent: pending?.intent ?? null,
      existingCopy: pending ? await this.existingCopy(pending) : null,
    });
    switch (outcome.kind) {
      case 'same':
        await this.recordFile(path, entry, localBytes);
        return;
      case 'merged': {
        const bytes = utf8.encode(outcome.text);
        if (!(await this.localIs(path, localHash))) return;
        const now = this.e.clock();
        await local.writeSyncedBytes(path, bytes, now, localHash);
        await this.recordFile(path, await remote.uploadRevision(entry, bytes, now), bytes);
        this.merged++;
        return;
      }
      case 'newestWins': {
        // The losing version is saved locally as the conflicted copy before the note is overwritten.
        if (!(await this.localIs(path, localHash))) return;
        const journal: PendingConflictCopy = {
          intent: outcome.conflictCopyIntent,
          copyText: outcome.copyText,
          localText: utf8.decode(localBytes),
          remoteText: utf8.decode(remoteBytes),
          remote: entry,
          baseText,
          winner: outcome.winner,
        };
        await this.e.metadata.putConflict(journal);
        await this.writeLocalCopy(journal);
        this.knownPaths.add(outcome.copyPath);
        if (outcome.winner === 'local') {
          const uploaded = await remote.uploadRevision(entry, localBytes, await this.mtime(path));
          await this.recordFile(path, uploaded, localBytes);
          this.uploaded++;
        } else {
          // An edit saved meanwhile is kept; the copy stays as a new note for the next sync.
          if (!(await this.localIs(path, localHash))) return;
          await local.writeSyncedBytes(path, remoteBytes, entry.modifiedMillis, localHash);
          await this.recordFile(path, entry, remoteBytes);
          this.downloaded++;
        }
        await this.finishCopy(journal);
        await this.e.metadata.deleteConflict(path);
        this.addConflict(journal);
        return;
      }
    }
  }

  private addConflict(pending: PendingConflictCopy) {
    if (this.conflicts.some((c) => c.copyPath === pending.intent.copyPath)) return;
    this.conflicts.push({
      path: pending.intent.path,
      copyPath: pending.intent.copyPath,
      winner: pending.winner,
      baseText: pending.baseText,
      driveId: this.e.driveId,
    });
  }

  private async existingCopy(pending: PendingConflictCopy) {
    const path = pending.intent.copyPath;
    const local = await this.e.local.entry(path);
    const remote = (await this.e.remote.snapshot()).find((e) => foldCase(e.path) === foldCase(path));
    const candidates: { path: string; text: string; modifiedMillis: number }[] = [];
    if (local)
      candidates.push({
        path: local.path,
        text: local.isFolder ? '' : utf8.decode(await this.e.local.readBytes(path)),
        modifiedMillis: local.modifiedMillis,
      });
    if (remote)
      candidates.push({
        path: remote.path,
        text: remote.isFolder ? '' : utf8.decode(await this.e.remote.download(remote)),
        modifiedMillis: this.remoteTimeMatches(remote.modifiedMillis, pending.intent.copyModifiedMillis)
          ? pending.intent.copyModifiedMillis
          : remote.modifiedMillis,
      });
    return (
      candidates.find(
        (c) =>
          c.path !== path ||
          c.text !== pending.copyText ||
          c.modifiedMillis !== pending.intent.copyModifiedMillis,
      ) ??
      candidates[0] ??
      null
    );
  }

  private async writeLocalCopy(pending: PendingConflictCopy) {
    const { copyPath, copyModifiedMillis } = pending.intent;
    const entry = await this.e.local.entry(copyPath);
    if (entry) {
      if (
        entry.isFolder ||
        entry.modifiedMillis !== copyModifiedMillis ||
        utf8.decode(await this.e.local.readBytes(copyPath)) !== pending.copyText
      )
        throw new Error(`${copyPath} is occupied by a different conflicted copy`);
      return;
    }
    await this.e.local.writeSyncedBytes(copyPath, utf8.encode(pending.copyText), copyModifiedMillis);
  }

  private async finishCopy(pending: PendingConflictCopy) {
    await this.writeLocalCopy(pending);
    const { copyPath, copyModifiedMillis } = pending.intent;
    const bytes = utf8.encode(pending.copyText);
    let remoteCopy = (await this.e.remote.snapshot()).find((e) => foldCase(e.path) === foldCase(copyPath));
    if (remoteCopy) {
      if (
        remoteCopy.path !== copyPath ||
        remoteCopy.isFolder ||
        !this.remoteTimeMatches(remoteCopy.modifiedMillis, copyModifiedMillis) ||
        utf8.decode(await this.e.remote.download(remoteCopy)) !== pending.copyText
      )
        throw new Error(`${copyPath} is occupied on the drive`);
    } else {
      remoteCopy = await this.e.remote.uploadNew(copyPath, bytes, copyModifiedMillis);
      this.uploaded++;
    }
    await this.recordFile(copyPath, remoteCopy, bytes);
  }

  private remoteTimeMatches(actual: number, expected: number) {
    const precision = this.e.remote.timestampResolutionMillis ?? 1;
    return actual === Math.floor(expected / precision) * precision;
  }

  private async replayConflict(pending: PendingConflictCopy) {
    const { local, remote, metadata } = this.e;
    const localEntries = await local.listAll();
    const remoteEntries = await remote.snapshot();
    const outcome: ReconcileOutcome = reconcile({
      path: pending.intent.path,
      local: pending.localText,
      localModifiedMillis: pending.intent.localModifiedMillis,
      remote: pending.remoteText,
      remoteEntry: pending.remote,
      base: pending.baseText,
      existingPaths: [...localEntries, ...remoteEntries].map((e) => e.path),
      newId: this.e.newId(),
      conflictCopyIntent: pending.intent,
      existingCopy: await this.existingCopy(pending),
    });
    if (outcome.kind !== 'newestWins') throw new Error('Invalid durable conflicted-copy intent');
    const replay = { ...pending, intent: outcome.conflictCopyIntent, copyText: outcome.copyText };
    await metadata.putConflict(replay);
    await this.finishCopy(replay);
    const winnerBytes = utf8.encode(pending.winner === 'local' ? pending.localText : pending.remoteText);
    const recordedWinner = (await metadata.all()).find((r) => r.path === pending.intent.path);
    if (
      recordedWinner?.remoteId === pending.intent.remoteId &&
      recordedWinner.localHash === sha256Hex(winnerBytes)
    ) {
      await this.e.base.put(pending.intent.path, winnerBytes);
    }
    const originalLocal = await local.entry(pending.intent.path);
    const originalRemote = remoteEntries.find((e) => e.path === pending.intent.path);
    const unchanged =
      originalLocal &&
      !originalLocal.isFolder &&
      sha256Hex(await local.readBytes(pending.intent.path)) === pending.intent.localHash &&
      originalLocal.modifiedMillis === pending.intent.localModifiedMillis &&
      !!originalRemote &&
      originalRemote.id === pending.intent.remoteId &&
      originalRemote.version === pending.intent.remoteVersion &&
      originalRemote.modifiedMillis === pending.intent.remoteModifiedMillis;
    if (!unchanged) {
      await metadata.deleteConflict(pending.intent.path);
      this.addConflict(replay);
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
    await this.e.metadata.recordFolder(
      { path, isFolder: true, remoteId, remoteVersion: '', localHash: '', syncedAt: this.e.clock() },
      this.e.base,
    );
  }

  private async forget(path: string) {
    await this.e.metadata.forget([path]);
    await this.e.base.delete(path);
  }

  private async forgetTree(folder: string, paths: string[]) {
    await this.e.metadata.forget(paths);
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
