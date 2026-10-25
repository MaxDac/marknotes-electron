import { foldCase } from '@marknotes/sync';
import { MANIFEST_PATH } from './manifestPath';
import * as P from './paths';
import {
  RemoteChangedError,
  type RemoteDriveStore,
  type RemoteEntry,
  type RemoteFolderDeletion,
} from './types';

interface FakeNode {
  id: string;
  isFolder: boolean;
  version: string;
  bytes: Uint8Array;
  modified: number;
}

/** In-memory remote drive used by unit tests and the end-to-end fake provider. */
export class FakeRemoteDriveStore implements RemoteDriveStore {
  constructor(readonly timestampResolutionMillis = 1) {}
  /** Undefined declares the default capability; 'unsupported' also makes folder deletion fail. */
  remoteFolderDeletion?: RemoteFolderDeletion;
  readonly nodes = new Map<string, FakeNode>();
  manifest: Uint8Array | null = null;
  /** Number of writeManifest calls. */
  manifestWrites = 0;
  /** Log of the mutating/download operations, e.g. "uploadNew:a.md". */
  readonly calls: string[] = [];
  private counter = 0;

  private nextId() {
    return `id${++this.counter}`;
  }
  private nextVersion() {
    return `v${++this.counter}`;
  }

  private entry(path: string, n: FakeNode): RemoteEntry {
    return { path, id: n.id, isFolder: n.isFolder, version: n.version, modifiedMillis: n.modified };
  }

  async snapshot(): Promise<RemoteEntry[]> {
    return [...this.nodes.entries()].map(([path, n]) => this.entry(path, n));
  }

  async download(entry: RemoteEntry): Promise<Uint8Array> {
    this.calls.push(`download:${entry.path}`);
    const n = this.nodes.get(entry.path);
    if (!n || n.isFolder) throw new Error(`${entry.path} not found`);
    return n.bytes;
  }

  private ensureParents(path: string) {
    const parent = P.parent(path);
    if (this.nodes.has(parent) && !this.nodes.get(parent)!.isFolder) throw new Error(`${parent} is a file`);
    if (parent !== '' && !this.nodes.has(parent)) {
      this.ensureParents(parent);
      this.nodes.set(parent, {
        id: this.nextId(),
        isFolder: true,
        version: '',
        bytes: new Uint8Array(),
        modified: Date.now(),
      });
    }
  }

  async uploadNew(path: string, bytes: Uint8Array, modifiedMillis?: number): Promise<RemoteEntry> {
    this.calls.push(`uploadNew:${path}`);
    if ([...this.nodes.keys()].some((p) => foldCase(p) === foldCase(path)))
      throw new Error(`${path} already exists`);
    this.ensureParents(path);
    const node = {
      id: this.nextId(),
      isFolder: false,
      version: this.nextVersion(),
      bytes,
      modified: this.storedTime(modifiedMillis ?? Date.now()),
    };
    this.nodes.set(path, node);
    return this.entry(path, node);
  }

  async uploadRevision(entry: RemoteEntry, bytes: Uint8Array, modifiedMillis?: number): Promise<RemoteEntry> {
    this.calls.push(`uploadRevision:${entry.path}`);
    const n = this.nodes.get(entry.path);
    if (!n || n.id !== entry.id) throw new Error(`${entry.path} not found`);
    if (n.version !== entry.version) throw new RemoteChangedError(entry.path);
    n.bytes = bytes;
    n.version = this.nextVersion();
    n.modified = this.storedTime(modifiedMillis ?? Date.now());
    return this.entry(entry.path, n);
  }

  async createFolder(path: string): Promise<RemoteEntry> {
    this.calls.push(`createFolder:${path}`);
    if ([...this.nodes.keys()].some((p) => foldCase(p) === foldCase(path)))
      throw new Error(`${path} already exists`);
    return this.putFolder(path);
  }

