import { beforeEach, describe, expect, it } from 'vitest';
import { noteIdOf } from '../src/shared/frontMatter';
import {
  buildNoteIndex,
  ensureNoteId,
  filterNotes,
  findMention,
  fullPathOf,
  noteIdFromHref,
  noteLink,
  resolveNoteId,
} from '../src/shared/noteLinks';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';

describe('note links', () => {
  it('formats and parses links', () => {
    expect(noteLink('Roadmap', 'k7f3q2xa')).toBe('[Roadmap](marknotes:k7f3q2xa)');
    expect(noteLink('a [b]', 'k7f3q2xa')).toBe('[a \\[b\\]](marknotes:k7f3q2xa)');
    expect(noteIdFromHref('marknotes:k7f3q2xa')).toBe('k7f3q2xa');
    expect(noteIdFromHref('marknotes:bad')).toBeNull();
    expect(noteIdFromHref('https://example.com')).toBeNull();
  });

  it('full path is folder plus title', () => {
    expect(fullPathOf('Work/Projects/Roadmap.md')).toBe('Work/Projects/Roadmap');
    expect(fullPathOf('Inbox.md')).toBe('Inbox');
  });

  it('finds @ mentions at line start or after whitespace', () => {
    expect(findMention('@', 10)).toEqual({ from: 10, query: '' });
    expect(findMention('see @road', 0)).toEqual({ from: 4, query: 'road' });
    expect(findMention('see @road map', 0)).toEqual({ from: 4, query: 'road map' });
    expect(findMention('mail@example', 0)).toBeNull();
    expect(findMention('@ x', 0)).toBeNull();
    expect(findMention('no mention', 0)).toBeNull();
  });
});

describe('note index', () => {
  let store: NoteStore;
  let counter: number;
  const newId = () => `zzzzzz${String(++counter).padStart(2, '0')}`;

  beforeEach(() => {
    store = new NoteStore(new MemoryNodeBackend());
    counter = 0;
  });

  it('assigns missing ids lazily and writes them back', async () => {
    await store.write('Work/Plan.md', '# Plan');
    await store.write('a.md', '---\nid: aaaaaaaa\n---\nA');
    expect(await buildNoteIndex(store)).toEqual([
      { id: 'aaaaaaaa', path: 'a.md', title: 'a', fullPath: 'a' },
    ]);
    const index = await buildNoteIndex(store, { assign: true, newId });
    expect(index.map((n) => [n.path, n.id])).toEqual([
      ['Work/Plan.md', 'zzzzzz01'],
      ['a.md', 'aaaaaaaa'],
    ]);
    expect(await store.read('Work/Plan.md')).toBe('---\nid: zzzzzz01\n---\n# Plan');
  });

  it('resolves duplicates to the first by sorted path and reassigns the later one', async () => {
    await store.write('b.md', '---\nid: aaaaaaaa\n---\nB');
    await store.write('a.md', '---\nid: aaaaaaaa\n---\nA');
    expect(resolveNoteId(await buildNoteIndex(store), 'aaaaaaaa')?.path).toBe('a.md');
    await buildNoteIndex(store, { assign: true, newId });
    expect(noteIdOf(await store.read('a.md'))).toBe('aaaaaaaa');
    expect(noteIdOf(await store.read('b.md'))).toBe('zzzzzz01');
  });

  it('ignores attachments and folders', async () => {
    await store.writeBytes(`attachments/${'a'.repeat(64)}.png`, new Uint8Array([1]));
    await store.createFolder('empty');
    expect(await buildNoteIndex(store, { assign: true })).toEqual([]);
  });

  it('ensureNoteId keeps an existing id and assigns a missing one', async () => {
    await store.write('n.md', '---\nid: aaaaaaaa\n---\n');
    expect((await ensureNoteId(store, 'n.md')).id).toBe('aaaaaaaa');
    await store.write('m.md', 'body');
    const { id, text } = await ensureNoteId(store, 'm.md', newId);
    expect(id).toBe('zzzzzz01');
    expect(text).toBe('---\nid: zzzzzz01\n---\nbody');
    expect(await store.read('m.md')).toBe(text);
  });

  it('filters by id prefix or title/path substring', () => {
    const notes = [
      { id: 'k7f3q2xa', path: 'Work/Roadmap.md', title: 'Roadmap', fullPath: 'Work/Roadmap' },
      { id: 'abcdefgh', path: 'Home/Shopping.md', title: 'Shopping', fullPath: 'Home/Shopping' },
    ];
    expect(filterNotes(notes, '').length).toBe(2);
    expect(filterNotes(notes, 'k7f').map((n) => n.title)).toEqual(['Roadmap']);
    expect(filterNotes(notes, 'SHOP').map((n) => n.title)).toEqual(['Shopping']);
    expect(filterNotes(notes, 'work/').map((n) => n.title)).toEqual(['Roadmap']);
    expect(filterNotes(notes, 'nothing')).toEqual([]);
  });
});
