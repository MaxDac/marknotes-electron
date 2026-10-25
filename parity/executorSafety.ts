import { sha256Hex } from '@marknotes/sync';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { utf8 } from '../src/shared/hashing';
import { MultiDriveSync, type DriveSyncTarget } from '../src/shared/multiDriveSync';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { SyncEngine } from '../src/shared/syncEngine';
import {
  InMemoryBaseContentStore,
  InMemorySyncMetadataStore,
  type RemoteEntry,
  type SyncRecord,
} from '../src/shared/types';

/** Runs the spec's race/restart scenarios against the desktop executor, not an expected-result stub. */
export async function executorSafety(input: { scenario: string; crashAfter?: string; event?: string }) {
  let now = 0;
  let id = 0;
  const local = new NoteStore(new MemoryNodeBackend(), () => now);
  const remote = new FakeRemoteDriveStore();
  const metadata = new InMemorySyncMetadataStore();
  const base = new InMemoryBaseContentStore();
  const engine = () =>
    new SyncEngine(
      local,
      remote,
      metadata,
      base,
      'drive',
      'device',
      () => now,
      () => `cpyr${String(++id).padStart(4, '0')}`,
    );

  if (input.scenario.startsWith('folder-delete-')) return folderDeletion(input);

  if (input.scenario === 'new-file-create-race') {
    await local.write('new.md', 'local');
    const upload = remote.uploadNew.bind(remote);
    remote.uploadNew = async (path, bytes, modifiedMillis) => {
      remote.put(path, 'other device', 10);
      return upload(path, bytes, modifiedMillis);
    };
    const result = await engine().sync();
    return {
      errors: result.errors.length,
      existingTextPreserved: remote.text('new.md') === 'other device',
      creationRecorded: (await metadata.all()).some((r) => r.path === 'new.md'),
    };
  }

  if (input.scenario === 'new-folder-create-race') {
    await local.createFolder('F');
    const create = remote.createFolder.bind(remote);
    let identity = '';
    remote.createFolder = async (path) => {
      identity = remote.putFolder(path).id;
      return create(path);
    };
    const result = await engine().sync();
    return {
      errors: result.errors.length,
      existingIdentityPreserved: remote.nodes.get('F')?.id === identity,
      creationRecorded: (await metadata.all()).some((r) => r.path === 'F'),
    };
  }

  if (input.scenario !== 'conflict-copy-restart')
    throw new Error(`Unknown executor scenario: ${input.scenario}`);
  await local.write('n.md', 'base\n');
  await engine().sync();
  now = 1000;
  await local.write('n.md', 'losing\n');
  remote.put('n.md', 'winning\n', 2000);
  let crashed = false;
  const crash = (point: string) => {
    if (!crashed && input.crashAfter === point) {
      crashed = true;
      throw new Error(`Simulated crash after ${point}`);
    }
  };
  const putIntent = metadata.putConflict.bind(metadata);
  metadata.putConflict = async (intent) => {
    await putIntent(intent);
    crash('intent');
  };
  const write = local.writeSyncedBytes.bind(local);
  local.writeSyncedBytes = async (path, bytes, modifiedMillis, hash) => {
    await write(path, bytes, modifiedMillis, hash);
    crash(path === 'n.md' ? 'winner' : 'copy');
  };
  const upsert = metadata.upsert.bind(metadata);
  metadata.upsert = async (record) => {
    await upsert(record);
    crash(record.path === 'n.md' ? 'winner-record' : 'copy-record');
  };
  const upload = remote.uploadNew.bind(remote);
  remote.uploadNew = async (path, bytes, modifiedMillis) => {
    const result = await upload(path, bytes, modifiedMillis);
    crash('copy-upload');
    return result;
  };
  await engine().sync();
  if (!crashed) throw new Error(`Crash checkpoint was not exercised: ${input.crashAfter}`);
  const result = await engine().sync();
  const copies = (await local.listAll()).filter((e) => e.path.includes('(conflicted copy)'));
  const copy = copies[0];
  const remoteCopy = (await remote.snapshot()).find((e) => e.path === copy?.path);
  return {
    errors: result.errors.length,
    copyCount: copies.length,
    copyModifiedMillis: copy?.modifiedMillis,
    losingTextPreserved:
      !!copy &&
      (await local.read(copy.path)).endsWith('losing\n') &&
      remote.text(copy.path) === (await local.read(copy.path)) &&
      remoteCopy?.modifiedMillis === copy.modifiedMillis,
    intentCleared: (await metadata.pendingConflicts()).length === 0,
  };
}

