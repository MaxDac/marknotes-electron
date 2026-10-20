/** Editor text plus selection, independent of the editor widget so the logic is unit testable. */
export interface EditorText {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

export const editorText = (
  text: string,
  selectionStart: number,
  selectionEnd = selectionStart,
): EditorText => ({
  text,
  selectionStart,
  selectionEnd,
});

const min = (v: EditorText) => Math.min(v.selectionStart, v.selectionEnd);
const max = (v: EditorText) => Math.max(v.selectionStart, v.selectionEnd);
const collapsed = (v: EditorText) => v.selectionStart === v.selectionEnd;

export type LineKind = 'bullet' | 'numbered' | 'checkbox' | 'quote';

/** A recognised block marker at the start of a line, e.g. `  - [ ] ` or `3. `. */
export interface LineMarker {
  indent: string;
  kind: LineKind;
  marker: string;
  bullet: string;
  number: number;
  delimiter: string;
}

const prefixLength = (m: LineMarker) => m.indent.length + m.marker.length;

function nextMarker(m: LineMarker): string {
  switch (m.kind) {
    case 'bullet':
      return `${m.bullet} `;
    case 'checkbox':
      return `${m.bullet} [ ] `;
    case 'numbered':
      return `${m.number + 1}${m.delimiter} `;
    case 'quote':
      return '> ';
  }
}

const FENCE = '```';
const MAX_HEADING_LEVEL = 3;
const indentRegex = /^[ \t]*/;
const checkboxRegex = /^([-*+]) \[([ xX])\](?: |$)/;
const bulletRegex = /^([-*+]) /;
const numberedRegex = /^(\d{1,9})([.)]) /;
const quoteRegex = /^> ?/;
const headingRegex = /^(#{1,6}) /;

const indentOf = (line: string) => indentRegex.exec(line)![0];

export function parseMarker(line: string): LineMarker | null {
  const indent = indentOf(line);
  const rest = line.substring(indent.length);
  const base = { indent, bullet: '-', number: 0, delimiter: '.' };
  let m = checkboxRegex.exec(rest);
  if (m) return { ...base, kind: 'checkbox', marker: m[0], bullet: m[1] };
  m = bulletRegex.exec(rest);
  if (m) return { ...base, kind: 'bullet', marker: m[0], bullet: m[1] };
  m = numberedRegex.exec(rest);
  if (m) return { ...base, kind: 'numbered', marker: m[0], number: parseInt(m[1], 10), delimiter: m[2] };
  m = quoteRegex.exec(rest);
  if (m) return { ...base, kind: 'quote', marker: m[0] };
  return null;
}

const lineStart = (text: string, index: number) => (index <= 0 ? 0 : text.lastIndexOf('\n', index - 1) + 1);

function lineEnd(text: string, index: number) {
  const newline = text.indexOf('\n', index);
  return newline < 0 ? text.length : newline;
}

// `**|**` inside a longer run such as `****` is not a wrapped empty selection of a shorter marker.
function isLongerRun(text: string, from: number, to: number, marker: string) {
  const c = marker[marker.length - 1];
  return (from > 0 && text[from - 1] === c) || (to < text.length && text[to] === c);
}

/** Wraps the selection in `marker` (e.g. `**`), or unwraps it when already wrapped. */
export function toggleInline(value: EditorText, marker: string): EditorText {
  const { text } = value;
  const s = min(value);
  const e = max(value);
  const m = marker.length;
  const selected = text.substring(s, e);
  const wrappedOutside =
    s >= m &&
    text.startsWith(marker, s - m) &&
    text.startsWith(marker, e) &&
    !(selected === '' && isLongerRun(text, s - m, e + m, marker));
  if (wrappedOutside) {
    const newText = text.substring(0, s - m) + text.substring(s, e) + text.substring(e + m);
    return editorText(newText, s - m, e - m);
  }
  if (selected.length >= 2 * m && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.substring(m, selected.length - m);
    return editorText(text.substring(0, s) + inner + text.substring(e), s, s + inner.length);
  }
  return editorText(text.substring(0, s) + marker + selected + marker + text.substring(e), s + m, e + m);
}

function prefixFor(kind: LineKind, number: number) {
  switch (kind) {
    case 'bullet':
      return '- ';
    case 'numbered':
      return `${number}. `;
    case 'checkbox':
      return '- [ ] ';
    case 'quote':
      return '> ';
  }
}

/** Adds `kind`'s marker to every selected line, converting other markers; removes it if all have it. */
export function toggleLinePrefix(value: EditorText, kind: LineKind): EditorText {
  const { text } = value;
  const start = lineStart(text, min(value));
  const end = lineEnd(text, max(value));
  const lines = text.substring(start, end).split('\n');
  const nonBlank = lines.filter((l) => l.trim() !== '');
  const relevant = nonBlank.length > 0 ? nonBlank : lines;
  const remove = relevant.every((l) => parseMarker(l)?.kind === kind);
  let number = 1;
  const firstParsed = parseMarker(lines[0]);
  const firstOldPrefix = firstParsed ? prefixLength(firstParsed) : indentOf(lines[0]).length;
  let firstNewPrefix = 0;
  const newLines = lines.map((line, index) => {
    const parsed = parseMarker(line);
    const indent = parsed?.indent ?? indentOf(line);
    const content = line.substring(parsed ? prefixLength(parsed) : indent.length);
    let newLine: string;
    if (remove) newLine = indent + content;
    else if (line.trim() === '' && lines.length > 1) newLine = line;
    else newLine = indent + prefixFor(kind, number++) + content;
    if (index === 0) firstNewPrefix = newLine.length - content.length;
    return newLine;
  });
  const block = newLines.join('\n');
  const delta = block.length - (end - start);
  const newText = text.substring(0, start) + block + text.substring(end);
  const firstDelta = firstNewPrefix - firstOldPrefix;
  let mappedStart: number;
  if (!collapsed(value) && min(value) === start) mappedStart = start;
  else if (min(value) - start < firstOldPrefix) mappedStart = start + firstNewPrefix;
  else mappedStart = min(value) + firstDelta;
  const mappedEnd = collapsed(value) ? mappedStart : Math.max(mappedStart, max(value) + delta);
  return editorText(newText, mappedStart, mappedEnd);
}

/** Cycles the current line through no heading → `#` → `##` → `###` → no heading. */
export function cycleHeading(value: EditorText): EditorText {
  const { text } = value;
  const start = lineStart(text, min(value));
  const end = lineEnd(text, start);
  const line = text.substring(start, end);
  const current = headingRegex.exec(line);
  const level = current ? current[1].length : 0;
  const oldPrefix = current ? current[0].length : 0;
  const nextLevel = level >= MAX_HEADING_LEVEL ? 0 : level + 1;
  const newPrefix = nextLevel === 0 ? '' : `${'#'.repeat(nextLevel)} `;
  const newText = text.substring(0, start) + newPrefix + line.substring(oldPrefix) + text.substring(end);
  const map = (pos: number) =>
    pos - start < oldPrefix ? start + newPrefix.length : pos + newPrefix.length - oldPrefix;
  return editorText(newText, map(value.selectionStart), map(value.selectionEnd));
}

/** Inserts `[selection](url)` with `url` selected, or `[]()` with the cursor in the brackets. */
export function insertLink(value: EditorText): EditorText {
  const { text } = value;
  const s = min(value);
  const e = max(value);
  const label = text.substring(s, e);
  if (label === '') return editorText(`${text.substring(0, s)}[]()${text.substring(e)}`, s + 1);
  const placeholder = 'url';
  const newText = `${text.substring(0, s)}[${label}](${placeholder})${text.substring(e)}`;
  const urlStart = s + label.length + 3;
  return editorText(newText, urlStart, urlStart + placeholder.length);
}

/**
 * Wraps the selected lines in a fenced code block, inserts an empty block when nothing is selected,
 * or removes the fences when the selection is a block.
 */
export function toggleCodeBlock(value: EditorText): EditorText {
  const { text } = value;
  if (collapsed(value)) {
    const s = min(value);
    const before = s > 0 && text[s - 1] !== '\n' ? '\n' : '';
    const after = s < text.length && text[s] !== '\n' ? '\n' : '';
    const insert = `${before}${FENCE}\n\n${FENCE}${after}`;
    return editorText(text.substring(0, s) + insert + text.substring(s), s + before.length + FENCE.length);
  }
  const start = lineStart(text, min(value));
  const end = lineEnd(text, max(value));
  const lines = text.substring(start, end).split('\n');
  if (
    lines.length >= 2 &&
    lines[0].trimStart().startsWith(FENCE) &&
    lines[lines.length - 1].trim() === FENCE
  ) {
    const inner = lines.slice(1, -1).join('\n');
    return editorText(text.substring(0, start) + inner + text.substring(end), start, start + inner.length);
  }
  const block = text.substring(start, end);
  return editorText(
    `${text.substring(0, start)}${FENCE}\n${block}\n${FENCE}${text.substring(end)}`,
    start + FENCE.length,
  );
}

const insideCodeFence = (text: string, start: number) =>
  text
    .substring(0, start)
    .split('\n')
    .filter((l) => l.trimStart().startsWith(FENCE)).length %
    2 ===
  1;

/**
 * When `next` is `old` with a single newline typed at the cursor on a list/checkbox/quote line,
 * returns the edit that continues the list (or ends it when the item was empty); null otherwise.
 */
export function continueList(old: EditorText, next: EditorText): EditorText | null {
  if (!collapsed(old) || !collapsed(next)) return null;
  const p = old.selectionStart;
  const { text } = old;
  if (next.text.length !== text.length + 1 || next.selectionStart !== p + 1) return null;
  const typedNewline =
    next.text[p] === '\n' &&
    next.text.startsWith(text.substring(0, p)) &&
    next.text.endsWith(text.substring(p));
  if (!typedNewline) return null;
  const start = lineStart(text, p);
  const end = lineEnd(text, p);
  const marker = parseMarker(text.substring(start, end));
  if (!marker) return null;
  if (p < start + prefixLength(marker)) return null;
  if (insideCodeFence(text, start)) return null;
  const content = text.substring(start + prefixLength(marker), end);
  if (content.trim() === '') return editorText(text.substring(0, start) + text.substring(end), start);
  const insert = `\n${marker.indent}${nextMarker(marker)}`;
  return editorText(text.substring(0, p) + insert + text.substring(p), p + insert.length);
}

/** Convenience for the editor: the edit for pressing Enter at a collapsed cursor, if a list continues. */
export function continueListOnEnter(value: EditorText): EditorText | null {
  const p = value.selectionStart;
  const next = editorText(`${value.text.substring(0, p)}\n${value.text.substring(p)}`, p + 1);
  return continueList(value, next);
}
