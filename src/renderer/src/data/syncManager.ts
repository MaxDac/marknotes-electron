import type { MergeResult } from '@marknotes/sync';
import { ConflictMergeBack } from '../../../shared/conflictMergeBack';
import { MultiDriveSync, type DriveSyncTarget } from '../../../shared/multiDriveSync';
import type { NoteStore } from '../../../shared/noteStore';
import { summary, type SyncConflict } from '../../../shared/syncEngine';
import type { DriveAccount } from '../../../shared/types';
import type { ProviderInfo } from '../../../preload/api';
import { api, IpcRemoteDriveStore, unwrap } from './api';
import { IdbBaseContentStore, IdbSyncMetadataStore, type Db, type Settings } from './db';

/** A connected drive and the outcome of its last sync. */
export interface DriveStatus {
  account: DriveAccount;
  lastSyncAt: number;
  message: string | null;
  unavailableReason: string | null;
}

export interface SyncState {
  drives: DriveStatus[];
  running: boolean;
  message: string | null;
  conflicts: SyncConflict[];
}

interface StoredStatus {
  lastSyncAt: number;
  message: string | null;
}

const statusKey = (id: string) => `driveStatus:${id}`;
const CONFLICTS_KEY = 'pendingConflicts';

/**
 * Keeps the local notes in sync with every connected drive. Sync only runs on app launch and on demand:
 * there is no background or periodic polling.
 */
export class SyncManager {
  private state: SyncState = { drives: [], running: false, message: null, conflicts: [] };
  private listeners = new Set<(s: SyncState) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private multiSync: MultiDriveSync;
  private mergeBack: ConflictMergeBack;
  private providers: ProviderInfo[] = [];
  private readonly flushers = new Set<() => Promise<void>>();

  constructor(
    notes: NoteStore,
    private readonly db: Db,
    private readonly settings: Settings,
    deviceId: string,
  ) {
    this.multiSync = new MultiDriveSync(notes, deviceId);
    this.mergeBack = new ConflictMergeBack(notes);
  }

  get current() {
    return this.state;
  }