/**
 * One device linked to `drives` drives, whose durable state (local tree, records, base copies, notices) survives a
 * simulated restart. A crash stops the process: every later store and drive operation of that run fails.
 */
class Device {
  now = 0;
  dead = false;
  readonly local: NoteStore;
  readonly remotes: FakeRemoteDriveStore[] = [];
  readonly metadata: InMemorySyncMetadataStore[] = [];
  readonly bases: InMemoryBaseContentStore[] = [];
  recursiveDeleteRequests = 0;
  /** Folder actions applied while counting (preserve, folder delete, folder creation on either side). */
  folderActions: number | null = null;

  constructor(drives: number) {
    this.local = this.alive(new NoteStore(new MemoryNodeBackend(), () => this.now));
    const createLocal = this.local.createSyncedFolder.bind(this.local);
    this.local.createSyncedFolder = async (path) => {
      this.countAction();
      return createLocal(path);
    };
    for (let i = 0; i < drives; i++) {
      const remote = new FakeRemoteDriveStore();
      const removeTree = remote.remove.bind(remote);
      remote.remove = (path) => {
        if (remote.isFolder(path) && [...remote.nodes.keys()].some((p) => p.startsWith(`${path}/`)))
          this.recursiveDeleteRequests++;
        removeTree(path);
      };
      const remove = remote.delete.bind(remote);
      remote.delete = async (entry) => {
        if (entry.isFolder) this.countAction();
        return remove(entry);
      };
      const create = remote.createFolder.bind(remote);
      remote.createFolder = async (path) => {
        this.countAction();
        return create(path);
      };
      const metadata = new InMemorySyncMetadataStore();
      const preserve = metadata.preserveFolder.bind(metadata);
      metadata.preserveFolder = async (path, remoteId) => {
        this.countAction();
        return preserve(path, remoteId);
      };
      this.remotes.push(this.alive(remote));
      this.metadata.push(this.alive(metadata));
      this.bases.push(this.alive(new InMemoryBaseContentStore()));
    }
  }

  private countAction() {
    if (this.folderActions !== null) this.folderActions++;
  }

