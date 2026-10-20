import { MultiDriveSync, type DriveSyncTarget } from '../../../shared/multiDriveSync';
import type { NoteStore } from '../../../shared/noteStore';
import { summary, type ConflictResolution, type SyncConflict } from '../../../shared/syncEngine';
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

/**
 * Keeps the local notes in sync with every connected drive. Sync only runs on app launch and on demand:
 * there is no background or periodic polling.
 */
export class SyncManager {
  private state: SyncState = { drives: [], running: false, message: null, conflicts: [] };
  private listeners = new Set<(s: SyncState) => void>();
  private queue: Promise<unknown> = Promise.resolve();
  private multiSync: MultiDriveSync;
  private providers: ProviderInfo[] = [];

  constructor(
    notes: NoteStore,
    private readonly db: Db,
    private readonly settings: Settings,
    deviceId: string,
  ) {
    this.multiSync = new MultiDriveSync(notes, deviceId);
  }

  get current() {
    return this.state;
  }

  subscribe(listener: (s: SyncState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private update(patch: Partial<SyncState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Serializes sync, resolve and disconnect operations. */
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async init() {
    const message = await this.settings.get<string>('lastSyncSummary', '');
    this.providers = await unwrap(api().providers());
    this.update({ message: message || null });
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

  /** Applies `resolution` on the conflict's drive, then syncs again so the other drives receive it. */
  async resolve(conflict: SyncConflict, resolution: ConflictResolution): Promise<void> {
    const resolved = await this.locked(async () => {
      this.update({ running: true });
      try {
        const account = this.state.drives.find((d) => d.account.id === conflict.driveId)?.account;
        if (!account) throw new Error('The drive of this conflict is no longer connected');
        await this.multiSync.engine(this.target(account)).resolve(conflict, resolution);
        this.update({ conflicts: this.state.conflicts.filter((c) => c !== conflict) });
        return true;
      } catch (e) {
        this.update({ message: `Could not resolve ${conflict.path}: ${describe(e)}` });
        return false;
      } finally {
        this.update({ running: false });
      }
    });
    if (resolved) await this.syncNow();
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
      const messages = new Map<string, string>();
      const targets: DriveSyncTarget[] = [];
      for (const account of drives) {
        try {
          targets.push(this.target(account));
        } catch (e) {
          messages.set(account.id, describe(e));
        }
      }
      const outcomes = await this.multiSync.sync(targets);
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
      this.update({ message: text, conflicts: outcomes.flatMap((o) => o.result?.conflicts ?? []) });
    } catch (e) {
      this.update({ message: `Sync failed: ${describe(e)}` });
    } finally {
      this.update({ running: false });
    }
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
