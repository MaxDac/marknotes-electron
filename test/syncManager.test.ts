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

describe('SyncManager local data deletion', () => {
  let drives: DriveAccount[];
  let removeFails: boolean;
  const OTHER = { ...DRIVE, id: 'd2', label: 'Other' } as DriveAccount;

  beforeEach(() => {
    drives = [DRIVE];
    removeFails = false;
    const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
    (globalThis as { window?: unknown }).window = {
      marknotes: {
        providers: () => ok([]),
        drives: () => ok([...drives]),
        removeDrive: (id: string) => {
          calls.push(`removeDrive:${id}`);
          if (removeFails) return Promise.resolve({ ok: false as const, error: 'nope' });
          drives = drives.filter((d) => d.id !== id);
          return ok(undefined);
        },
      } as unknown as MarkNotesApi,
    };
  });

  const seed = async () => {
    const notes = new NoteStore(new IdbNodeBackend(db));
    await notes.write('n.md', 'note');
    const settings = new Settings(db);
    await settings.set('themeMode', 'dark');
    await settings.set('lastSyncSummary', 'Fake: synced');
    const manager = new SyncManager(notes, db, settings, 'device');
    await manager.init();
    return { notes, settings, manager };
  };

  it('keeps local notes when disconnecting unless asked', async () => {
    const { manager } = await seed();
    await manager.removeDrive(DRIVE);
    expect(await db.getAll('nodes')).not.toHaveLength(0);
  });

  it('deletes local notes when disconnecting the last drive', async () => {
    const { manager, settings } = await seed();
    await manager.removeDrive(DRIVE, { deleteLocalData: true });
    expect(await db.getAll('nodes')).toHaveLength(0);
    expect(await settings.get('lastSyncSummary', null)).toBeNull();
    expect(await settings.get('themeMode', null)).toBe('dark');
  });

  it('never deletes local notes while another drive is connected', async () => {
    drives = [DRIVE, OTHER];
    const { manager } = await seed();
    await manager.removeDrive(DRIVE, { deleteLocalData: true });
    expect(await db.getAll('nodes')).not.toHaveLength(0);
  });

  it('disconnects every drive before deleting all local data', async () => {
    drives = [DRIVE, OTHER];
    const { manager } = await seed();
    await manager.deleteAllLocalData();
    expect(calls).toEqual(['removeDrive:d1', 'removeDrive:d2']);
    expect(drives).toEqual([]);
    expect(await db.getAll('nodes')).toHaveLength(0);
    expect(manager.current.drives).toEqual([]);
  });

  it('keeps local data when a drive cannot be disconnected', async () => {
    const { manager } = await seed();
    removeFails = true;
    await expect(manager.deleteAllLocalData()).rejects.toThrow('nope');
    expect(await db.getAll('nodes')).not.toHaveLength(0);
  });
});
