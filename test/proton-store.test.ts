import { describe, expect, it } from 'vitest';
import { ProtonDriveStore } from '../src/main/connectors/proton/driveStore';
import { ProtonConnector } from '../src/main/connectors/proton/index';
import { sessionToJson } from '../src/main/connectors/proton/session';
import type {
  DriveClient,
  DriveEvent,
  FileUploader,
  NodeEntity,
  NodeOrUid,
  NodeResult,
  UploadMetadata,
} from '../src/main/connectors/proton/sdk';
import { MemorySecretVault } from '../src/main/vault';
import { RemoteChangedError, type DriveAccount } from '../src/shared/types';

interface FakeNode {
  uid: string;
  parentUid?: string;
  name: string | null;
  type: 'file' | 'folder';
  trashed: boolean;
  content: Uint8Array;
  revision: number;
  mediaType?: string;
  created: number;
}

const uidOf = (n: NodeOrUid) => (typeof n === 'string' ? n : n.uid);
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** In-memory stand-in for the Proton Drive SDK client. */
class FakeDrive implements DriveClient {
  readonly nodes = new Map<string, FakeNode>();
  readonly events: DriveEvent[] = [];
  listings = 0;
  private next = 1;

  constructor() {
    this.nodes.set('root', {
      uid: 'root',
      name: 'root',
      type: 'folder',
      trashed: false,
      content: new Uint8Array(),
      revision: 0,
      created: 0,
    });
  }

  /** Simulates a change made by another client. */
  external(parentUid: string, name: string, content: string): FakeNode {
    const node = this.add(parentUid, name, 'file', enc(content));
    this.emit('node_created', node);
    return node;
  }

  emit(type: string, node: FakeNode) {
    this.events.push({
      type,
      nodeUid: node.uid,
      parentNodeUid: node.parentUid,
      treeEventScopeId: 'vol',
      eventId: `e${this.events.length + 1}`,
    });
  }

  find(path: string): FakeNode | undefined {
    let current = this.nodes.get('root')!;
    for (const part of path.split('/')) {
      const child = [...this.nodes.values()].find(
        (n) => n.parentUid === current.uid && n.name === part && !n.trashed,
      );
      if (!child) return undefined;
      current = child;
    }
    return current;
  }

  private add(parentUid: string, name: string | null, type: 'file' | 'folder', content = new Uint8Array()) {
    const node: FakeNode = {
      uid: `n${this.next++}`,
      parentUid,
      name,
      type,
      trashed: false,
      content,
      revision: 1,
      created: 1000,
    };
    this.nodes.set(node.uid, node);
    return node;
  }

  private entity(node: FakeNode): NodeEntity {
    return {
      uid: node.uid,
      parentUid: node.parentUid,
      name:
        node.name === null
          ? { ok: false, error: new Error('undecryptable') }
          : { ok: true, value: node.name },
      type: node.type,
      creationTime: new Date(node.created),
      modificationTime: new Date(node.created),
      trashTime: node.trashed ? new Date(5) : undefined,
      activeRevision:
        node.type === 'file'
          ? {
              uid: `${node.uid}~r${node.revision}`,
              creationTime: new Date(2000),
              claimedModificationTime: new Date(3000),
            }
          : undefined,
      treeEventScopeId: 'vol',
    };
  }

  addRaw(parentUid: string, name: string | null, type: 'file' | 'folder', trashed = false) {
    const node = this.add(parentUid, name, type);
    node.trashed = trashed;
    return node;
  }

  async getMyFilesRootFolder() {
    return this.entity(this.nodes.get('root')!);
  }

  async *iterateFolderChildren(parent: NodeOrUid) {
    this.listings++;
    for (const node of [...this.nodes.values()]) {
      if (node.parentUid === uidOf(parent)) yield this.entity(node);
    }
  }

  async getNode(uid: NodeOrUid) {
    return this.entity(this.nodes.get(uidOf(uid))!);
  }

  async createFolder(parent: NodeOrUid, name: string) {
    this.requireAbsent(uidOf(parent), name);
    const node = this.add(uidOf(parent), name, 'folder');
    this.emit('node_created', node);
    return this.entity(node);
  }

  async *trashNodes(uids: NodeOrUid[]): AsyncGenerator<NodeResult> {
    for (const uid of uids.map(uidOf)) {
      const node = this.nodes.get(uid);
      if (!node) {
        yield { uid, ok: false, error: new Error('not found') };
        continue;
      }
      node.trashed = true;
      this.emit('node_updated', node);
      yield { uid, ok: true };
    }
  }

  async getFileDownloader(uid: NodeOrUid) {
    const node = this.nodes.get(uidOf(uid))!;
    return {
      downloadToStream: (stream: WritableStream) => ({
        completion: async () => {
          const writer = stream.getWriter();
          await writer.write(node.content.slice(0, 2));
          await writer.write(node.content.slice(2));
          await writer.close();
        },
      }),
    };
  }

