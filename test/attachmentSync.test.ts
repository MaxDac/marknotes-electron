import { beforeEach, describe, expect, it } from 'vitest';
import { FakeRemoteDriveStore } from '../src/shared/fakeRemote';
import { sha256Hex, utf8 } from '../src/shared/hashing';
import { SyncManifest } from '../src/shared/manifest';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { SyncEngine, type SyncResult } from '../src/shared/syncEngine';
import { InMemoryBaseContentStore, InMemorySyncMetadataStore } from '../src/shared/types';

const PNG = `attachments/${'a'.repeat(64)}.png`;
const JPG = `attachments/${'b'.repeat(64)}.jpg`;

describe('SyncEngine attachments', () => {
  let local: NoteStore;
  let remote: FakeRemoteDriveStore;
  let base: InMemoryBaseContentStore;
  let engine: SyncEngine;

  beforeEach(() => {
    local = new NoteStore(new MemoryNodeBackend());
    remote = new FakeRemoteDriveStore();
    base = new InMemoryBaseContentStore();
    engine = new SyncEngine(local, remote, new InMemorySyncMetadataStore(), base, '', 'dev', () => 1000);
  });

  async function syncClean(): Promise<SyncResult> {
    const result = await engine.sync();
    expect(result.errors).toEqual([]);
    expect(result.conflicts).toEqual([]);
    return result;
  }

  it('uploads local attachments with their hash in the manifest, without a merge base', async () => {
    const bytes = new Uint8Array([0, 255, 1, 254]);
    await local.writeBytes(PNG, bytes);
    expect((await syncClean()).uploaded).toBe(1);
    expect(remote.nodes.get(PNG)!.bytes).toEqual(bytes);
    const manifest = SyncManifest.parse(utf8.decode(remote.manifest!))!;
    expect(manifest.files[PNG].sha256).toBe(await sha256Hex(bytes));
    expect(await base.get(PNG)).toBeNull();
  });

  it('downloads remote attachments and ignores other files in the attachments folder', async () => {
    remote.putFile(JPG, 'jpeg bytes');
    remote.putFile('attachments/notes.txt', 'x');
    expect((await syncClean()).downloaded).toBe(1);
    expect(await local.read(JPG)).toBe('jpeg bytes');
    expect(await local.exists('attachments/notes.txt')).toBe(false);
  });

  it('never reports a conflict for attachments present on both sides', async () => {
    await local.writeBytes(PNG, utf8.encode('mine'));
    remote.putFile(PNG, 'theirs');
    const result = await syncClean();
    expect(result.uploaded + result.downloaded + result.merged).toBe(0);
    expect(await local.read(PNG)).toBe('mine');

    // A new remote version is recorded, not merged.
    remote.put(PNG, 'theirs again');
    expect((await syncClean()).downloaded).toBe(0);
    remote.calls.length = 0;
    await syncClean();
    expect(remote.calls).toEqual([]);
  });

  it('propagates deletions both ways', async () => {
    await local.writeBytes(PNG, new Uint8Array([1]));
    remote.putFile(JPG, 'jpg');
    await syncClean();

    await local.delete(PNG);
    remote.remove(JPG);
    const result = await syncClean();
    expect(result.deletedRemote).toBe(1);
    expect(result.deletedLocal).toBe(1);
    expect(remote.exists(PNG)).toBe(false);
    expect(await local.exists(JPG)).toBe(false);
  });
});
