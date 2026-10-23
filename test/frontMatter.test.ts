import { describe, expect, it } from 'vitest';
import {
  generateNoteId,
  isNoteId,
  joinFrontMatter,
  newNoteContent,
  noteIdOf,
  NOTE_ID_ALPHABET,
  splitFrontMatter,
  withNoteId,
} from '../src/shared/frontMatter';

describe('note ids', () => {
  it('are 8 characters from the Crockford alphabet without i, l, o, u', () => {
    expect(NOTE_ID_ALPHABET).toHaveLength(32);
    expect(NOTE_ID_ALPHABET).not.toMatch(/[ilou]/);
    for (let i = 0; i < 50; i++) expect(isNoteId(generateNoteId())).toBe(true);
    expect(generateNoteId(() => new Uint8Array([0, 1, 31, 32, 255, 10, 20, 30]))).toBe('01z0zamy');
  });

  it('rejects invalid ids', () => {
    expect(isNoteId('k7f3q2xa')).toBe(true);
    expect(isNoteId('K7F3Q2XA')).toBe(false);
    expect(isNoteId('k7f3q2x')).toBe(false);
    expect(isNoteId('k7f3q2xi')).toBe(false);
  });
});

describe('front-matter', () => {
  it('re-attaching a header without a final line break inserts one', () => {
    expect(joinFrontMatter('---\nid: k7f3q2xa\n---', 'Hello')).toBe('---\nid: k7f3q2xa\n---\nHello');
    expect(joinFrontMatter('---\r\nid: k7f3q2xa\r\n---', 'Hello\r\n')).toBe(
      '---\r\nid: k7f3q2xa\r\n---\r\nHello\r\n',
    );
    expect(joinFrontMatter('---\nid: k7f3q2xa\n---', '')).toBe('---\nid: k7f3q2xa\n---');
    expect(joinFrontMatter('---\nid: k7f3q2xa\n---\n', 'Hello')).toBe('---\nid: k7f3q2xa\n---\nHello');
    expect(joinFrontMatter('', 'Hello')).toBe('Hello');
  });

  it('splits the header from the body', () => {
    const text = '---\nid: k7f3q2xa\ntags: [a]\n---\n# Title\n';
    expect(splitFrontMatter(text)).toEqual({
      frontMatter: '---\nid: k7f3q2xa\ntags: [a]\n---\n',
      body: '# Title\n',
      id: 'k7f3q2xa',
    });
  });

  it('treats text without a closed header as body only', () => {
    expect(splitFrontMatter('# Title')).toEqual({ frontMatter: '', body: '# Title', id: null });
    expect(splitFrontMatter('---\nid: k7f3q2xa\n')).toEqual({
      frontMatter: '',
      body: '---\nid: k7f3q2xa\n',
      id: null,
    });
    expect(splitFrontMatter('text\n---\nid: k7f3q2xa\n---\n').id).toBeNull();
  });

  it('accepts quoted ids, CRLF and a header at the end of the file', () => {
    expect(noteIdOf('---\r\nid: "k7f3q2xa"\r\n---\r\nbody')).toBe('k7f3q2xa');
    expect(splitFrontMatter('---\nid: k7f3q2xa\n---')).toEqual({
      frontMatter: '---\nid: k7f3q2xa\n---',
      body: '',
      id: 'k7f3q2xa',
    });
  });

  it('ignores invalid ids', () => {
    expect(noteIdOf('---\nid: not-an-id\n---\n')).toBeNull();
  });

  it('adds an id to a note without front-matter', () => {
    expect(withNoteId('# Hello', 'k7f3q2xa')).toBe('---\nid: k7f3q2xa\n---\n# Hello');
  });

  it('adds or replaces the id preserving other keys', () => {
    expect(withNoteId('---\ntitle: x\n---\nbody', 'k7f3q2xa')).toBe('---\nid: k7f3q2xa\ntitle: x\n---\nbody');
    expect(withNoteId('---\ntitle: x\nid: aaaaaaaa\n---\nbody', 'k7f3q2xa')).toBe(
      '---\ntitle: x\nid: k7f3q2xa\n---\nbody',
    );
    expect(withNoteId('---\n---\nbody', 'k7f3q2xa')).toBe('---\nid: k7f3q2xa\n---\nbody');
  });

  it('round-trips header and body', () => {
    const text = '---\nid: k7f3q2xa\n---\nbody\n---\nnot a header\n---\n';
    const split = splitFrontMatter(text);
    expect(split.body).toBe('body\n---\nnot a header\n---\n');
    expect(joinFrontMatter(split.frontMatter, split.body)).toBe(text);
  });

  it('new notes contain only a header', () => {
    expect(newNoteContent('k7f3q2xa')).toBe('---\nid: k7f3q2xa\n---\n');
    expect(splitFrontMatter(newNoteContent()).body).toBe('');
  });
});
