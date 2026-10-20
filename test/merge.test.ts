import { describe, expect, it } from 'vitest';
import { diff, lines, matches } from '../src/shared/diff';
import { MARKER_LOCAL, MARKER_REMOTE, MARKER_SEPARATOR, merge3 } from '../src/shared/merge';

describe('LineDiff', () => {
  it('lines keep terminators', () => {
    expect(lines('a\nb\nc')).toEqual(['a\n', 'b\n', 'c']);
    expect(lines('a\n\n')).toEqual(['a\n', '\n']);
    expect(lines('')).toEqual([]);
  });

  it('diff marks added and removed lines', () => {
    expect(diff('a\nb\nc\n', 'a\nx\nc\nd\n')).toEqual([
      { type: 'same', text: 'a\n' },
      { type: 'removed', text: 'b\n' },
      { type: 'added', text: 'x\n' },
      { type: 'same', text: 'c\n' },
      { type: 'added', text: 'd\n' },
    ]);
  });

  it('matches are a longest common subsequence', () => {
    const a = [...'abcabba'].map((c) => `${c}\n`);
    const b = [...'cbabac'].map((c) => `${c}\n`);
    const m = matches(a, b);
    expect(m).toHaveLength(4);
    for (const [i, j] of m) expect(a[i]).toBe(b[j]);
    expect([...m].sort((x, y) => x[0] - y[0])).toEqual(m);
    expect([...m].sort((x, y) => x[1] - y[1])).toEqual(m);
  });

  it('diff round trips both sides', () => {
    const range = Array.from({ length: 200 }, (_, i) => i + 1);
    const oldText = range.map((i) => `line ${i}`).join('\n');
    const newText = range
      .filter((i) => i % 7 !== 0)
      .map((i) => (i % 5 === 0 ? `changed ${i}` : `line ${i}`))
      .join('\n');
    const d = diff(oldText, newText);
    expect(
      d
        .filter((l) => l.type !== 'added')
        .map((l) => l.text)
        .join(''),
    ).toBe(oldText);
    expect(
      d
        .filter((l) => l.type !== 'removed')
        .map((l) => l.text)
        .join(''),
    ).toBe(newText);
  });
});

describe('ThreeWayMerge', () => {
  it('non-overlapping edits merge automatically', () => {
    const base = 'title\n\none\ntwo\nthree\n';
    const local = 'title\n\none (local)\ntwo\nthree\n';
    const remote = 'title\n\none\ntwo\nthree\nfour (remote)\n';

    const result = merge3(base, local, remote);

    expect(result.hasConflicts).toBe(false);
    expect(result.text()).toBe('title\n\none (local)\ntwo\nthree\nfour (remote)\n');
  });

  it('overlapping edits conflict', () => {
    const result = merge3('a\nb\nc\n', 'a\nlocal\nc\n', 'a\nremote\nc\n');

    expect(result.hasConflicts).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    const conflict = result.conflicts[0];
    expect(conflict.base.join('')).toBe('b\n');
    expect(conflict.local.join('')).toBe('local\n');
    expect(conflict.remote.join('')).toBe('remote\n');
    expect(result.text({ 0: 'local' })).toBe('a\nlocal\nc\n');
    expect(result.text({ 0: 'remote' })).toBe('a\nremote\nc\n');
    expect(result.text({ 0: 'both' })).toBe('a\nlocal\nremote\nc\n');
    expect(result.text({ 0: 'neither' })).toBe('a\nc\n');
  });

  it('unresolved conflicts use git markers', () => {
    const result = merge3('x', 'local', 'remote');
    expect(result.text()).toBe(`${MARKER_LOCAL}\nlocal\n${MARKER_SEPARATOR}\nremote\n${MARKER_REMOTE}\n`);
  });

  it('identical changes on both sides are not a conflict', () => {
    const result = merge3('a\nb\n', 'a\nB\n', 'a\nB\n');
    expect(result.hasConflicts).toBe(false);
    expect(result.text()).toBe('a\nB\n');
  });

  it('deletion on one side and edit elsewhere merge', () => {
    const result = merge3('1\n2\n3\n4\n', '1\n3\n4\n', '1\n2\n3\n4!\n');
    expect(result.hasConflicts).toBe(false);
    expect(result.text()).toBe('1\n3\n4!\n');
  });

  it('without base every difference is a conflict', () => {
    const result = merge3(null, 'same\nlocal only\n', 'same\n');
    expect(result.hasConflicts).toBe(true);
    const first = result.chunks[0];
    expect(first.kind).toBe('resolved');
    expect(first.kind === 'resolved' && first.lines.join('')).toBe('same\n');
    expect(result.text({ 0: 'local' })).toBe('same\nlocal only\n');
    expect(result.text({ 0: 'remote' })).toBe('same\n');
  });

  it('conflicts are indexed in order', () => {
    const base = 'a\nb\nc\nd\ne\n';
    const local = 'A1\nb\nc\nd\nE1\n';
    const remote = 'A2\nb\nc\nd\nE2\n';
    const result = merge3(base, local, remote);
    expect(result.conflicts).toHaveLength(2);
    expect(result.text({ 0: 'local', 1: 'remote' })).toBe('A1\nb\nc\nd\nE2\n');
  });
});
