import { MANIFEST_DIRECTORY, MANIFEST_PATH } from '../../../shared/manifest';
import { isAncestor, join, name as baseName, normalize, parent as parentPath } from '../../../shared/paths';
import type { RemoteDriveStore, RemoteEntry } from '../../../shared/types';
import type { DriveClient, FileUploader, NodeEntity, UploadMetadata } from './sdk';

export const MEDIA_TYPE = 'text/markdown';
const MANIFEST_MEDIA_TYPE = 'application/json';
const MANIFEST_FILE_NAME = baseName(MANIFEST_PATH);

const isFolder = (node: NodeEntity) => node.type === 'folder';
const isFile = (node: NodeEntity) => node.type === 'file';
const nameOf = (node: NodeEntity) => (node.name.ok ? node.name.value : null);

function bytesStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.length > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * RemoteDriveStore backed by the Proton Drive SDK, scoped to `syncFolder` under "My files" (missing folders
 * are created). Ported from the Android ProtonDriveStore: the tree is traversed once, then kept up to date
 * through the Drive event stream; later snapshots only re-traverse when events report changes inside the
 * synced folder or continuity is lost. The sync manifest lives in `.marknotes/` and is hidden from snapshots.
 */
export class ProtonDriveStore implements RemoteDriveStore {
  private rootUid: string | null = null;
  private scopeId: string | null = null;
  private cursor: string | undefined;
  private stale = true;
  private readonly entries = new Map<string, RemoteEntry>();

  constructor(
    private readonly client: DriveClient,
    private readonly syncFolder: string,
    private readonly now: () => number = Date.now,
  ) {}

  async snapshot(): Promise<RemoteEntry[]> {
    const root = await this.ensureRoot();
    if (!this.stale) await this.applyEvents();
    if (this.stale) {
      // Move the cursor first so changes made during the traversal are seen next time.
      await this.applyEvents();
      const scanRoot = this.rootUid ?? root;
      this.entries.clear();
      await this.scan(scanRoot, '');
      this.stale = false;
    }
    return [...this.entries.values()].map((e) => ({ ...e }));
  }

  async download(entry: RemoteEntry): Promise<Uint8Array> {
    return this.downloadNode(entry.id);
  }

  async uploadNew(path: string, bytes: Uint8Array): Promise<RemoteEntry> {
    const normalized = normalize(path);
    const parent = await this.ensureFolder(parentPath(normalized));
    const now = this.now();
    const uploader = await this.client.getFileUploader(
      parent,
      baseName(normalized),
      this.metadata(bytes, now),
    );
    const result = await this.upload(uploader, bytes);
    const entry: RemoteEntry = {
      path: normalized,
      id: result.nodeUid,
      isFolder: false,
      version: result.nodeRevisionUid,
      modifiedMillis: now,
    };
    this.entries.set(normalized, entry);
    return { ...entry };
  }

  async uploadRevision(entry: RemoteEntry, bytes: Uint8Array): Promise<RemoteEntry> {
    const now = this.now();
    const uploader = await this.client.getFileRevisionUploader(entry.id, this.metadata(bytes, now));
    const result = await this.upload(uploader, bytes);
    const updated: RemoteEntry = { ...entry, version: result.nodeRevisionUid, modifiedMillis: now };
    this.entries.set(entry.path, updated);
    return { ...updated };
  }

  async createFolder(path: string): Promise<RemoteEntry> {
    const normalized = normalize(path);
    await this.ensureFolder(normalized);
    const entry = this.entries.get(normalized);
    if (!entry) throw new Error(`Couldn't create ${normalized} in Proton Drive`);
    return { ...entry };
  }

  async delete(entry: RemoteEntry): Promise<void> {
    for await (const result of this.client.trashNodes([entry.id])) {
      if (!result.ok) throw new Error(`Could not trash ${entry.path}: ${result.error.message}`);
    }
    for (const key of [...this.entries.keys()]) {
      if (key === entry.path || isAncestor(entry.path, key)) this.entries.delete(key);
    }
  }

  async readManifest(): Promise<Uint8Array | null> {
    const root = await this.ensureRoot();
    const folder = await this.findChild(root, MANIFEST_DIRECTORY);
    if (!folder || !isFolder(folder)) return null;
    const file = await this.findChild(folder.uid, MANIFEST_FILE_NAME);
    if (!file || !isFile(file)) return null;
    return this.downloadNode(file.uid);
  }

  async writeManifest(bytes: Uint8Array): Promise<void> {
    const root = await this.ensureRoot();
    let folder = await this.findChild(root, MANIFEST_DIRECTORY);
    if (folder && !isFolder(folder)) throw new Error(`${MANIFEST_DIRECTORY} is a file in Proton Drive`);
    folder ??= await this.client.createFolder(root, MANIFEST_DIRECTORY);
    const existing = await this.findChild(folder.uid, MANIFEST_FILE_NAME);
    const metadata: UploadMetadata = {
      ...this.metadata(bytes, this.now()),
      mediaType: MANIFEST_MEDIA_TYPE,
    };
    const uploader = existing
      ? await this.client.getFileRevisionUploader(existing.uid, metadata)
      : await this.client.getFileUploader(folder.uid, MANIFEST_FILE_NAME, metadata);
    await this.upload(uploader, bytes);
  }

