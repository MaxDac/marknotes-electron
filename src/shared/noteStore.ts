import { isInAttachments } from './attachments';
import { newChordSequenceContent } from './chords';
import { newNoteContent } from './frontMatter';
import { foldCase, sha256Hex } from '@marknotes/sync';
import * as P from './paths';

export interface NoteEntry {
  path: string;
  isFolder: boolean;
  modifiedMillis: number;
  size: number;
}

export interface StoredNode extends NoteEntry {
  /** Note content; absent for folders. */
  content?: Uint8Array;
  /** Identifies a completed sync rename even if its content is edited before history migration. */
  syncRenameToken?: string;
}

/** Minimal persistence used by NoteStore. Paths are normalized; the root folder is implicit. */
export interface NodeBackend {
  get(path: string): Promise<StoredNode | undefined>;
  all(): Promise<StoredNode[]>;
  /** Applies the puts and deletes atomically. */
  apply(puts: StoredNode[], deletes: string[]): Promise<void>;
  /** Atomically rejects changes since the complete snapshot was read. */
  applyIfUnchanged(expected: StoredNode[], puts: StoredNode[], deletes: string[]): Promise<void>;
}

export function sameNodes(a: StoredNode[], b: StoredNode[]): boolean {
  if (a.length !== b.length) return false;
  const nodes = new Map(b.map((n) => [n.path, n]));
  return a.every((n) => {
    const other = nodes.get(n.path);
    return (
      other !== undefined &&
      n.isFolder === other.isFolder &&
      n.modifiedMillis === other.modifiedMillis &&
      n.syncRenameToken === other.syncRenameToken &&
      n.size === other.size &&
      n.content?.length === other.content?.length &&
      (n.content?.every((byte, i) => byte === other.content?.[i]) ?? true)
    );
  });
}

export class MemoryNodeBackend implements NodeBackend {
  readonly nodes = new Map<string, StoredNode>();
  async get(path: string) {
    return this.nodes.get(path);
  }
  async all() {
    return [...this.nodes.values()];
  }
  async apply(puts: StoredNode[], deletes: string[]) {
    for (const d of deletes) this.nodes.delete(d);
    for (const p of puts) this.nodes.set(p.path, p);
  }
  async applyIfUnchanged(expected: StoredNode[], puts: StoredNode[], deletes: string[]) {
    if (!sameNodes(expected, [...this.nodes.values()])) throw new Error('Local tree changed during sync');
    for (const path of deletes) this.nodes.delete(path);
    for (const node of puts) this.nodes.set(node.path, node);
  }
}

const byName = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Hidden entries (starting with ".") are ignored, like in the Android LocalNoteStore. */
const isVisible = (n: StoredNode) => !P.name(n.path).startsWith('.');

/** Entries shown in the note tree: the root `attachments` folder holds images and is hidden. */
const isTreeVisible = (n: StoredNode) => isVisible(n) && !isInAttachments(n.path);

const toEntry = ({ path, isFolder, modifiedMillis, size }: StoredNode): NoteEntry => ({
  path,
  isFolder,
  modifiedMillis,
  size,
});

/**
 * The local note tree: markdown notes in folders, addressed by "/"-separated relative paths.
 * Mirrors the Android LocalNoteStore semantics on top of a NodeBackend (IndexedDB in the app).
 */
export class NoteStore {
  private listeners = new Set<() => void>();

  constructor(
    private readonly backend: NodeBackend,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Registers a callback invoked after every change; returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed() {
    this.listeners.forEach((l) => l());
  }

  async exists(path: string): Promise<boolean> {
    const p = P.normalize(path);
    return p === '' || (await this.backend.get(p)) !== undefined;
  }

  async isFolder(path: string): Promise<boolean> {
    const p = P.normalize(path);
    return p === '' || (await this.backend.get(p))?.isFolder === true;
  }

  /** Lists the direct children of `folder`: folders first, then notes, alphabetically. */
  async list(folder = ''): Promise<NoteEntry[]> {
    const base = P.normalize(folder);
    return (await this.backend.all())
      .filter((n) => P.parent(n.path) === base && isTreeVisible(n))
      .map(toEntry)
      .sort(
        (a, b) =>
          Number(a.isFolder ? 0 : 1) - Number(b.isFolder ? 0 : 1) || byName(P.name(a.path), P.name(b.path)),
      );
  }

  /**
   * Lists every folder and file below the root (attachments included), depth first, sorted by name within a
   * folder.
   */
  async listAll(): Promise<NoteEntry[]> {
    const nodes = (await this.backend.all()).filter(isVisible).map(toEntry);
    const children = new Map<string, NoteEntry[]>();
    for (const n of nodes) {
      const parent = P.parent(n.path);
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent)!.push(n);
    }
    const result: NoteEntry[] = [];
    const walk = (folder: string) => {
      const list = (children.get(folder) ?? []).sort((a, b) => (P.name(a.path) < P.name(b.path) ? -1 : 1));
      for (const child of list) {
        result.push(child);
        if (child.isFolder) walk(child.path);
      }
    };
    walk('');
    return result;
  }