  readonly uploads: UploadMetadata[] = [];

  private uploader(target: () => FakeNode, metadata: UploadMetadata): FileUploader {
    this.uploads.push(metadata);
    return {
      uploadFromStream: async (stream: ReadableStream) => {
        const content = new Uint8Array(await new Response(stream).arrayBuffer());
        return {
          completion: async () => {
            const node = target();
            node.content = content;
            node.mediaType = metadata.mediaType;
            this.emit('node_updated', node);
            return { nodeUid: node.uid, nodeRevisionUid: `${node.uid}~r${node.revision}` };
          },
        };
      },
    };
  }

  async getFileUploader(parent: NodeOrUid, name: string, metadata: UploadMetadata) {
    return this.uploader(() => {
      this.requireAbsent(uidOf(parent), name);
      return this.add(uidOf(parent), name, 'file');
    }, metadata);
  }

  private requireAbsent(parentUid: string, name: string) {
    if ([...this.nodes.values()].some((n) => n.parentUid === parentUid && n.name === name && !n.trashed))
      throw new Error(`${name} already exists`);
  }

  async getFileRevisionUploader(uid: NodeOrUid, metadata: UploadMetadata) {
    return this.uploader(() => {
      const node = this.nodes.get(uidOf(uid))!;
      node.revision++;
      return node;
    }, metadata);
  }

  async *iterateEvents(scope: string, lastEventId?: string): AsyncGenerator<DriveEvent> {
    if (!lastEventId) {
      yield { type: 'fast_forward', treeEventScopeId: scope, eventId: `e${this.events.length}` };
      return;
    }
    const start = Number(lastEventId.slice(1));
    for (const event of this.events.slice(start)) yield event;
  }
}

const paths = (entries: { path: string }[]) => entries.map((e) => e.path).sort();

