import { describe, expect, it } from 'vitest';
import {
  continueList,
  continueListOnEnter,
  cycleHeading,
  editorText as at,
  insertLink,
  toggleCodeBlock,
  toggleInline,
  toggleLinePrefix,
  type EditorText,
} from '../src/shared/markdownEditing';

/** Simulates typing a newline at the (collapsed) cursor of `old`. */
const enter = (old: EditorText) => {
  const p = old.selectionStart;
  return continueList(old, at(`${old.text.substring(0, p)}\n${old.text.substring(p)}`, p + 1));
};

describe('markdown editing', () => {
  it('bold wraps selection', () => {
    expect(toggleInline(at('a bc d', 2, 4), '**')).toEqual(at('a **bc** d', 4, 6));
  });

  it('bold with empty selection inserts pair and toggles back', () => {
    const inserted = toggleInline(at('ab', 1), '**');
    expect(inserted).toEqual(at('a****b', 3));
    expect(toggleInline(inserted, '**')).toEqual(at('ab', 1));
  });

  it('inline unwraps when markers are outside or inside selection', () => {
    expect(toggleInline(at('a _bc_ d', 3, 5), '_')).toEqual(at('a bc d', 2, 4));
    expect(toggleInline(at('a ~~bc~~ d', 2, 8), '~~')).toEqual(at('a bc d', 2, 4));
  });

  it('inline code wraps selection', () => {
    expect(toggleInline(at('val x', 0, 5), '`')).toEqual(at('`val x`', 1, 6));
  });

  it('bullet adds and removes prefix', () => {
    const added = toggleLinePrefix(at('milk', 4), 'bullet');
    expect(added).toEqual(at('- milk', 6));
    expect(toggleLinePrefix(added, 'bullet')).toEqual(at('milk', 4));
  });

  it('checkbox converts bullet and keeps indent', () => {
    expect(toggleLinePrefix(at('  - milk', 8), 'checkbox')).toEqual(at('  - [ ] milk', 12));
  });

  it('numbered list numbers every selected line', () => {
    expect(toggleLinePrefix(at('a\nb\n\nc', 0, 6), 'numbered')).toEqual(at('1. a\n2. b\n\n3. c', 0, 15));
  });

  it('quote on empty line', () => {
    expect(toggleLinePrefix(at('x\n', 2), 'quote')).toEqual(at('x\n> ', 4));
  });

  it('heading cycles', () => {
    let value = at('Title', 2);
    value = cycleHeading(value);
    expect(value).toEqual(at('# Title', 4));
    value = cycleHeading(value);
    expect(value.text).toBe('## Title');
    value = cycleHeading(value);
    expect(value.text).toBe('### Title');
    value = cycleHeading(value);
    expect(value).toEqual(at('Title', 2));
  });

  it('link wraps selection and selects url', () => {
    expect(insertLink(at('see docs', 4, 8))).toEqual(at('see [docs](url)', 11, 14));
    expect(insertLink(at('', 0))).toEqual(at('[]()', 1));
  });

  it('code block inserted on own lines', () => {
    expect(toggleCodeBlock(at('abcd', 2))).toEqual(at('ab\n```\n\n```\ncd', 6));
    expect(toggleCodeBlock(at('', 0))).toEqual(at('```\n\n```', 3));
  });

  it('code block wraps and unwraps selected lines', () => {
    const wrapped = toggleCodeBlock(at('x\nval a = 1\nval b = 2\ny', 4, 14));
    expect(wrapped).toEqual(at('x\n```\nval a = 1\nval b = 2\n```\ny', 5));
    expect(toggleCodeBlock(at(wrapped.text, 2, 28))).toEqual(at('x\nval a = 1\nval b = 2\ny', 2, 21));
  });

  it('enter continues bullet', () => {
    expect(enter(at('- milk', 6))).toEqual(at('- milk\n- ', 9));
    expect(enter(at('* milk', 6))).toEqual(at('* milk\n* ', 9));
  });

  it('enter continues checkbox unchecked', () => {
    expect(enter(at('  - [x] milk', 12))).toEqual(at('  - [x] milk\n  - [ ] ', 21));
  });

  it('enter increments number', () => {
    expect(enter(at('9) a', 4))).toEqual(at('9) a\n10) ', 9));
  });

  it('enter continues quote', () => {
    expect(enter(at('> hi', 4))).toEqual(at('> hi\n> ', 7));
  });

  it('enter splits item in the middle', () => {
    expect(enter(at('- abcd', 4))).toEqual(at('- ab\n- cd', 7));
  });

  it('enter on empty item ends list', () => {
    expect(enter(at('- milk\n- [ ] ', 13))).toEqual(at('- milk\n', 7));
    expect(enter(at('- milk\n- ', 9))).toEqual(at('- milk\n', 7));
    expect(enter(at('1. a\n2. ', 8))).toEqual(at('1. a\n', 5));
  });

  it('enter does nothing special outside lists', () => {
    expect(enter(at('hello', 5))).toBeNull();
    expect(enter(at('---', 3))).toBeNull();
    expect(enter(at('- milk', 1))).toBeNull();
  });

  it('enter does not continue inside code fence', () => {
    expect(enter(at('```\n- item', 10))).toBeNull();
    expect(enter(at('```\n```\n- a', 11))).toEqual(at('```\n```\n- a\n- ', 14));
  });

  it('non-newline edits are ignored', () => {
    expect(continueList(at('- a', 3), at('- ab', 4))).toBeNull();
    expect(continueList(at('- a', 3), at('- a\n\n', 5))).toBeNull();
  });

  it('continueListOnEnter matches typing a newline', () => {
    expect(continueListOnEnter(at('- milk', 6))).toEqual(at('- milk\n- ', 9));
    expect(continueListOnEnter(at('plain', 5))).toBeNull();
  });
});