  /** Every folder of the note tree (the attachments folder excluded). */
  async listFolders(): Promise<string[]> {
    return (await this.backend.all())
      .filter((n) => n.isFolder && !isInAttachments(n.path))
      .map((n) => n.path)
      .sort();
  }

  async readBytes(path: string): Promise<Uint8Array> {
    const node = await this.backend.get(P.normalize(path));
    if (!node || node.isFolder) throw new Error(`${path} does not exist`);
    return node.content ?? new Uint8Array();
  }

  async read(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  async write(path: string, content: string): Promise<void> {
    await this.writeBytes(path, new TextEncoder().encode(content));
  }

  /**
   * Writes a note, creating parent folders as needed. `modifiedMillis` (default: now) is the modification time
   * to keep, e.g. the drive's time for a downloaded file.
   */
  async writeBytes(path: string, bytes: Uint8Array, modifiedMillis?: number): Promise<void> {
    const p = P.normalize(path);
    if (p === '') throw new Error('Cannot write to the root folder');
    const existing = await this.backend.get(p);
    if (existing?.isFolder) throw new Error(`${path} is a folder`);
    const now = this.clock();
    const puts = await this.missingFolders(P.parent(p), now);
    puts.push({
      path: p,
      isFolder: false,
      modifiedMillis: modifiedMillis ?? now,
      size: bytes.byteLength,
      content: bytes,
      syncRenameToken: existing?.syncRenameToken,
    });
    await this.backend.apply(puts, []);
    this.changed();
  }

  /** Sync writes are create-only or compare-and-swap; neither can overwrite a concurrent edit. */
  async writeSyncedBytes(path: string, bytes: Uint8Array, modifiedMillis: number, expectedHash?: string) {
    const p = P.normalize(path);
    if (p === '') throw new Error('Cannot write to the root folder');
    const snapshot = await this.backend.all();
    const existing = snapshot.find((n) => n.path === p);
    if (expectedHash === undefined) {
      if (snapshot.some((n) => foldCase(n.path) === foldCase(p))) throw new Error(`${path} already exists`);
    } else if (
      !existing ||
      existing.isFolder ||
      sha256Hex(existing.content ?? new Uint8Array()) !== expectedHash
    ) {
      throw new Error(`${path} changed locally during sync`);
    }
    const puts = await this.missingFolders(P.parent(p), modifiedMillis);
    for (const folder of puts) {
      if (snapshot.some((n) => foldCase(n.path) === foldCase(folder.path)))
        throw new Error(`${folder.path} already exists with different case`);
    }
    puts.push({
      path: p,
      isFolder: false,
      modifiedMillis,
      size: bytes.length,
      content: bytes,
      syncRenameToken: existing?.syncRenameToken,
    });
    await this.backend.applyIfUnchanged(snapshot, puts, []);
    this.changed();
  }

  async createSyncedFolder(path: string) {
    const p = P.normalize(path);
    if (!p) throw new Error('Cannot create the root folder');
    const snapshot = await this.backend.all();
    const puts = await this.missingFolders(p, this.clock());
    if (snapshot.some((n) => foldCase(n.path) === foldCase(p))) throw new Error(`${path} already exists`);
    for (const folder of puts) {
      if (snapshot.some((n) => foldCase(n.path) === foldCase(folder.path)))
        throw new Error(`${folder.path} already exists with different case`);
    }
    await this.backend.applyIfUnchanged(snapshot, puts, []);
    this.changed();
  }

  async deleteSynced(path: string, expectedHash?: string) {
    const p = P.normalize(path);
    if (!p) throw new Error('Cannot delete the root folder');
    const snapshot = await this.backend.all();
    const entry = snapshot.find((n) => n.path === p);
    if (entry?.isFolder) {
      if (expectedHash !== undefined) throw new Error(`${path} was replaced by a folder during sync`);
      if (snapshot.some((n) => P.isAncestor(p, n.path))) throw new Error(`${path} is not empty`);
    } else if (
      entry &&
      (expectedHash === undefined || sha256Hex(entry.content ?? new Uint8Array()) !== expectedHash)
    ) {
      throw new Error(`${path} changed locally during sync`);
    }
    await this.backend.applyIfUnchanged(snapshot, [], entry ? [p] : []);
    if (entry) this.changed();
  }

  async renameSynced(
    from: string,
    to: string,
    hashes: Map<string, string>,
    token: string,
    expectedPaths: Set<string>,
  ) {
    const snapshot = await this.backend.all();
    const affected = snapshot.filter((n) => n.path === from || P.isAncestor(from, n.path));
    if (!affected.some((n) => n.path === from)) throw new Error(`${from} does not exist`);
    if (affected.length !== expectedPaths.size || affected.some((n) => !expectedPaths.has(n.path)))
      throw new Error(`${from} changed locally during sync`);
    for (const node of affected) {
      if (!node.isFolder && sha256Hex(node.content ?? new Uint8Array()) !== hashes.get(node.path))
        throw new Error(`${node.path} changed locally during sync`);
    }
    const affectedPaths = new Set(affected.map((n) => n.path));
    const puts = affected.map((n) => ({
      ...n,
      path: to + n.path.substring(from.length),
      syncRenameToken: n.path === from ? token : n.syncRenameToken,
    }));
    for (const node of puts) {
      if (snapshot.some((n) => !affectedPaths.has(n.path) && foldCase(n.path) === foldCase(node.path)))
        throw new Error(`${node.path} already exists`);
    }
    await this.backend.applyIfUnchanged(snapshot, puts, [...affectedPaths]);
    this.changed();
  }

  async hasSyncRenameToken(path: string, token: string) {
    return (await this.backend.get(path))?.syncRenameToken === token;
  }

  async syncRenameToken(path: string) {
    return (await this.backend.get(path))?.syncRenameToken;
  }

  async markSyncedRename(
    path: string,
    token: string,
    expected: { path: string; isFolder: boolean; hash: string }[],
  ) {
    const snapshot = await this.backend.all();
    const affected = snapshot.filter((n) => n.path === path || P.isAncestor(path, n.path));
    if (affected.length !== expected.length) throw new Error(`${path} changed locally during sync`);
    for (const wanted of expected) {
      const node = affected.find((n) => n.path === wanted.path);
      if (
        !node ||
        node.isFolder !== wanted.isFolder ||
        (!node.isFolder && sha256Hex(node.content ?? new Uint8Array()) !== wanted.hash)
      )
        throw new Error(`${wanted.path} changed locally during sync`);
    }
    const root = affected.find((n) => n.path === path);
    if (!root) throw new Error(`${path} does not exist`);
    await this.backend.applyIfUnchanged(snapshot, [{ ...root, syncRenameToken: token }], []);
  }

  /** The entry at `path`, or undefined when missing (hidden entries included). */
  async entry(path: string): Promise<NoteEntry | undefined> {
    const node = await this.backend.get(P.normalize(path));
    return node && toEntry(node);
  }

  private async missingFolders(folder: string, now: number): Promise<StoredNode[]> {
    const puts: StoredNode[] = [];
    let current = folder;
    while (current !== '') {
      const node = await this.backend.get(current);
      if (node && !node.isFolder) throw new Error(`Cannot create folder for ${folder}`);
      if (node) break;
      puts.unshift({ path: current, isFolder: true, modifiedMillis: now, size: 0 });
      current = P.parent(current);
    }
    return puts;
  }

  /** Creates a folder (and its parents) at `path`. */
  async createFolder(path: string): Promise<string> {
    const p = P.normalize(path);
    const existing = p === '' ? undefined : await this.backend.get(p);
    if (existing && !existing.isFolder) throw new Error(`Cannot create folder ${path}`);
    if (p !== '' && !existing) {
      await this.backend.apply(await this.missingFolders(p, this.clock()), []);
      this.changed();
    }
    return p;
  }

  /** Creates an empty note with a fresh id named `noteName` (".md" appended if missing) and returns its path. */
  async createNote(folder: string, noteName: string, content: string = newNoteContent()): Promise<string> {
    const trimmed = noteName.trim();
    P.validateName(trimmed);
    const fileName = P.isNote(trimmed) ? trimmed : trimmed + P.NOTE_EXTENSION;
    const path = P.join(P.normalize(folder), fileName);
    if (await this.exists(path)) throw new Error(`"${fileName}" already exists`);
    await this.writeSyncedBytes(path, new TextEncoder().encode(content), this.clock());
    return path;
  }

  /** Creates an empty chord sequence (a note with `type: chords`) and returns its path. */
  async createChordSequence(folder: string, noteName: string): Promise<string> {
    return this.createNote(folder, noteName, newChordSequenceContent());
  }

  /** Creates a folder named `folderName` inside `folder` and returns its path. */
  async createChildFolder(folder: string, folderName: string): Promise<string> {
    const trimmed = folderName.trim();
    P.validateName(trimmed);
    const path = P.join(P.normalize(folder), trimmed);
    if (isInAttachments(path)) throw new Error(`"${trimmed}" is reserved for images`);
    if (await this.exists(path)) throw new Error(`"${trimmed}" already exists`);
    await this.createSyncedFolder(path);
    return path;
  }

  /** Renames an entry within its folder. Notes keep the ".md" extension. Returns the new path. */
  async rename(path: string, newName: string): Promise<string> {
    const p = P.normalize(path);
    const source = await this.backend.get(p);
    if (!source) throw new Error(`${path} does not exist`);
    const trimmed = newName.trim();
    P.validateName(trimmed);
    const finalName = !source.isFolder && !P.isNote(trimmed) ? trimmed + P.NOTE_EXTENSION : trimmed;
    const newPath = P.join(P.parent(p), finalName);
    if (newPath === p) return newPath;
    if (isInAttachments(newPath)) throw new Error(`"${finalName}" is reserved for images`);
    if (await this.backend.get(newPath)) throw new Error(`"${finalName}" already exists`);
    await this.relocate(p, newPath);
    return newPath;
  }

  /** Moves a note or folder into `targetFolder` ("" = root), keeping its name. Returns the new path. */
  async move(path: string, targetFolder: string): Promise<string> {
    const p = P.normalize(path);
    const target = P.normalize(targetFolder);
    if (p === '') throw new Error('Cannot move the root folder');
    const source = await this.backend.get(p);
    if (!source) throw new Error(`${path} does not exist`);
    if (!(await this.isFolder(target))) throw new Error(`Folder ${target || '/'} does not exist`);
    if (target === p || (source.isFolder && P.isAncestor(p, target))) {
      throw new Error('Cannot move a folder into itself');
    }
    const newPath = P.join(target, P.name(p));
    if (newPath === p) return newPath;
    if (isInAttachments(newPath)) {
      throw new Error('The attachments folder is reserved for images');
    }
    if (await this.backend.get(newPath)) {
      throw new Error(`"${P.name(p)}" already exists in the destination`);
    }
    await this.relocate(p, newPath);
    return newPath;
  }

  private async relocate(from: string, to: string) {
    const affected = (await this.backend.all()).filter((n) => n.path === from || P.isAncestor(from, n.path));
    const puts = affected.map((n) => ({ ...n, path: to + n.path.substring(from.length) }));
    await this.backend.apply(
      puts,
      affected.map((n) => n.path),
    );
    this.changed();
  }

  /** Deletes a note or a folder (recursively). */
  async delete(path: string): Promise<void> {
    const p = P.normalize(path);
    if (p === '') throw new Error('Cannot delete the root folder');
    const affected = (await this.backend.all()).filter((n) => n.path === p || P.isAncestor(p, n.path));
    if (affected.length === 0) return;
    await this.backend.apply(
      [],
      affected.map((n) => n.path),
    );
    this.changed();
  }
}