describe('ProtonDriveStore', () => {
  it('creates the sync folder under My files and lists its subtree', async () => {
    const drive = new FakeDrive();
    const store = new ProtonDriveStore(drive, 'Notes/MarkNotes');
    expect(await store.snapshot()).toEqual([]);
    expect(drive.find('Notes/MarkNotes')?.type).toBe('folder');

    const root = drive.find('Notes/MarkNotes')!;
    const sub = drive.addRaw(root.uid, 'sub', 'folder');
    drive.addRaw(sub.uid, 'a.md', 'file');
    drive.addRaw(root.uid, null, 'file', true);
    drive.addRaw(root.uid, 'trashed.md', 'file', true);
    const fresh = new ProtonDriveStore(drive, 'Notes/MarkNotes');
    const entries = await fresh.snapshot();
    expect(paths(entries)).toEqual(['sub', 'sub/a.md']);
    const file = entries.find((e) => e.path === 'sub/a.md')!;
    expect(file).toMatchObject({ isFolder: false, version: `${file.id}~r1`, modifiedMillis: 3000 });
    expect(entries.find((e) => e.path === 'sub')).toMatchObject({
      isFolder: true,
      version: '',
      modifiedMillis: 1000,
    });
  });

  it('fails the snapshot when an entry name cannot be decrypted', async () => {
    const drive = new FakeDrive();
    const store = new ProtonDriveStore(drive, 'MarkNotes');
    await store.snapshot();
    const sub = drive.addRaw(drive.find('MarkNotes')!.uid, 'sub', 'folder');
    drive.addRaw(sub.uid, null, 'file');
    await expect(new ProtonDriveStore(drive, 'MarkNotes').snapshot()).rejects.toThrow(
      "Couldn't decrypt the name of an entry in /sub",
    );
  });

  it('uploads images with their MIME type and the local modification time', async () => {
    const drive = new FakeDrive();
    const store = new ProtonDriveStore(drive, 'MarkNotes', () => 42);
    await store.snapshot();
    await store.uploadNew(`attachments/${'a'.repeat(64)}.png`, enc('png'), 1234);
    await store.uploadNew(`attachments/${'b'.repeat(64)}.jpg`, enc('jpg'));
    expect(drive.uploads[0]).toMatchObject({ mediaType: 'image/png', modificationTime: new Date(1234) });
    expect(drive.uploads[1]).toMatchObject({ mediaType: 'image/jpeg', modificationTime: new Date(42) });
  });

  it('deletes a file only at the synced revision', async () => {
    const drive = new FakeDrive();
    const store = new ProtonDriveStore(drive, 'MarkNotes');
    await store.snapshot();
    const created = await store.uploadNew('note.md', enc('a'));
    await store.uploadRevision(created, enc('b'));
    await expect(store.delete(created)).rejects.toBeInstanceOf(RemoteChangedError);
    expect(paths(await store.snapshot())).toEqual(['note.md']);

    await store.delete((await store.snapshot())[0]);
    expect(paths(await store.snapshot())).toEqual([]);
  });

  it('refuses a sync folder occupied by a file', async () => {
    const drive = new FakeDrive();
    drive.addRaw('root', 'MarkNotes', 'file');
    await expect(new ProtonDriveStore(drive, 'MarkNotes').snapshot()).rejects.toThrow(/is a file/);
  });

  it('uploads, revises, downloads and deletes', async () => {
    const drive = new FakeDrive();
    const store = new ProtonDriveStore(drive, 'MarkNotes', () => 42);
    await store.snapshot();
    const created = await store.uploadNew('dir/note.md', enc('hello'));
    expect(created).toMatchObject({ path: 'dir/note.md', isFolder: false, modifiedMillis: 42 });
    expect(drive.uploads[0]).toMatchObject({ mediaType: 'text/markdown', expectedSize: 5 });
    expect(dec(await store.download(created))).toBe('hello');

    const revised = await store.uploadRevision(created, enc('hello world'));
    expect(revised.version).not.toBe(created.version);
    expect(revised.id).toBe(created.id);
    expect(dec(await store.download(revised))).toBe('hello world');

    const folder = await store.createFolder('empty');
    expect(folder.isFolder).toBe(true);
    expect(paths(await store.snapshot())).toEqual(['dir', 'dir/note.md', 'empty']);

    await expect(store.delete((await store.snapshot()).find((e) => e.path === 'dir')!)).rejects.toThrow(
      /atomic empty-only/,
    );
    expect(paths(await store.snapshot())).toEqual(['dir', 'dir/note.md', 'empty']);
    await expect(store.delete({ ...revised, id: 'missing', version: '' })).rejects.toThrow(/Could not trash/);
  });

  it('never adopts occupied new file or folder targets', async () => {
    const drive = new FakeDrive();
    const store = new ProtonDriveStore(drive, 'MarkNotes');
    await store.snapshot();
    await store.uploadNew('note.md', enc('original'));
    await expect(store.uploadNew('note.md', enc('replacement'))).rejects.toThrow(/already exists/);
    expect(dec(drive.find('MarkNotes/note.md')!.content)).toBe('original');
    await store.createFolder('folder');
    await expect(store.createFolder('folder')).rejects.toThrow(/already exists/);
    await expect(store.createFolder('note.md')).rejects.toThrow(/already exists/);
  });

  it('only re-lists the tree when events touch the synced folder', async () => {
    const drive = new FakeDrive();
    const store = new ProtonDriveStore(drive, 'MarkNotes');
    await store.snapshot();
    const listings = drive.listings;
    await store.snapshot();
    expect(drive.listings).toBe(listings);

    drive.external('root', 'outside.md', 'x');
    await store.snapshot();
    expect(drive.listings).toBe(listings);

    drive.external(drive.find('MarkNotes')!.uid, 'inside.md', 'y');
    expect(paths(await store.snapshot())).toEqual(['inside.md']);
    expect(drive.listings).toBeGreaterThan(listings);

    drive.events.push({
      type: 'tree_refresh',
      treeEventScopeId: 'vol',
      eventId: `e${drive.events.length + 1}`,
    });
    const before = drive.listings;
    await store.snapshot();
    expect(drive.listings).toBeGreaterThan(before);
  });

  it('keeps the manifest hidden in .marknotes', async () => {
    const drive = new FakeDrive();
    const store = new ProtonDriveStore(drive, 'MarkNotes');
    expect(await store.readManifest()).toBeNull();
    await store.writeManifest(enc('{"v":1}'));
    await store.writeManifest(enc('{"v":2}'));
    expect(dec((await store.readManifest())!)).toBe('{"v":2}');
    const manifest = drive.find('MarkNotes/.marknotes/manifest.json')!;
    expect(manifest.revision).toBe(2);
    expect(drive.uploads.at(-1)?.mediaType).toBe('application/json');
    expect(await store.snapshot()).toEqual([]);
  });
});

describe('ProtonConnector.store', () => {
  it('builds an SDK-backed store from the vault session', { timeout: 120_000 }, async () => {
    const vault = new MemorySecretVault();
    await vault.set(
      'proton:user',
      sessionToJson({
        uid: 'uid',
        accessToken: 'at',
        refreshToken: 'rt',
        username: 'alice',
        userId: 'user',
        keyPassphrases: { k: 'p' },
      }),
    );
    const connector = new ProtonConnector({ vault, fetch: async () => new Response('{}', { status: 500 }) });
    const account: DriveAccount = {
      id: 'proton:user',
      provider: 'proton',
      label: 'alice',
      remoteFolder: '',
      createRootFolder: true,
      rootFolderName: 'MarkNotes',
    };
    const store = await connector.store(account);
    expect(store).toBeInstanceOf(ProtonDriveStore);
    expect(await connector.store(account)).toBe(store);
  });
});
