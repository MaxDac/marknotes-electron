import { MANIFEST_PATH } from './manifestPath';
import * as P from './paths';
import type { RemoteDriveStore, RemoteEntry } from './types';

interface FakeNode {
  id: string;
  isFolder: boolean;
  version: string;
  bytes: Uint8Array;
  modified: number;
}

/** In-memory remote drive used by unit tests and the end-to-end fake provider. */
export class FakeRemoteDriveStore implements RemoteDriveStore {
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

  async uploadNew(path: string, bytes: Uint8Array): Promise<RemoteEntry> {
    this.calls.push(`uploadNew:${path}`);
    if (this.nodes.has(path)) throw new Error(`${path} already exists`);
    this.ensureParents(path);
    const node = {
      id: this.nextId(),
      isFolder: false,
      version: this.nextVersion(),
      bytes,
      modified: Date.now(),
    };
    this.nodes.set(path, node);
    return this.entry(path, node);
  }

  async uploadRevision(entry: RemoteEntry, bytes: Uint8Array): Promise<RemoteEntry> {
    this.calls.push(`uploadRevision:${entry.path}`);
    const n = this.nodes.get(entry.path);
    if (!n || n.id !== entry.id) throw new Error(`${entry.path} not found`);
    n.bytes = bytes;
    n.version = this.nextVersion();
    n.modified = Date.now();
    return this.entry(entry.path, n);
  }

  async createFolder(path: string): Promise<RemoteEntry> {
    this.calls.push(`createFolder:${path}`);
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

  async delete(entry: RemoteEntry): Promise<void> {
    this.calls.push(`delete:${entry.path}`);
    this.remove(entry.path);
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