  /** Test helper: creates a folder (and its parents) as another device would. */
  putFolder(path: string): RemoteEntry {
    const existing = this.nodes.get(path);
    if (existing) return this.entry(path, existing);
    this.ensureParents(path);
    const node = {
      id: this.nextId(),
      isFolder: true,
      version: '',
      bytes: new Uint8Array(),
      modified: Date.now(),
    };
    this.nodes.set(path, node);
    return this.entry(path, node);
  }

  /** Files are only deleted while still at `entry.version`, like the real drives. */
  async delete(entry: RemoteEntry): Promise<void> {
    this.calls.push(`delete:${entry.path}`);
    const n = this.nodes.get(entry.path);
    if (
      n &&
      (n.id !== entry.id || n.isFolder !== entry.isFolder || (!n.isFolder && n.version !== entry.version))
    )
      throw new RemoteChangedError(entry.path);
    if (n?.isFolder && this.remoteFolderDeletion === 'unsupported')
      throw new Error(`${entry.path}: folder deletion is not supported`);
    if (n?.isFolder && [...this.nodes.keys()].some((p) => P.isAncestor(entry.path, p)))
      throw new Error(`${entry.path} is not empty`);
    this.remove(entry.path);
  }

  async rename(entry: RemoteEntry, toPath: string): Promise<void> {
    this.calls.push(`rename:${entry.path}:${toPath}`);
    const node = this.nodes.get(entry.path);
    if (!node || node.id !== entry.id || node.version !== entry.version)
      throw new RemoteChangedError(entry.path);
    const affected = [...this.nodes.entries()].filter(
      ([p]) => p === entry.path || P.isAncestor(entry.path, p),
    );
    const oldPaths = new Set(affected.map(([p]) => p));
    for (const [path] of affected) {
      const target = toPath + path.substring(entry.path.length);
      if ([...this.nodes.keys()].some((p) => !oldPaths.has(p) && foldCase(p) === foldCase(target)))
        throw new Error(`${target} already exists`);
    }

    for (const [path] of affected) this.nodes.delete(path);
    for (const [path, value] of affected) this.nodes.set(toPath + path.substring(entry.path.length), value);
  }

  private storedTime(time: number) {
    return Math.floor(time / this.timestampResolutionMillis) * this.timestampResolutionMillis;
  }
  /** Test helper: removes `path` and everything below it, as another device would. */
  remove(path: string) {
    for (const key of [...this.nodes.keys()]) {
      if (key === path || P.isAncestor(path, key)) this.nodes.delete(key);
    }
  }

  async readManifest() {
    return this.manifest;
  }

  async writeManifest(bytes: Uint8Array) {
    this.manifest = bytes;
    this.manifestWrites++;
  }

  /** Test helper: writes a file as another device would, at `modified` (default: now). */
  put(path: string, text: string, modified: number = Date.now()) {
    const bytes = new TextEncoder().encode(text);
    const existing = this.nodes.get(path);
    if (existing) {
      existing.bytes = bytes;
      existing.version = this.nextVersion();
      existing.modified = modified;
    } else {
      this.ensureParents(path);
      this.nodes.set(path, {
        id: this.nextId(),
        isFolder: false,
        version: this.nextVersion(),
        bytes,
        modified,
      });
    }
  }

  /** Test helper: writes a file as another device would and returns its entry. */
  putFile(path: string, text: string, modified?: number): RemoteEntry {
    this.put(path, text, modified);
    return this.entry(path, this.nodes.get(path)!);
  }

  exists(path: string): boolean {
    return this.nodes.has(path);
  }

  isFolder(path: string): boolean {
    return this.nodes.get(path)?.isFolder === true;
  }

  /** Same as text(): the content of a file, undefined for folders and missing paths. */
  content(path: string): string | undefined {
    return this.text(path);
  }

  text(path: string): string | undefined {
    const n = this.nodes.get(path);
    return n && !n.isFolder ? new TextDecoder().decode(n.bytes) : undefined;
  }

  static readonly MANIFEST = MANIFEST_PATH;
}
