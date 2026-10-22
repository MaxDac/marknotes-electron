import { isInAttachments } from './attachments';
import { newNoteContent } from './frontMatter';
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
}

/** Minimal persistence used by NoteStore. Paths are normalized; the root folder is implicit. */
export interface NodeBackend {
  get(path: string): Promise<StoredNode | undefined>;
  all(): Promise<StoredNode[]>;
  /** Applies the puts and deletes atomically. */
  apply(puts: StoredNode[], deletes: string[]): Promise<void>;
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

  /** Writes a note, creating parent folders as needed. */
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const p = P.normalize(path);
    if (p === '') throw new Error('Cannot write to the root folder');
    const existing = await this.backend.get(p);
    if (existing?.isFolder) throw new Error(`${path} is a folder`);
    const now = this.clock();
    const puts = await this.missingFolders(P.parent(p), now);
    puts.push({ path: p, isFolder: false, modifiedMillis: now, size: bytes.byteLength, content: bytes });
    await this.backend.apply(puts, []);
    this.changed();
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
  async createNote(folder: string, noteName: string): Promise<string> {
    const trimmed = noteName.trim();
    P.validateName(trimmed);
    const fileName = P.isNote(trimmed) ? trimmed : trimmed + P.NOTE_EXTENSION;
    const path = P.join(P.normalize(folder), fileName);
    if (await this.exists(path)) throw new Error(`"${fileName}" already exists`);
    await this.write(path, newNoteContent());
    return path;
  }

  /** Creates a folder named `folderName` inside `folder` and returns its path. */
  async createChildFolder(folder: string, folderName: string): Promise<string> {
    const trimmed = folderName.trim();
    P.validateName(trimmed);
    const path = P.join(P.normalize(folder), trimmed);
    if (isInAttachments(path)) throw new Error(`"${trimmed}" is reserved for images`);
    if (await this.exists(path)) throw new Error(`"${trimmed}" already exists`);
    return this.createFolder(path);
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

  /** Returns a free sibling path for `path` by appending `suffix` (and a counter) before the extension. */
  async uniqueSibling(path: string, suffix: string): Promise<string> {
    const parent = P.parent(path);
    const n = P.name(path);
    const dot = n.lastIndexOf('.');
    const base = dot > 0 ? n.substring(0, dot) : n;
    const ext = dot > 0 ? n.substring(dot) : '';
    let candidate = P.join(parent, `${base}${suffix}${ext}`);
    let counter = 2;
    while (await this.exists(candidate)) {
      candidate = P.join(parent, `${base}${suffix} ${counter}${ext}`);
      counter++;
    }
    return candidate;
  }
}
