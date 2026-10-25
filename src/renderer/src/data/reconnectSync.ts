import type { SyncAttemptResult } from '../../../shared/syncFailure';

/** Settings key of "Sync when reconnected": `true` when on; off when missing (the default). */
export const RECONNECT_SETTING = 'syncOnReconnect';
/** Wait after the network comes back, so a flapping connection settles first. */
export const RECONNECT_DELAY = 2_000;
/** Waits before each retry after a temporary failure; then automatic sync stops until the next reconnection. */
export const RECONNECT_RETRIES = [5_000, 15_000, 30_000];

export interface ReconnectConditions {
  /** "Sync when reconnected" is on. */
  enabled: boolean;
  online: boolean;
  unlocked: boolean;
  /** At least one drive is connected. */
  connected: boolean;
  /** No merge in progress. While false a pending sync waits; any other condition turning false cancels it. */
  idle: boolean;
}

/**
 * Schedules "Sync when reconnected" while the app runs: a sync 2 s after the network comes back, retried after 5, 15
 * and 30 s when every failure was temporary. Only an offline-to-online transition queues work: launching, unlocking
 * or turning the setting on does not. Going offline, locking, disconnecting every drive or turning the setting off
 * cancels pending work; a manual sync replaces it (`cancel`). It keeps no state across restarts.
 */
export class ReconnectSync {
  private conditions: ReconnectConditions;
  private timer?: ReturnType<typeof setTimeout>;
  /** Bumped on every cancel, so a canceled attempt neither starts its sync nor schedules a retry. */
  private generation = 0;
  private pending = false;
  private running = false;
  private disposed = false;
  private retries = 0;
  private due = 0;

  constructor(
    conditions: ReconnectConditions,
    /** Runs one sync; `canStart()` is false once this attempt was canceled, checked right before syncing. */
    private readonly attempt: (canStart: () => boolean) => Promise<SyncAttemptResult>,
    private readonly onError: (error: unknown) => void,
  ) {
    this.conditions = { ...conditions };
  }

  update(next: Partial<ReconnectConditions>) {
    if (this.disposed) return;
    const previous = this.conditions;
    this.conditions = { ...previous, ...next };
    if (!this.active()) {
      this.cancel();
      return;
    }
    if (!previous.online) {
      this.cancel();
      this.pending = true;
      this.retries = 0;
      this.due = Date.now() + RECONNECT_DELAY;
    } else if (!previous.idle && this.conditions.idle) {
      this.due = Math.max(this.due, Date.now() + RECONNECT_DELAY);
    }
    this.schedule();
  }

  /** Drops pending work, including the retries of an attempt still running. */
  cancel() {
    this.generation++;
    this.pending = false;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  destroy() {
    this.disposed = true;
    this.cancel();
  }

  private active() {
    const c = this.conditions;
    return !this.disposed && c.enabled && c.online && c.unlocked && c.connected;
  }

  private schedule() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending || this.running || !this.active() || !this.conditions.idle) return;
    this.timer = setTimeout(() => void this.run(), Math.max(0, this.due - Date.now()));
  }

  private async run() {
    this.timer = undefined;
    const generation = this.generation;
    const canStart = () => this.active() && generation === this.generation;
    this.running = true;
    let result: SyncAttemptResult;
    try {
      result = await this.attempt(canStart);
    } catch (error) {
      result = { state: 'stop' };
      this.onError(error);
    } finally {
      this.running = false;
    }
    // Canceled meanwhile: a newer reconnection may be pending, it starts now that this attempt is over.
    if (!canStart()) return this.schedule();
    if (result.state === 'deferred') {
      this.due = Date.now() + RECONNECT_DELAY;
    } else if (result.state === 'retry' && this.retries < RECONNECT_RETRIES.length) {
      this.due = Date.now() + RECONNECT_RETRIES[this.retries++];
    } else {
      this.pending = false;
      return;
    }
    this.schedule();
  }
}
