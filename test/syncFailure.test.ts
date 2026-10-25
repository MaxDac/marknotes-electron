import { describe, expect, it, vi } from 'vitest';
import { unwrap } from '../src/renderer/src/data/api';
import { classifySyncFailure, SyncFailureError, syncAttemptResult } from '../src/shared/syncFailure';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { MultiDriveSync } from '../src/shared/multiDriveSync';
import { InMemoryBaseContentStore, InMemorySyncMetadataStore } from '../src/shared/types';

describe('structured sync failures', () => {
  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %s across provider status shapes', (status) => {
    for (const key of ['status', 'httpStatus', 'statusCode']) {
      expect(classifySyncFailure({ [key]: status })).toEqual({ kind: 'retryable' });
    }
  });

  it.each([400, 401, 403, 404, 409, 412, 422])(
    'never retries HTTP %s, even with a network cause',
    (status) => {
      expect(classifySyncFailure({ status, cause: { code: 'ETIMEDOUT' } })).toEqual({ kind: 'permanent' });
    },
  );

  it('classifies transport codes and wrapped fetch failures, not message strings', () => {
    expect(classifySyncFailure({ code: 'ECONNRESET' })).toEqual({ kind: 'retryable' });
    expect(classifySyncFailure(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }))).toEqual({
      kind: 'retryable',
    });
    expect(classifySyncFailure(new Error('HTTP 503 offline network timeout'))).toEqual({ kind: 'permanent' });
    expect(classifySyncFailure(null)).toEqual({ kind: 'permanent' });
  });

  it('preserves IPC metadata and defaults old/unstructured failures to stop', async () => {
    const failure = { kind: 'retryable' as const };
    const error = await unwrap(Promise.resolve({ ok: false, error: 'temporary', failure })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SyncFailureError);
    expect(classifySyncFailure(error)).toEqual(failure);
    await expect(unwrap(Promise.resolve({ ok: false, error: 'legacy' }))).rejects.toMatchObject({
      failure: { kind: 'permanent' },
    });
  });

  it('retries only when every failure is retryable', () => {
    expect(syncAttemptResult([])).toEqual({ state: 'complete' });
    expect(syncAttemptResult([{ kind: 'retryable' }, { kind: 'retryable' }])).toEqual({ state: 'retry' });
    expect(syncAttemptResult([{ kind: 'retryable' }, { kind: 'permanent' }])).toEqual({ state: 'stop' });
  });

  it.each(['snapshot', 'uploadNew', 'writeManifest'] as const)(
    'preserves structured %s failures through the fake-remote executor and multi-drive result',
    async (operation) => {
      const local = new NoteStore(new MemoryNodeBackend());
      await local.write('n.md', 'body');
      const remote = new FakeRemoteDriveStore();
      vi.spyOn(remote, operation).mockRejectedValue(new SyncFailureError('temporary', { kind: 'retryable' }));
      const result = await new MultiDriveSync(local).sync([
        {
          driveId: 'fake',
          remote,
          metadata: new InMemorySyncMetadataStore(),
          base: new InMemoryBaseContentStore(),
        },
      ]);
      const outcome = result.outcomes[0];
      if (operation === 'snapshot') {
        expect(outcome.error).toBe('temporary');
        expect(outcome.failure).toEqual({ kind: 'retryable' });
      } else {
        expect(outcome.result?.errors.join()).toContain('temporary');
        expect(outcome.result?.failures).toContainEqual({ kind: 'retryable' });
      }
    },
  );
});
