import { describe, expect, it } from 'vitest';
import { sha256Hex, utf8 } from '../src/shared/hashing';
import * as P from '../src/shared/paths';

describe('NotePaths', () => {
  it('joins, splits and measures paths', () => {
    expect(P.join('', 'a.md')).toBe('a.md');
    expect(P.join('a/b', 'c.md')).toBe('a/b/c.md');
    expect(P.parent('a/b/c.md')).toBe('a/b');
    expect(P.parent('c.md')).toBe('');
    expect(P.name('a/b/c.md')).toBe('c.md');
    expect(P.depth('')).toBe(0);
    expect(P.depth('a')).toBe(1);
    expect(P.depth('a/b/c.md')).toBe(3);
  });

  it('detects ancestors', () => {
    expect(P.isAncestor('', 'a/b')).toBe(true);
    expect(P.isAncestor('a', 'a/b')).toBe(true);
    expect(P.isAncestor('a', 'a')).toBe(false);
    expect(P.isAncestor('a', 'ab/c')).toBe(false);
  });

  it('recognizes notes and display names', () => {
    expect(P.isNote('a/n.md')).toBe(true);
    expect(P.isNote('N.MD')).toBe(true);
    expect(P.isNote('n.txt')).toBe(false);
    expect(P.displayName('a/Shopping.md')).toBe('Shopping');
    expect(P.displayName('a/folder')).toBe('folder');
  });

  it('validateName reports why a name is invalid', () => {
    expect(() => P.validateName('')).toThrow('Name cannot be empty');
    expect(() => P.validateName('   ')).toThrow('Name cannot be empty');
    expect(() => P.validateName(' a')).toThrow('Name cannot start or end with spaces');
    expect(() => P.validateName('a ')).toThrow('Name cannot start or end with spaces');
    expect(() => P.validateName('a/b')).toThrow('Name cannot contain / or \\');
    expect(() => P.validateName('a\\b')).toThrow('Name cannot contain / or \\');
    expect(() => P.validateName('.')).toThrow('Invalid name');
    expect(() => P.validateName('..')).toThrow('Invalid name');
    expect(() => P.validateName('.hidden')).toThrow('Name cannot start with a dot');
    expect(() => P.validateName('note.md')).not.toThrow();
  });

  it('normalize cleans separators and validates every segment', () => {
    expect(P.normalize('')).toBe('');
    expect(P.normalize('/a//b\\c.md/')).toBe('a/b/c.md');
    expect(() => P.normalize('../secret.md')).toThrow('Invalid name');
    expect(() => P.normalize('a/./b')).toThrow('Invalid name');
    expect(() => P.normalize('a/.git/b')).toThrow('Name cannot start with a dot');
  });

  it('sorts parents before children', () => {
    expect(['a/b/c', 'b', 'a/b', 'a'].sort(P.compareByDepthThenPath)).toEqual(['a', 'b', 'a/b', 'a/b/c']);
  });
});

describe('Hashing', () => {
  it('sha256Hex matches known digests', async () => {
    expect(await sha256Hex(utf8.encode(''))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(await sha256Hex(utf8.encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('utf8 round trips', () => {
    expect(utf8.decode(utf8.encode('héllo ✓'))).toBe('héllo ✓');
  });
});