  /** Every method of `target` fails once the process crashed (until `restart`). */
  private alive<T extends object>(target: T): T {
    return new Proxy(target, {
      get: (t, key) => {
        const value = Reflect.get(t, key) as unknown;
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => {
          if (this.dead) throw new Error('Process stopped');
          return (value as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });
  }

  crash(): never {
    this.dead = true;
    throw new Error('Simulated crash');
  }

  restart() {
    this.dead = false;
  }

  target(drive: number): DriveSyncTarget {
    return {
      driveId: `drive${drive}`,
      remote: this.remotes[drive],
      metadata: this.metadata[drive],
      base: this.bases[drive],
    };
  }

  /** One sync session of a drive; a failed run (e.g. a failed listing) is one error. */
  async session(drive = 0): Promise<number> {
    const t = this.target(drive);
    const engine = new SyncEngine(
      this.local,
      t.remote,
      t.metadata,
      t.base,
      t.driveId,
      'device',
      () => this.now,
    );
    try {
      return (await engine.sync()).errors.length;
    } catch {
      return 1;
    }
  }

  /** One session of every drive, as the app syncs them (all-drive preflight first). */
  async syncAll(): Promise<number> {
    const multi = new MultiDriveSync(this.local, 'device', undefined, () => this.now);
    const { outcomes } = await multi.sync(this.remotes.map((_, i) => this.target(i)));
    return outcomes.reduce((n, o) => n + (o.result ? o.result.errors.length : 1), 0);
  }

  async notices() {
    return (
      await Promise.all(
        this.metadata.map(async (m, drive) => (await m.folderNotices()).map((n) => ({ ...n, drive }))),
      )
    ).flat();
  }

  async record(path: string, drive = 0): Promise<SyncRecord | undefined> {
    return (await this.metadata[drive].all()).find((r) => r.path === path);
  }
}

/** Synced `F/a.md` (or `F/Sub/a.md`), then `F` deleted locally. */
async function folderWorld(drives = 1, child = 'F/a.md') {
  const d = new Device(drives);
  await d.local.write(child, 'a\n');
  if (drives === 1) await d.session();
  else await d.syncAll();
  await d.local.delete('F');
  return d;
}

const pick = (all: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(keys.map((k) => [k, all[k]]));

async function folderDeletion(input: { scenario: string; event?: string }) {
  const { scenario } = input;
  if (scenario === 'folder-delete-deferred') return deferred(input.event ?? '');
  const d = await folderWorld();
  const remote = d.remotes[0];
  const remove = remote.delete.bind(remote);
  const records = async () => ({
    folderRecordRetained: !!(await d.record('F')),
    childRecordRetained: !!(await d.record('F/a.md')),
  });

  if (scenario === 'folder-delete-concurrent-upload') {
    remote.delete = async (entry) => {
      if (entry.isFolder) remote.put('F/new.md', 'unseen', 10);
      return remove(entry);
    };
    const errors = await d.session();
    return {
      errors,
      unseenPreserved: remote.text('F/new.md') === 'unseen',
      folderRecordRetained: (await records()).folderRecordRetained,
    };
  }

  if (
    scenario === 'folder-delete-unsupported' ||
    scenario === 'folder-delete-default-unsupported' ||
    scenario === 'folder-delete-runtime-failure'
  ) {
    if (scenario === 'folder-delete-unsupported') remote.remoteFolderDeletion = 'unsupported';
    else
      remote.delete = async (entry) => {
        if (entry.isFolder) throw new Error('Folder deletion failed');
        return remove(entry);
      };
    const errors = await d.session();
    return {
      errors,
      recursiveDeleteRequests: d.recursiveDeleteRequests,
      folderRecordRetained: (await records()).folderRecordRetained,
      notices: (await d.notices()).length,
    };
  }

  if (scenario === 'folder-delete-local-recreation-race') {
    remote.remoteFolderDeletion = 'unsupported';
    // The child deletion is the last action before the planned preservation.
    remote.delete = async (entry) => {
      await remove(entry);
      if (entry.path === 'F/a.md') await d.local.createFolder('F');
    };
    const errors = await d.session();
    return {
      errors,
      notices: (await d.notices()).length,
      localFolderExists: await d.local.exists('F'),
      remoteFolderExists: remote.exists('F'),
      preserved: (await d.record('F'))?.remoteFolderPreserved === true,
      recursiveDeleteRequests: d.recursiveDeleteRequests,
    };
  }

  if (
    scenario === 'folder-delete-child-revision-race' ||
    scenario === 'folder-delete-unsupported-child-revision-race'
  ) {
    const unsupported = scenario === 'folder-delete-unsupported-child-revision-race';
    if (unsupported) remote.remoteFolderDeletion = 'unsupported';
    remote.delete = async (entry) => {
      if (!entry.isFolder) remote.put(entry.path, 'changed\n', 10);
      return remove(entry);
    };
    const errors = await d.session();
    const result = {
      errors,
      changedChildPreserved: remote.text('F/a.md') === 'changed\n',
      ...(await records()),
    };
    if (!unsupported) return result;
    return {
      ...result,
      notices: (await d.notices()).length,
      recursiveDeleteRequests: d.recursiveDeleteRequests,
    };
  }
  throw new Error(`Unknown executor scenario: ${scenario}`);
}

const DEFERRED_FIELDS: Record<string, string[]> = {
  'restart-pending': [
    'errors',
    'notices',
    'pendingNotices',
    'localFolderExists',
    'remoteFolderExists',
    'folderRecordRetained',
    'repeatActions',
  ],
  'restart-acknowledged': [
    'errors',
    'notices',
    'pendingNotices',
    'acknowledgedNotices',
    'localFolderExists',
    'repeatActions',
  ],
  'new-child': ['errors', 'localFolderExists', 'newChildDownloaded', 'preserved', 'activeNotices'],
  'changed-child': ['errors', 'localFolderExists', 'changedChildDownloaded', 'preserved', 'activeNotices'],
  'ignored-child': [
    'errors',
    'localFolderExists',
    'ignoredChildPreserved',
    'ignoredChildDownloaded',
    'preserved',
    'activeNotices',
  ],
  'new-empty-subfolder': [
    'errors',
    'localFolderExists',
    'localSubfolderExists',
    'preserved',
    'activeNotices',
  ],
  'local-recreation': [
    'errors',
    'notices',
    'pendingNotices',
    'sameRemoteIdentity',
    'localFolderExists',
    'preserved',
  ],
  'local-recreation-remote-missing': [
    'errors',
    'localFolderExists',
    'remoteFolderExists',
    'preserved',
    'activeNotices',
  ],
  'local-recreation-preflight-restart': [
    'errors',
    'localFolderExists',
    'remoteFolderExists',
    'preserved',
    'activeNotices',
  ],
  'remote-disappearance': [
    'errors',
    'localFolderExists',
    'remoteFolderExists',
    'folderRecordRetained',
    'activeNotices',
  ],
  'identity-replacement': [
    'errors',
    'localFolderExists',
    'replacementChildDownloaded',
    'replacementIdentityRecorded',
    'preserved',
    'activeNotices',
  ],
  'identity-replacement-restart': [
    'errors',
    'oldDescendantHistoryRetired',
    'childDownloaded',
    'remoteChildPreserved',
    'activeNotices',
    'recursiveDeleteRequests',
  ],
  'multi-drive': [
    'errors',
    'notices',
    'distinctNoticeDrives',
    'localFolderExists',
    'bothRemoteFoldersExist',
    'preservedRecords',
    'activeNotices',
  ],
  supported: [
    'errors',
    'remoteFolderExists',
    'folderRecordRetained',
    'activeNotices',
    'recursiveDeleteRequests',
  ],
  'failed-listing': [
    'errors',
    'folderRecordRetained',
    'pendingNotices',
    'localFolderExists',
    'remoteFolderExists',
  ],
  'before-preserve-save': [
    'errors',
    'notices',
    'pendingNotices',
    'folderRecordRetained',
    'localFolderExists',
    'repeatActions',
  ],
  'after-preserve-save': [
    'errors',
    'notices',
    'pendingNotices',
    'folderRecordRetained',
    'localFolderExists',
    'repeatActions',
  ],
  'preserve-save-failure': [
    'errors',
    'notices',
    'pendingNotices',
    'folderRecordRetained',
    'localFolderExists',
    'repeatActions',
  ],
  'ack-save-failure': ['errors', 'notices', 'pendingNotices', 'acknowledgedNotices', 'repeatActions'],
  'unchanged-subfolders': [
    'errors',
    'notices',
    'pendingNotices',
    'localFolderExists',
    'preservedRecords',
    'repeatActions',
  ],
};

const sameEntry = (a: RemoteEntry | undefined, b: RemoteEntry | undefined) =>
  !!a && !!b && a.id === b.id && a.version === b.version && a.modifiedMillis === b.modifiedMillis;

/** The deferred removal lifecycle on drives without safe folder deletion (the reference executor's script). */
async function deferred(event: string) {
  const fields = DEFERRED_FIELDS[event];
  if (!fields) throw new Error(`Unknown deferred event: ${event}`);
  const multi = event === 'multi-drive';
  const d = await folderWorld(multi ? 2 : 1, event === 'unchanged-subfolders' ? 'F/Sub/a.md' : 'F/a.md');
  const remote = d.remotes[0];
  const metadata = d.metadata[0];
  const oldId = (await remote.snapshot()).find((e) => e.path === 'F')!.id;
  const baseline = await d.record('F/a.md');
  for (const r of d.remotes) r.remoteFolderDeletion = 'unsupported';

  const preserve = metadata.preserveFolder.bind(metadata);
  if (event === 'before-preserve-save') metadata.preserveFolder = async () => d.crash();
  if (event === 'after-preserve-save')
    metadata.preserveFolder = async (path, remoteId) => {
      await preserve(path, remoteId);
      d.crash();
    };
  if (event === 'preserve-save-failure')
    metadata.preserveFolder = async () => {
      metadata.preserveFolder = preserve;
      throw new Error('Saving the deferred folder failed');
    };
  const remove = remote.delete.bind(remote);
  if (event === 'identity-replacement-restart')
    remote.delete = async () => {
      remote.delete = remove;
      throw new Error('Drive delete failed');
    };

  let errors = multi ? await d.syncAll() : await d.session();
  if (event === 'before-preserve-save' || event === 'after-preserve-save') {
    if (!d.dead) throw new Error('Crash checkpoint was not exercised');
    errors = 0;
    metadata.preserveFolder = preserve;
  }
  d.restart();
  if (
    event === 'before-preserve-save' ||
    event === 'after-preserve-save' ||
    event === 'preserve-save-failure'
  )
    errors += await d.session();

  let oldDescendantHistoryRetired: boolean | undefined;
  const childBefore = (await remote.snapshot()).find((e) => e.path === 'F/a.md');
  const childBytes = remote.text('F/a.md');
  switch (event) {
    case 'restart-acknowledged':
      await metadata.acknowledgeFolderNotice((await metadata.folderNotices())[0].generation);
      break;
    case 'ack-save-failure': {
      const acknowledge = metadata.acknowledgeFolderNotice.bind(metadata);
      metadata.acknowledgeFolderNotice = async () => {
        throw new Error('Saving the acknowledgement failed');
      };
      await metadata
        .acknowledgeFolderNotice((await metadata.folderNotices())[0].generation)
        .catch(() => errors++);
      metadata.acknowledgeFolderNotice = acknowledge;
      break;
    }
    case 'new-child':
      remote.put('F/new.md', 'new\n', 9);
      break;
    case 'changed-child': {
      const entry = remote.putFile('F/a.md', 'base\n', 9);
      await metadata.upsert({
        ...baseline!,
        remoteId: entry.id,
        remoteVersion: entry.version,
        localHash: sha256Hex(utf8.encode('base\n')),
      });
      remote.put('F/a.md', 'changed\n', 10);
      break;
    }
    case 'ignored-child':
      remote.put('F/keep.pdf', 'ignored\n', 9);
      break;
    case 'new-empty-subfolder':
      remote.putFolder('F/New');
      break;
    case 'local-recreation':
      await d.local.createFolder('F');
      errors += await d.session();
      await d.local.delete('F');
      break;
    case 'local-recreation-remote-missing':
    case 'local-recreation-preflight-restart':
      remote.remove('F');
      await d.local.createFolder('F');
      if (event === 'local-recreation-preflight-restart') {
        const recreate = metadata.recreateFolders.bind(metadata);
        metadata.recreateFolders = async (changes) => {
          await recreate(changes);
          d.crash();
        };
        await d.session();
        if (!d.dead) throw new Error('Crash checkpoint was not exercised');
        metadata.recreateFolders = recreate;
        d.restart();
      }
      break;
    case 'remote-disappearance':
      remote.remove('F');
      break;
    case 'identity-replacement':
      remote.remove('F');
      remote.putFolder('F');
      remote.put('F/a.md', 'replacement\n', 10);
      break;
    case 'identity-replacement-restart': {
      remote.nodes.get('F')!.id = 'replaced-F';
      const download = remote.download.bind(remote);
      remote.download = async () => {
        remote.download = download;
        throw new Error('Drive read failed');
      };
      errors += await d.session();
      oldDescendantHistoryRetired = !(await d.record('F/a.md')) && (await d.bases[0].get('F/a.md')) === null;
      d.restart();
      break;
    }
    case 'multi-drive':
      await d.local.createFolder('F');
      if (d.remotes[1].exists('F/a.md')) throw new Error('The second drive kept the child');
      d.remotes[1].remove('F');
      break;
    case 'supported':
      remote.remoteFolderDeletion = undefined;
      break;
    case 'failed-listing': {
      const snapshot = remote.snapshot.bind(remote);
      remote.snapshot = async () => {
        remote.snapshot = snapshot;
        throw new Error('Listing failed');
      };
      break;
    }
  }
  errors += multi ? await d.syncAll() : await d.session();
  let repeatActions = 0;
  if (fields.includes('repeatActions')) {
    d.folderActions = 0;
    errors += await d.session();
    repeatActions = d.folderActions;
  }

  const notices = await d.notices();
  const record = await d.record('F');
  const listed = (path: string, r = remote) => r.snapshot().then((all) => all.find((e) => e.path === path));
  const localText = async (path: string) => ((await d.local.exists(path)) ? d.local.read(path) : undefined);
  const remoteF = await listed('F');
  const all: Record<string, unknown> = {
    errors,
    notices: notices.length,
    pendingNotices: notices.filter((n) => n.active && !n.acknowledged).length,
    acknowledgedNotices: notices.filter((n) => n.acknowledged).length,
    activeNotices: notices.filter((n) => n.active).length,
    localFolderExists: await d.local.exists('F'),
    remoteFolderExists: !!remoteF,
    folderRecordRetained: !!record,
    preserved: record?.remoteFolderPreserved === true,
    repeatActions,
    recursiveDeleteRequests: d.recursiveDeleteRequests,
    newChildDownloaded: (await localText('F/new.md')) === 'new\n',
    changedChildDownloaded: (await localText('F/a.md')) === 'changed\n',
    ignoredChildPreserved: remote.exists('F/keep.pdf'),
    ignoredChildDownloaded: await d.local.exists('F/keep.pdf'),
    localSubfolderExists: await d.local.exists('F/New'),
    sameRemoteIdentity: remoteF?.id === oldId,
    replacementChildDownloaded: (await localText('F/a.md')) === 'replacement\n',
    replacementIdentityRecorded:
      !!record && !!remoteF && record.remoteId === remoteF.id && remoteF.id !== oldId,
    distinctNoticeDrives: new Set(notices.map((n) => n.drive)).size,
    bothRemoteFoldersExist: d.remotes.every((r) => r.exists('F')),
    preservedRecords: (await Promise.all(d.metadata.map((m) => m.all())))
      .flat()
      .filter((r) => r.remoteFolderPreserved).length,
    oldDescendantHistoryRetired,
    childDownloaded: childBytes !== undefined && (await localText('F/a.md')) === childBytes,
    remoteChildPreserved:
      sameEntry(childBefore, await listed('F/a.md')) && remote.text('F/a.md') === childBytes,
  };
  return pick(all, fields);
}