  private metadata(bytes: Uint8Array, now: number): UploadMetadata {
    return {
      mediaType: MEDIA_TYPE,
      expectedSize: bytes.length,
      modificationTime: new Date(now),
      overrideExistingDraftByOtherClient: false,
    };
  }

  private async upload(uploader: FileUploader, bytes: Uint8Array) {
    const controller = await uploader.uploadFromStream(bytesStream(bytes), []);
    return controller.completion();
  }

  private async downloadNode(nodeUid: string): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(chunk) {
        chunks.push(chunk);
      },
    });
    const downloader = await this.client.getFileDownloader(nodeUid);
    await downloader.downloadToStream(sink).completion();
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  /** Resolves (creating missing folders) the synced folder under "My files". */
  private async ensureRoot(): Promise<string> {
    if (this.rootUid) return this.rootUid;
    const myFiles = await this.client.getMyFilesRootFolder();
    this.scopeId = myFiles.treeEventScopeId;
    let uid = myFiles.uid;
    let path = '';
    for (const segment of this.syncFolder.split('/').filter((s) => s !== '')) {
      path = join(path, segment);
      const existing = await this.findChild(uid, segment);
      if (existing && !isFolder(existing)) throw new Error(`${path} is a file in Proton Drive`);
      uid = existing ? existing.uid : (await this.client.createFolder(uid, segment)).uid;
    }
    this.rootUid = uid;
    this.stale = true;
    return uid;
  }

  private async ensureFolder(path: string): Promise<string> {
    if (path === '') return this.ensureRoot();
    const existing = this.entries.get(path);
    if (existing) {
      if (!existing.isFolder) throw new Error(`${path} is a file in Proton Drive`);
      return existing.id;
    }
    const parent = await this.ensureFolder(parentPath(path));
    const found = await this.findChild(parent, baseName(path));
    if (found && !isFolder(found)) throw new Error(`${path} is a file in Proton Drive`);
    const folder = found ?? (await this.client.createFolder(parent, baseName(path)));
    this.entries.set(path, {
      path,
      id: folder.uid,
      isFolder: true,
      version: '',
      modifiedMillis: folder.creationTime.getTime(),
    });
    return folder.uid;
  }

  private async findChild(folderUid: string, name: string): Promise<NodeEntity | null> {
    for await (const node of this.client.iterateFolderChildren(folderUid)) {
      if (!node.trashTime && nameOf(node) === name) return node;
    }
    return null;
  }

  private async scan(folderUid: string, path: string): Promise<void> {
    const folders: { uid: string; path: string }[] = [];
    for await (const node of this.client.iterateFolderChildren(folderUid)) {
      const name = nameOf(node);
      // Undecryptable names, trashed nodes and hidden (dot) entries such as the manifest are skipped.
      if (name === null || node.trashTime || name.startsWith('.')) continue;
      const childPath = join(path, name);
      if (isFolder(node)) {
        this.entries.set(childPath, {
          path: childPath,
          id: node.uid,
          isFolder: true,
          version: '',
          modifiedMillis: node.creationTime.getTime(),
        });
        folders.push({ uid: node.uid, path: childPath });
      } else if (isFile(node) && node.activeRevision) {
        const revision = node.activeRevision;
        this.entries.set(childPath, {
          path: childPath,
          id: node.uid,
          isFolder: false,
          version: revision.uid,
          modifiedMillis: (revision.claimedModificationTime ?? revision.creationTime).getTime(),
        });
      }
    }
    for (const folder of folders) await this.scan(folder.uid, folder.path);
  }

  /** Reads pending Drive events and marks the cache stale when something in the synced folder changed. */
  private async applyEvents(): Promise<void> {
    const scope = this.scopeId;
    if (!scope) return;
    const known = new Set([...this.entries.values()].map((e) => e.id));
    if (this.rootUid) known.add(this.rootUid);
    const touches = (...uids: (string | undefined)[]) =>
      uids.some((uid) => uid !== undefined && known.has(uid));
    for await (const event of this.client.iterateEvents(scope, this.cursor)) {
      switch (event.type) {
        case 'node_created':
        case 'node_updated':
        case 'node_deleted':
          if (touches(event.nodeUid, event.parentNodeUid)) this.stale = true;
          break;
        case 'tree_refresh':
          this.stale = true;
          break;
        case 'tree_remove':
          this.stale = true;
          this.rootUid = null;
          break;
        default:
          break;
      }
      this.cursor = event.type === 'tree_remove' ? undefined : event.eventId;
    }
    if (!this.rootUid) await this.ensureRoot();
  }
}
