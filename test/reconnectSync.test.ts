import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RECONNECT_DELAY,
  RECONNECT_RETRIES,
  ReconnectSync,
  type ReconnectConditions,
} from '../src/renderer/src/data/reconnectSync';
import type { SyncAttemptResult } from '../src/shared/syncFailure';

const OFFLINE: ReconnectConditions = {
  enabled: true,
  online: false,
  unlocked: true,
  connected: true,
  idle: true,
};
const GATES = ['enabled', 'unlocked', 'connected', 'online'] as const;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(initial: ReconnectConditions = OFFLINE) {
  const attempt = vi
    .fn<(canStart: () => boolean) => Promise<SyncAttemptResult>>()
    .mockResolvedValue({ state: 'complete' });
  const error = vi.fn();
  return { reconnect: new ReconnectSync(initial, attempt, error), attempt, error };
}

function controlled(attempt: ReturnType<typeof setup>['attempt']) {
  let resolve!: (result: SyncAttemptResult) => void;
  attempt.mockImplementationOnce(() => new Promise((done) => (resolve = done)));
  return (result: SyncAttemptResult) => resolve(result);
}

describe('ReconnectSync', () => {
  it('syncs 2 s after an offline-to-online transition, not on start, unlock or turning it on', async () => {
    const { reconnect, attempt } = setup({ ...OFFLINE, enabled: false, online: true, unlocked: false });
    reconnect.update({ enabled: true });
    reconnect.update({ unlocked: true, connected: true, online: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).not.toHaveBeenCalled();
    reconnect.update({ online: false });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY - 1);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it.each(['enabled', 'unlocked', 'connected'] as const)(
    'ignores a reconnection while %s is false, even once it turns true',
    async (gate) => {
      const { reconnect, attempt } = setup({ ...OFFLINE, [gate]: false });
      reconnect.update({ online: true });
      reconnect.update({ [gate]: true });
      await vi.advanceTimersByTimeAsync(60_000);
      expect(attempt).not.toHaveBeenCalled();
    },
  );

  it.each(GATES)('cancels the pending sync when %s turns false', async (gate) => {
    const { reconnect, attempt } = setup();
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(1000);
    reconnect.update({ [gate]: false });
    if (gate !== 'online') reconnect.update({ [gate]: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('retries after 5, 15 and 30 s while failures are temporary, then stops', async () => {
    const { reconnect, attempt } = setup();
    attempt.mockResolvedValue({ state: 'retry' });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(RECONNECT_RETRIES).toEqual([5_000, 15_000, 30_000]);
    for (const [index, delay] of RECONNECT_RETRIES.entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(attempt).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempt).toHaveBeenCalledTimes(index + 2);
    }
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempt).toHaveBeenCalledTimes(4);
  });

  it('starts over with a new reconnection after the retries ran out', async () => {
    const { reconnect, attempt } = setup();
    attempt.mockResolvedValue({ state: 'retry' });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempt).toHaveBeenCalledTimes(4);
    reconnect.update({ online: false });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempt).toHaveBeenCalledTimes(8);
  });

  it.each(['complete', 'stop'] as const)('does not retry after %s', async (state) => {
    const { reconnect, attempt } = setup();
    attempt.mockResolvedValue({ state });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it.each(GATES)('cancels retries when %s turns false', async (gate) => {
    const { reconnect, attempt } = setup();
    attempt.mockResolvedValue({ state: 'retry' });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY);
    reconnect.update({ [gate]: false });
    if (gate !== 'online') reconnect.update({ [gate]: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('waits while a merge is open, then syncs 2 s after it closes', async () => {
    const { reconnect, attempt } = setup({ ...OFFLINE, idle: false });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).not.toHaveBeenCalled();
    reconnect.update({ idle: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY - 1);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('keeps a deferred sync pending without using a retry', async () => {
    const { reconnect, attempt } = setup();
    attempt.mockResolvedValueOnce({ state: 'deferred' }).mockResolvedValue({ state: 'retry' });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY);
    reconnect.update({ idle: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    reconnect.update({ idle: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it('coalesces repeated online events without moving the deadline', async () => {
    const { reconnect, attempt } = setup();
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(1000);
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('waits 2 s again after the network flaps', async () => {
    const { reconnect, attempt } = setup();
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(1500);
    reconnect.update({ online: false });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY - 1);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('a canceled attempt is told it cannot start and does not retry', async () => {
    const { reconnect, attempt } = setup();
    const finish = controlled(attempt);
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY);
    const canStart = attempt.mock.calls[0][0];
    expect(canStart()).toBe(true);
    reconnect.cancel();
    expect(canStart()).toBe(false);
    finish({ state: 'retry' });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it.each(['unlocked', 'enabled'] as const)(
    'locking or turning it off invalidates a running attempt (%s)',
    async (gate) => {
      const { reconnect, attempt } = setup();
      controlled(attempt);
      reconnect.update({ online: true });
      await vi.advanceTimersByTimeAsync(RECONNECT_DELAY);
      const canStart = attempt.mock.calls[0][0];
      reconnect.update({ [gate]: false });
      expect(canStart()).toBe(false);
    },
  );

  it('never overlaps attempts: a reconnection during a canceled attempt runs after it', async () => {
    const { reconnect, attempt } = setup();
    const finish = controlled(attempt);
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(RECONNECT_DELAY);
    reconnect.update({ online: false });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    finish({ state: 'retry' });
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does nothing after destroy', async () => {
    const { reconnect, attempt } = setup();
    reconnect.update({ online: true });
    reconnect.destroy();
    reconnect.update({ online: false });
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('reports unexpected errors and stops', async () => {
    const { reconnect, attempt, error } = setup();
    const failure = new Error('unexpected');
    attempt.mockRejectedValue(failure);
    reconnect.update({ online: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(error).toHaveBeenCalledWith(failure);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});
