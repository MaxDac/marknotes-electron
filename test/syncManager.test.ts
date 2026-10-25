import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  db = await openDatabase({
    name: `sync-manager-${++counter}`,
    key: crypto.getRandomValues(new Uint8Array(32)),
  });
  calls = [];
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  (globalThis as { window?: unknown }).window = {
    marknotes: {
      providers: () => ok([]),
      recordDiagnostic: () => ok(undefined),
      drives: () => ok([DRIVE]),
      remote: (_id: string, op: { op: string }) => {
        calls.push(`remote:${op.op}`);
        return Promise.resolve({ ok: false as const, error: 'offline' });
      },
    } as unknown as MarkNotesApi,
  };
});

describe('SyncManager', () => {
  it.each(['dropbox', 'onedrive', 'proton'] as const)(
    'preserves every encrypted local record and conflict when reconnecting %s, including after restart',
    async (provider) => {
      const drive: DriveAccount = {
        id: 'original',
        provider,
        providerAccountId: 'immutable',
        label: 'me',
        remoteFolder: 'Documents',
        createRootFolder: true,
        rootFolderName: 'Personal',
      };
      window.marknotes.drives = async () => ({ ok: true, value: [drive] });
      window.marknotes.reconnect = async (id, stagedId) => {
        calls.push(`reconnect:${id}:${stagedId}`);
        return { ok: true, value: drive };
      };
      const notes = new NoteStore(new IdbNodeBackend(db));
      await notes.write(CONFLICT.path, 'note');
      await notes.write(CONFLICT.copyPath, 'copy');
      const settings = new Settings(db);
      const conflict = { ...CONFLICT, driveId: drive.id };
      await settings.set('pendingConflicts', [conflict]);
      await settings.set('driveStatus:original', { lastSyncAt: 1234, message: 'manual removal notice' });
      const stores = ['syncRecords', 'baseContent', 'conflictIntents', 'renameIntents'] as const;
      for (const store of stores) {
        await db.put(
          store,
          'preserved',
          { path: 'n.md', marker: store, bytes: new Uint8Array([1, 2, 3]) },
          drive.id,
        );
      }
      const manager = new SyncManager(notes, db, settings, 'device');
      await manager.init();
      // Compare the encrypted records too, so accidental rekeying or rewriting cannot pass.
      const before = await Promise.all(stores.map((store) => db.idb.getAll(store)));
      await manager.reconnect(drive.id, 'staged');
      expect(calls).toEqual(['reconnect:original:staged']);
      expect(await Promise.all(stores.map((store) => db.idb.getAll(store)))).toEqual(before);
      expect(manager.current.drives[0]).toMatchObject({
        account: drive,
        lastSyncAt: 1234,
        message: 'manual removal notice',
      });
      const restarted = new SyncManager(notes, db, new Settings(db), 'device');
      await restarted.init();
      expect(restarted.current.conflicts).toEqual([conflict]);
      expect(restarted.current.drives).toEqual(manager.current.drives);
      expect(await Promise.all(stores.map((store) => db.idb.getAll(store)))).toEqual(before);
    },
  );

  it('queues reconnect behind an active sync without clearing local data on failure', async () => {
    const notes = new NoteStore(new IdbNodeBackend(db));
    const manager = new SyncManager(notes, db, new Settings(db), 'device');
    await manager.init();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    manager.onBeforeSync(async () => {
      calls.push('sync');
      await waiting;
    });
    window.marknotes.reconnect = async () => {
      calls.push('reconnect');
      return { ok: false, error: 'Wrong account' };
    };
    const syncing = manager.syncNow();
    const reconnecting = manager.reconnect(DRIVE.id, 'staged');
    // Attach the failure handler immediately.
    const rejected = expect(reconnecting).rejects.toThrow('Wrong account');
    await vi.waitFor(() => expect(calls).toEqual(['sync']));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls).toEqual(['sync']);
    release();
    await syncing;
    await rejected;
    expect(calls.at(-1)).toBe('reconnect');
    expect(manager.current.drives[0].account).toEqual(DRIVE);
  });

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

describe('SyncManager automatic sync', () => {
  const manager = async () => {
    const m = new SyncManager(new NoteStore(new IdbNodeBackend(db)), db, new Settings(db), 'device');
    await m.init();
    return m;
  };
  const blockedFlush = (m: SyncManager) => {
    let release!: () => void;
    const flush = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    m.onBeforeSync(flush);
    return { flush, release: () => release() };
  };
  const snapshots = () => calls.filter((call) => call === 'remote:snapshot').length;

  it('retries only when every failure is classified as temporary', async () => {
    const m = await manager();
    for (const [failure, state] of [
      [{ kind: 'retryable' }, 'retry'],
      [{ kind: 'permanent' }, 'stop'],
      [undefined, 'stop'],
    ] as const) {
      window.marknotes.remote = async () => ({ ok: false, error: 'drive failed', failure });
      expect(await m.syncAutomatically(() => true)).toEqual({ state });
      expect(m.current.message).toContain('drive failed');
    }
  });

  it('shares one sync between manual and automatic requests', async () => {
    const m = await manager();
    const { flush, release } = blockedFlush(m);
    const first = m.syncNow();
    expect(m.syncNow()).toBe(first);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(m.syncAutomatically(() => true)).toBe(first);
    release();
    await first;
    expect(snapshots()).toBe(1);
  });

  it('does not sync when canceled while pending edits are saved, and restores the message', async () => {
    const m = await manager();
    let allowed = true;
    m.onBeforeSync(async () => {
      allowed = false;
    });
    const before = m.current.message;
    expect(await m.syncAutomatically(() => allowed)).toEqual({ state: 'stop' });
    expect(calls).toEqual([]);
    expect(m.current).toMatchObject({ running: false, message: before });
  });

  it('a manual request runs an automatic sync that was canceled meanwhile', async () => {
    const m = await manager();
    let allowed = true;
    m.onManualSync(() => (allowed = false));
    const { flush, release } = blockedFlush(m);
    const automatic = m.syncAutomatically(() => allowed);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    expect(m.syncNow()).toBe(automatic);
    expect(allowed).toBe(false);
    release();
    await automatic;
    expect(snapshots()).toBe(1);
  });

  it('defers automatic syncs while a merge is open; manual syncs still run', async () => {
    const m = await manager();
    const held = vi.fn();
    m.onHoldChange(held);
    const release = m.holdAutomaticSync();
    const second = m.holdAutomaticSync();
    expect(m.automaticSyncHeld).toBe(true);
    expect(held.mock.calls).toEqual([[true]]);
    expect(await m.syncAutomatically(() => true)).toEqual({ state: 'deferred' });
    expect(calls).toEqual([]);
    await m.syncNow();
    expect(snapshots()).toBe(1);
    release();
    release();
    expect(m.automaticSyncHeld).toBe(true);
    second();
    expect(m.automaticSyncHeld).toBe(false);
    expect(held.mock.calls).toEqual([[true], [false]]);
  });

  it('defers an automatic sync when a merge opens while pending edits are saved', async () => {
    const m = await manager();
    const { flush, release } = blockedFlush(m);
    const automatic = m.syncAutomatically(() => true);
    await vi.waitFor(() => expect(flush).toHaveBeenCalledTimes(1));
    m.holdAutomaticSync();
    release();
    expect(await automatic).toEqual({ state: 'deferred' });
    expect(calls).toEqual([]);
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
        clearDiagnostics: () => {
          calls.push('clearDiagnostics');
          return ok(undefined);
        },
        recordDiagnostic: () => ok(undefined),
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
    expect(calls).toEqual(['removeDrive:d1', 'removeDrive:d2', 'clearDiagnostics']);
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
