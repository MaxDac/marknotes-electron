import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { MarkNotesApi } from '../src/preload/api';
import { IdbNodeBackend, openDatabase, Settings, type Db } from '../src/renderer/src/data/db';
import { SyncManager } from '../src/renderer/src/data/syncManager';
import { NoteStore } from '../src/shared/noteStore';
import type { SyncConflict } from '../src/shared/syncEngine';
import type { DriveAccount } from '../src/shared/types';

const DRIVE: DriveAccount = {
  id: 'd1',
  provider: 'fake',
  label: 'Fake',
  folder: 'MarkNotes',
} as unknown as DriveAccount;
const CONFLICT: SyncConflict = {
  path: 'n.md',
  copyPath: 'n (conflicted copy).md',
  winner: 'remote',
  baseText: 'base\n',
  driveId: DRIVE.id,
};

let db: Db;
let counter = 0;
let calls: string[];

beforeEach(async () => {
  db = await openDatabase(`sync-manager-${++counter}`);
  calls = [];
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  (globalThis as { window?: unknown }).window = {
    marknotes: {
      providers: () => ok([]),
      drives: () => ok([DRIVE]),
      remote: (_id: string, op: { op: string }) => {
        calls.push(`remote:${op.op}`);
        return Promise.resolve({ ok: false as const, error: 'offline' });
      },
    } as unknown as MarkNotesApi,
  };
});

describe('SyncManager', () => {
  it('keeps pending conflicts across restarts until one of the files is gone', async () => {
    const notes = new NoteStore(new IdbNodeBackend(db));
    await notes.write(CONFLICT.path, 'note');
    await notes.write(CONFLICT.copyPath, 'copy');
    await new Settings(db).set('pendingConflicts', [CONFLICT]);

    const first = new SyncManager(notes, db, new Settings(db), 'device');
    await first.init();
    expect(first.current.conflicts).toEqual([CONFLICT]);

    first.keepBoth(CONFLICT);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = new SyncManager(notes, db, new Settings(db), 'device');
    await second.init();
    expect(second.current.conflicts).toEqual([]);

    await new Settings(db).set('pendingConflicts', [CONFLICT]);
    await notes.delete(CONFLICT.copyPath);
    const third = new SyncManager(notes, db, new Settings(db), 'device');
    await third.init();
    expect(third.current.conflicts).toEqual([]);
  });

  it('flushes pending editor saves before syncing', async () => {
    const notes = new NoteStore(new IdbNodeBackend(db));
    const manager = new SyncManager(notes, db, new Settings(db), 'device');
    await manager.init();
    const unregister = manager.onBeforeSync(async () => {
      calls.push('flush');
    });
    await manager.syncNow();
    expect(calls[0]).toBe('flush');
    expect(calls).toContain('remote:snapshot');

    unregister();
    calls.length = 0;
    await manager.syncNow();
    expect(calls).not.toContain('flush');
  });
});
