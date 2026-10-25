import { DEFAULT_MAX_PASSES, SyncScheduler } from '@marknotes/sync';
import type { NoteStore } from './noteStore';
import { flagLocalChanges, localChanges, SyncEngine, type SyncConflict, type SyncResult } from './syncEngine';
import type { BaseContentStore, RemoteDriveStore, SyncMetadataStore } from './types';
import { classifySyncFailure, type SyncFailure } from './syncFailure';

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
  failure?: SyncFailure;
}

/** `outcomes` holds the last pass of each drive; `conflicts` the conflicted copies made by every pass. */
export interface MultiDriveSyncResult {
  outcomes: DriveSyncOutcome[];
  conflicts: SyncConflict[];
}

/**
 * Keeps the local note tree and every connected drive identical.
 *
 * Each drive is synced in turn with its own metadata and base copies. The order comes from the shared sync core's
 * `SyncScheduler`: whenever a drive brings changes into the local tree, the other drives are synced again so they
 * receive them, at most `maxPassesPerDrive` times each.
 */
export class MultiDriveSync {
  constructor(
    private readonly local: NoteStore,
    private readonly deviceId = '',
    private readonly maxPassesPerDrive: number = DEFAULT_MAX_PASSES,
    private readonly clock: () => number = Date.now,
    private readonly newId?: () => string,
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
      this.newId,
    );
  }

  async sync(
    targets: DriveSyncTarget[],
    onOutcome?: (outcome: DriveSyncOutcome) => void,
  ): Promise<MultiDriveSyncResult> {
    const outcomes = new Map<string, DriveSyncOutcome>();
    for (const target of targets) {
      try {
        await this.engine(target).recoverRenames();
      } catch (error) {
        const outcome: DriveSyncOutcome = {
          driveId: target.driveId,
          result: null,
          error: error instanceof Error ? error.message : String(error),
          failure: classifySyncFailure(error),
        };
        outcomes.set(target.driveId, outcome);
        onOutcome?.(outcome);
      }
    }
    // Capture deletions and recreated folders for every drive before the first drive can change the local tree.
    const ready = targets.filter((t) => !outcomes.has(t.driveId));
    await flagLocalChanges(
      await this.local.listAll(),
      ready.map((t) => t.metadata),
    );
    const byId = new Map(targets.map((t) => [t.driveId, t]));
    const conflicts: SyncConflict[] = [];
    const scheduler = new SyncScheduler(
      targets.filter((t) => !outcomes.has(t.driveId)).map((t) => t.driveId),
      this.maxPassesPerDrive,
    );
    try {
      for (let driveId = scheduler.next(); driveId !== undefined; driveId = scheduler.next()) {
        let outcome: DriveSyncOutcome;
        try {
          outcome = { driveId, result: await this.engine(byId.get(driveId)!).sync(), error: null };
        } catch (e) {
          const message = e instanceof Error ? e.message || e.name : String(e);
          outcome = { driveId, result: null, error: message, failure: classifySyncFailure(e) };
        }
        outcomes.set(driveId, outcome);
        conflicts.push(...(outcome.result?.conflicts ?? []));
        onOutcome?.(outcome);
        scheduler.report(driveId, outcome.result ? localChanges(outcome.result) : 0, outcome.result === null);
      }
    } finally {
      scheduler.free();
    }
    return { outcomes: targets.flatMap((t) => outcomes.get(t.driveId) ?? []), conflicts };
  }
}