  subscribe(listener: (s: SyncState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<SyncState>) {
    const conflictsChanged = patch.conflicts !== undefined && patch.conflicts !== this.state.conflicts;
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
    // Pending conflicts survive restarts, until resolved or one of the files is gone.
    if (conflictsChanged) void this.settings.set(CONFLICTS_KEY, this.state.conflicts).catch(() => undefined);
  }

  /** Registers a pending-save flush (e.g. an open editor) awaited before every sync; returns an unregister. */
  onBeforeSync(flush: () => Promise<void>): () => void {
    this.flushers.add(flush);
    return () => this.flushers.delete(flush);
  }

  /** Serializes sync, merge-back and disconnect operations. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async init() {
    const message = await this.settings.get<string>('lastSyncSummary', '');
    const stored = await this.settings.get<SyncConflict[]>(CONFLICTS_KEY, []);
    this.providers = await unwrap(api().providers());
    this.update({ message: message || null, conflicts: await this.pendingConflicts(stored) });
    await this.refreshDrives();
  }

  private async refreshDrives() {
    const accounts = await unwrap(api().drives());
    const drives: DriveStatus[] = [];
    for (const account of accounts) {
      const status = await this.settings.get<StoredStatus>(statusKey(account.id), {
        lastSyncAt: 0,
        message: null,
      });
      drives.push({
        account,
        ...status,
        unavailableReason:
          this.providers.find((p) => p.provider === account.provider)?.unavailableReason ?? null,
      });
    }
    this.update({ drives });
    return accounts;
  }

  syncIfConnected() {
    if (this.state.drives.length > 0) void this.syncNow();
  }

  syncNow(): Promise<void> {
    if (this.state.running) return Promise.resolve();
    return this.locked(() => this.runSync());
  }

  /** Saves a newly connected drive (already stored by the main process) and syncs it. */
  async driveAdded() {
    await this.refreshDrives();
    await this.syncNow();
  }

  /** Disconnects a drive. Local notes are kept and nothing is deleted from the drive. */
  removeDrive(account: DriveAccount): Promise<void> {
    return this.locked(async () => {
      await unwrap(api().removeDrive(account.id)).catch(() => undefined);
      await new IdbSyncMetadataStore(this.db, account.id).clear();
      await new IdbBaseContentStore(this.db, account.id).clear();
      await this.settings.delete(statusKey(account.id));
      await this.refreshDrives();
      this.update({
        conflicts: this.state.conflicts.filter((c) => c.driveId !== account.id),
        message: `Disconnected ${account.label}`,
      });
    });
  }

  /** Three-way merge of the note and its conflicted copy, for the merge-back view. */
  mergePreview(conflict: SyncConflict): Promise<MergeResult> {
    return this.mergeBack.merge(conflict);
  }

  /** Saves `text` as the note, deletes the conflicted copy, then syncs so every drive receives both changes. */
  mergeCopyBack(conflict: SyncConflict, text: string): Promise<void> {
    return this.settle(conflict, `merge ${conflict.copyPath}`, () => this.mergeBack.apply(conflict, text));
  }

  /** Deletes the conflicted copy, keeping the note, then syncs so it is deleted on every drive. */
  discardCopy(conflict: SyncConflict): Promise<void> {
    return this.settle(conflict, `delete ${conflict.copyPath}`, () => this.mergeBack.discardCopy(conflict));
  }

  /** Keeps the note and its conflicted copy as two notes: the conflict is just dismissed. */
  keepBoth(conflict: SyncConflict) {
    this.update({ conflicts: this.state.conflicts.filter((c) => c.copyPath !== conflict.copyPath) });
  }

  private async settle(conflict: SyncConflict, what: string, fn: () => Promise<void>): Promise<void> {
    const done = await this.locked(async () => {
      try {
        await fn();
        this.update({ conflicts: this.state.conflicts.filter((c) => c.copyPath !== conflict.copyPath) });
        return true;
      } catch (e) {
        this.update({ message: `Could not ${what}: ${describe(e)}` });
        return false;
      }
    });
    if (done) await this.syncNow();
  }
  private target(account: DriveAccount): DriveSyncTarget {
    const reason = this.providers.find((p) => p.provider === account.provider)?.unavailableReason;
    if (reason) throw new Error(reason);
    return {
      driveId: account.id,
      remote: new IpcRemoteDriveStore(account.id),
      metadata: new IdbSyncMetadataStore(this.db, account.id),
      base: new IdbBaseContentStore(this.db, account.id),
    };
  }

  private async runSync() {
    let drives: DriveAccount[];
    try {
      drives = await this.refreshDrives();
    } catch (e) {
      this.update({ message: `Sync failed: ${describe(e)}` });
      return;
    }
    if (drives.length === 0) {
      this.update({ message: 'Add a drive in Settings to sync', conflicts: [] });
      return;
    }
    this.update({ running: true, message: 'Syncing…' });
    try {
      // Pending editor saves land before the local tree is listed.
      await Promise.all([...this.flushers].map((flush) => flush().catch(() => undefined)));
      const messages = new Map<string, string>();
      const targets: DriveSyncTarget[] = [];
      for (const account of drives) {
        try {
          targets.push(this.target(account));
        } catch (e) {
          messages.set(account.id, describe(e));
        }
      }
      const { outcomes, conflicts } = await this.multiSync.sync(targets);
      for (const outcome of outcomes) {
        messages.set(
          outcome.driveId,
          outcome.result
            ? [summary(outcome.result), ...outcome.result.errors].join('\n')
            : `Sync failed: ${outcome.error}`,
        );
      }
      const now = Date.now();
      for (const [id, message] of messages) {
        await this.settings.set(statusKey(id), { lastSyncAt: now, message } satisfies StoredStatus);
      }
      const text = drives.map((d) => `${d.label}: ${(messages.get(d.id) ?? '').split('\n')[0]}`).join('\n');
      await this.settings.set('lastSyncAt', now);
      await this.settings.set('lastSyncSummary', text);
      await this.refreshDrives();
      this.update({
        message: text,
        conflicts: await this.pendingConflicts([...this.state.conflicts, ...conflicts]),
      });
    } catch (e) {
      this.update({ message: `Sync failed: ${describe(e)}` });
    } finally {
      this.update({ running: false });
    }
  }
  /** Conflicts stay listed while both the note and its copy exist; one entry per copy. */
  private async pendingConflicts(conflicts: SyncConflict[]): Promise<SyncConflict[]> {
    const pending = new Map<string, SyncConflict>();
    for (const c of conflicts) {
      if (!pending.has(c.copyPath) && (await this.mergeBack.isPending(c))) pending.set(c.copyPath, c);
    }
    return [...pending.values()];
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
