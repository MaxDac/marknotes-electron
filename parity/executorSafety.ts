import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { SyncEngine } from '../src/shared/syncEngine';
import { InMemoryBaseContentStore, InMemorySyncMetadataStore } from '../src/shared/types';

/** Runs the spec's race/restart scenarios against the desktop executor, not an expected-result stub. */
export async function executorSafety(input: { scenario: string; crashAfter?: string }) {
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

  if (input.scenario.startsWith('folder-delete-')) {
    await local.createFolder('F');
    if (input.scenario === 'folder-delete-child-revision-race') await local.write('F/old.md', 'old');
    await engine().sync();
    await local.delete('F');
    const remove = remote.delete.bind(remote);
    let recursiveDeleteRequests = 0;
    const removeTree = remote.remove.bind(remote);
    remote.remove = (path) => {
      if (remote.isFolder(path) && [...remote.nodes.keys()].some((p) => p.startsWith(`${path}/`)))
        recursiveDeleteRequests++;
      removeTree(path);
    };
    remote.delete = async (entry) => {
      if (entry.isFolder) {
        if (input.scenario === 'folder-delete-unsupported') {
          throw new Error('Atomic empty-only folder removal is unsupported');
        }
        if (input.scenario === 'folder-delete-concurrent-upload') remote.put('F/new.md', 'unseen', 10);
      } else if (input.scenario === 'folder-delete-child-revision-race') {
        remote.put(entry.path, 'changed', 10);
      }
      await remove(entry);
    };
    const result = await engine().sync();
    const records = await metadata.all();
    const common = {
      errors: result.errors.length,
      folderRecordRetained: records.some((r) => r.path === 'F'),
    };
    if (input.scenario === 'folder-delete-unsupported') return { ...common, recursiveDeleteRequests };
    if (input.scenario === 'folder-delete-child-revision-race')
      return {
        ...common,
        changedChildPreserved: remote.text('F/old.md') === 'changed',
        childRecordRetained: records.some((r) => r.path === 'F/old.md'),
      };
    return { ...common, unseenPreserved: remote.text('F/new.md') === 'unseen' };
  }

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
