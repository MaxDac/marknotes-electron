import type { NoteStore } from './noteStore';
import { localChanges, SyncEngine, type SyncConflict, type SyncResult } from './syncEngine';
import type { BaseContentStore, RemoteDriveStore, SyncMetadataStore } from './types';

/** Everything needed to sync the local note tree with one drive. */
export interface DriveSyncTarget {
  driveId: string;
  remote: RemoteDriveStore;
  metadata: SyncMetadataStore;
  base: BaseContentStore;
}

/** Outcome of syncing one drive: the last result, or the error that stopped it. */
export interface DriveSyncOutcome {
  driveId: string;
  result: SyncResult | null;
  error: string | null;
}

export const allConflicts = (outcomes: DriveSyncOutcome[]): SyncConflict[] =>
  outcomes.flatMap((o) => o.result?.conflicts ?? []);

/**
 * Keeps the local note tree and every connected drive identical. Whenever a drive brings changes
 * into the local tree, the other drives are synced again, bounded by `maxPassesPerDrive`.
 */
export class MultiDriveSync {
  constructor(
    private readonly local: NoteStore,
    private readonly deviceId = '',
    private readonly maxPassesPerDrive = 3,
    private readonly clock: () => number = Date.now,
  ) {}

  engine(target: DriveSyncTarget): SyncEngine {
    return new SyncEngine(
      this.local,
      target.remote,
      target.metadata,
      target.base,
      target.driveId,
      this.deviceId,
      this.clock,
    );
  }

  async sync(
    targets: DriveSyncTarget[],
    onOutcome?: (outcome: DriveSyncOutcome) => void,
  ): Promise<DriveSyncOutcome[]> {
    const outcomes = new Map<string, DriveSyncOutcome>();
    const passes = new Map<string, number>();
    const pending = [...targets];
    while (pending.length > 0) {
      const target = pending.shift()!;
      const count = passes.get(target.driveId) ?? 0;
      if (count >= this.maxPassesPerDrive) continue;
      passes.set(target.driveId, count + 1);
      let outcome: DriveSyncOutcome;
      try {
        outcome = { driveId: target.driveId, result: await this.engine(target).sync(), error: null };
      } catch (e) {
        const message = e instanceof Error ? e.message || e.name : String(e);
        outcome = { driveId: target.driveId, result: null, error: message };
      }
      outcomes.set(target.driveId, outcome);
      onOutcome?.(outcome);
      if (outcome.result && localChanges(outcome.result) > 0) {
        for (const t of targets) if (t !== target && !pending.includes(t)) pending.push(t);
      }
    }
    return targets.flatMap((t) => outcomes.get(t.driveId) ?? []);
  }
}
