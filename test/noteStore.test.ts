import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';

describe('NoteStore', () => {
  let backend: MemoryNodeBackend;
  let store: NoteStore;

  beforeEach(() => {
    backend = new MemoryNodeBackend();
    store = new NoteStore(backend);
  });

  it('createNote adds extension and is empty', async () => {
    const path = await store.createNote('', 'Shopping');
    expect(path).toBe('Shopping.md');
    expect(await store.read(path)).toBe('');
  });

  it('write and read in nested folders', async () => {
    await store.write('a/b/note.md', '# Hello');
    expect(await store.read('a/b/note.md')).toBe('# Hello');
    expect(await store.isFolder('a/b')).toBe(true);
  });

  it('list sorts folders first and hides temp files', async () => {
    await store.write('zeta.md', 'z');
    await store.write('Alpha.md', 'a');
    await store.createChildFolder('', 'folder');
    const content = new TextEncoder().encode('x');
    backend.nodes.set('.hidden.tmp', {
      path: '.hidden.tmp',
      isFolder: false,
      modifiedMillis: 0,
      size: content.byteLength,
      content,
    });
    const names = (await store.list('')).map((e) => e.path);
    expect(names).toEqual(['folder', 'Alpha.md', 'zeta.md']);
  });

  it('listAll is recursive', async () => {
    await store.write('a/one.md', '1');
    await store.write('a/b/two.md', '2');
    const paths = new Set((await store.listAll()).map((e) => e.path));
    expect(paths).toEqual(new Set(['a', 'a/one.md', 'a/b', 'a/b/two.md']));
  });

  it('rename keeps extension and folder', async () => {
    await store.write('a/old.md', 'x');
    const newPath = await store.rename('a/old.md', 'new');
    expect(newPath).toBe('a/new.md');
    expect(await store.exists('a/old.md')).toBe(false);
    expect(await store.read(newPath)).toBe('x');
  });

  it('rename folder', async () => {
    await store.write('a/note.md', 'x');
    expect(await store.rename('a', 'b')).toBe('b');
    expect(await store.read('b/note.md')).toBe('x');
  });

  it('createNote fails when existing', async () => {
    await store.createNote('', 'dup');
    await expect(store.createNote('', 'dup.md')).rejects.toThrow('"dup.md" already exists');
  });

  it('delete folder recursively', async () => {
    await store.write('a/b/c.md', 'x');
    await store.delete('a');
    expect(await store.exists('a')).toBe(false);
  });

  it('rejects path traversal', async () => {
    await expect(store.read('../secret.md')).rejects.toThrow('Invalid name');
  });

  it('overwrite replaces content', async () => {
    await store.write('n.md', 'one');
    await store.write('n.md', 'two');
    expect(await store.read('n.md')).toBe('two');
  });

  it('uniqueSibling adds counter', async () => {
    await store.write('a/n.md', 'x');
    expect(await store.uniqueSibling('a/n.md', ' (copy)')).toBe('a/n (copy).md');
    await store.write('a/n (copy).md', 'y');
    expect(await store.uniqueSibling('a/n.md', ' (copy)')).toBe('a/n (copy) 2.md');
  });

  it('move note and folder between folders', async () => {
    await store.write('a/n.md', 'x');
    await store.write('a/sub/deep.md', 'd');
    await store.createFolder('b');

    expect(await store.move('a/n.md', 'b')).toBe('b/n.md');
    expect(await store.read('b/n.md')).toBe('x');
    expect(await store.exists('a/n.md')).toBe(false);

    expect(await store.move('a/sub', 'b')).toBe('b/sub');
    expect(await store.read('b/sub/deep.md')).toBe('d');

    expect(await store.move('b/n.md', '')).toBe('n.md');
    expect(await store.listFolders()).toEqual(['a', 'b', 'b/sub']);
  });

  it('move rejects invalid targets', async () => {
    await store.write('a/sub/n.md', 'x');
    await store.write('b/n.md', 'y');

    await expect(store.move('a', 'a/sub')).rejects.toThrow('Cannot move a folder into itself');
    await expect(store.move('a', 'a')).rejects.toThrow('Cannot move a folder into itself');
    await expect(store.move('b/n.md', 'a/sub')).rejects.toThrow('"n.md" already exists in the destination');
    await expect(store.move('b/n.md', 'missing')).rejects.toThrow('Folder missing does not exist');
    expect(await store.read('b/n.md')).toBe('y');
  });
});
