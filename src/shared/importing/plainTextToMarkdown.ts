/**
 * Turns plain text (copied text, `.txt` files, text extracted from PDFs) into Markdown with heuristics: bullets and
 * numbered lines become lists, standalone title-like lines become headings, indented blocks become code, bare web
 * addresses become links and hard-wrapped paragraphs are re-joined. Text that already looks like Markdown is kept as
 * it is. Mirrors Android's `core/importing/PlainTextToMarkdown.kt`.
 */
import {
  BlockBuilder,
  escapeInline,
  escapeLineStart,
  fence,
  isBlank,
  isLetter,
  isLowerCase,
  isUpperCase,
  link,
  tidy,
} from './markdownText';

const LIST_INDENT = '    ';
const MAX_LIST_LEVEL = 5;
const MAX_HEADING = 6;
const MAX_HEADING_LENGTH = 70;
const MAX_HEADING_WORDS = 10;
const MIN_CAPS_LETTERS = 3;
const SIGNIFICANT_WORD = 4;
const MIN_SETEXT = 3;
const MIN_WRAPPED_LINES = 3;
const MIN_WRAP_WIDTH = 30;
const MAX_WRAP_WIDTH = 140;
const WRAP_LENGTH_RATIO = 0.6;
const WRAP_SHARE = 0.75;

const BULLET = /^( *)([-*+•·◦▪▫‣⁃●○■□►▶✓✔–—])\s+(\S.*)$/u;
const ORDERED = /^( *)(\d{1,3})[.)]\s+(\S.*)$/u;
const TASK = /^( *)(?:[-*•]\s+)?([☐☑☒✅]|\[[ xX]\])\s+(\S.*)$/u;
const SECTION_NUMBER = /^(\d+(?:\.\d+)+)\.?\s+\S/u;
const URL = /\b(?:https?:\/\/|www\.)[^\s<>"]+/giu;
const HAS_URL = new RegExp(URL.source, 'iu');
const MARKDOWN_SIGNALS = [
  /^#{1,6} \S/m,
  /^(```|~~~)/m,
  /\[[^\]\n]+\]\([^)\s]+\)/,
  /\*\*[^*\n]+\*\*/,
  /^\s*[-*] \[[ xX]\] /m,
  /^\|?\s*:?-{3,}:?\s*\|/m,
];

type Segment =
  | { kind: 'paragraph'; lines: string[]; standalone: boolean }
  | { kind: 'item'; level: number; marker: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; text: string };

interface ListLine {
  indent: number;
  marker: string;
  text: string;
}

/**
 * Converts `text`. With `reflow` the lines of a paragraph are always joined (PDF text is wrapped at the page width);
 * otherwise they are joined only when the text looks hard-wrapped, and kept as separate paragraphs when it doesn't.
 */
export function plainTextToMarkdown(text: string, reflow = false): string {
  const normalized = normalizeText(text);
  if (looksLikeMarkdown(normalized)) return tidy(normalized);
  const lines = normalized.split('\n').map((l) => expandTabs(l).trimEnd());
  const blocks = splitBlocks(lines);
  const wrapped = reflow || isHardWrapped(blocks);
  const levels = listIndentLevels(lines);
  const all = blocks.flatMap((b) => segments(b, wrapped, levels));
  return tidy(render(all));
}

/** Line endings, non-breaking and zero-width spaces and the byte order mark normalised. */
export function normalizeText(text: string): string {
  return (text.startsWith('\uFEFF') ? text.substring(1) : text)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replaceAll('\u00A0', ' ')
    .replaceAll('\u200B', '')
    .replaceAll('\u2028', '\n')
    .replaceAll('\u2029', '\n');
}

/** True when `text` already uses Markdown syntax (headings, fences, links, emphasis, tables, task lists). */
export function looksLikeMarkdown(text: string): boolean {
  return MARKDOWN_SIGNALS.some((r) => r.test(text));
}

function splitBlocks(lines: string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (isBlank(line)) {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

/** Wrapped text has many non-final paragraph lines of similar length that don't end a sentence. */
function isHardWrapped(blocks: string[][]): boolean {
  const inner = blocks
    .filter((b) => b.length >= 2)
    .flatMap((b) => b.slice(0, -1))
    .filter((l) => listItem(l) === null);
  if (inner.length < MIN_WRAPPED_LINES) return false;
  const longest = Math.max(...inner.map((l) => l.length));
  if (longest < MIN_WRAP_WIDTH || longest > MAX_WRAP_WIDTH) return false;
  const similar = inner.filter((l) => l.length >= longest * WRAP_LENGTH_RATIO).length;
  const open = inner.filter((l) => !l.trimEnd().endsWith('.') && !l.trimEnd().endsWith(':')).length;
  return similar >= inner.length * WRAP_SHARE && open >= inner.length * WRAP_SHARE;
}

function listIndentLevels(lines: string[]): Map<number, number> {
  const indents = [
    ...new Set(lines.map((l) => listItem(l)?.indent).filter((i): i is number => i !== undefined)),
  ].sort((a, b) => a - b);
  return new Map(indents.map((indent, index) => [indent, Math.min(index, MAX_LIST_LEVEL)]));
}

function listItem(line: string): ListLine | null {
  const task = TASK.exec(line);
  if (task) {
    const box = task[2];
    const done = box === '☑' || box === '☒' || box === '✅' || box.toLowerCase().includes('x');
    return { indent: task[1].length, marker: done ? '- [x] ' : '- [ ] ', text: task[3] };
  }
  const bullet = BULLET.exec(line);
  if (bullet) return { indent: bullet[1].length, marker: '- ', text: bullet[3] };
  const ordered = ORDERED.exec(line);
  if (ordered)
    return { indent: ordered[1].length, marker: `${parseInt(ordered[2], 10)}. `, text: ordered[3] };
  return null;
}

function segments(block: string[], wrapped: boolean, levels: Map<number, number>): Segment[] {
  const single = whole(block);
  if (single) return [single];
  const result: Segment[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) result.push({ kind: 'paragraph', lines: paragraph, standalone: false });
    paragraph = [];
  };
  for (const line of block) {
    const item = listItem(line);
    const last = result.at(-1);
    if (item !== null) {
      flush();
      result.push({
        kind: 'item',
        level: levels.get(item.indent) ?? 0,
        marker: item.marker,
        text: item.text.trim(),
      });
    } else if (last?.kind === 'item' && paragraph.length === 0 && (wrapped || line.startsWith(' '))) {
      result[result.length - 1] = { ...last, text: joinWrapped([last.text, line.trim()]) };
    } else if (wrapped) {
      paragraph.push(line.trim());
    } else {
      flush();
      paragraph.push(line.trim());
      flush();
    }
  }
  flush();
  if (result.length === 1) {
    const only = result[0];
    if (only.kind === 'paragraph' && only.lines.length === 1) return [{ ...only, standalone: true }];
  }
  return result;
}

/** A block that is a single segment as a whole: an indented code block or a setext heading. */
function whole(block: string[]): Segment | null {
  if (
    block.length >= 2 &&
    block.every((l) => l.startsWith('    ')) &&
    block.every((l) => listItem(l) === null)
  ) {
    const indent = Math.min(...block.map((l) => /^ */.exec(l)![0].length));
    return { kind: 'code', text: block.map((l) => l.substring(indent)).join('\n') };
  }
  if (block.length !== 2 || listItem(block[0]) !== null) return null;
  const underline = block[1].trim();
  if (underline.length < MIN_SETEXT) return null;
  if (/^=+$/.test(underline)) return { kind: 'heading', level: 1, text: block[0].trim() };
  if (/^-+$/.test(underline)) return { kind: 'heading', level: 2, text: block[0].trim() };
  return null;
}

function render(all: Segment[]): string {
  const out = new BlockBuilder();
  all.forEach((segment, index) => {
    switch (segment.kind) {
      case 'heading':
        out.block(`${'#'.repeat(segment.level)} ${inline(segment.text)}`);
        break;
      case 'code':
        out.block(fence(segment.text));
        break;
      case 'item':
        out.item(LIST_INDENT.repeat(segment.level) + segment.marker + inline(segment.text));
        break;
      case 'paragraph': {
        const text = joinWrapped(segment.lines);
        const level = headingLevel(segment, index, all);
        if (level !== null) out.block(`${'#'.repeat(level)} ${inline(text.replace(/:+$/, ''))}`);
        else out.block(escapeLineStart(inline(text)));
        break;
      }
    }
  });
  return out.toString();
}

/** A standalone short line that reads like a title and introduces more content becomes a heading. */
function headingLevel(
  segment: Extract<Segment, { kind: 'paragraph' }>,
  index: number,
  all: Segment[],
): number | null {
  if (!segment.standalone) return null;
  const line = segment.lines[0];
  const next = all[index + 1];
  if (next === undefined) return null;
  const introduces =
    next.kind === 'paragraph'
      ? joinWrapped(next.lines).length > line.length
      : next.kind === 'item' || next.kind === 'code';
  if (!introduces || !isTitleLike(line)) return null;
  const section = SECTION_NUMBER.exec(line);
  if (section) return Math.min(section[1].split('.').length - 1 + 2, MAX_HEADING);
  return index === 0 ? 1 : 2;
}

function isTitleLike(line: string): boolean {
  const words = line.split(' ').filter((w) => w !== '');
  const letters = [...line].filter(isLetter);
  const plausible =
    line.length <= MAX_HEADING_LENGTH &&
    words.length <= MAX_HEADING_WORDS &&
    letters.length > 0 &&
    !'.,;!?'.includes(line[line.length - 1]) &&
    !HAS_URL.test(line);
  if (!plausible) return false;
  if (SECTION_NUMBER.test(line)) return true;
  if (letters.length >= MIN_CAPS_LETTERS && !letters.some(isLowerCase)) return true;
  const significant = words.filter((w) => [...w].filter(isLetter).length >= SIGNIFICANT_WORD);
  return (
    isUpperCase(line[0]) &&
    significant.length > 0 &&
    significant.every((w) => isUpperCase([...w].find(isLetter)))
  );
}

function joinWrapped(lines: string[]): string {
  return lines.reduce((acc, line) => {
    const hyphenated = acc.length >= 2 && acc.endsWith('-') && isLetter(acc[acc.length - 2]);
    return hyphenated && isLowerCase(line[0]) ? acc.slice(0, -1) + line : `${acc} ${line}`;
  });
}

/** Escapes Markdown characters and turns bare web addresses into links. */
function inline(text: string): string {
  let out = '';
  let last = 0;
  for (const match of text.matchAll(URL)) {
    const start = match.index;
    const url = trimUrl(match[0]);
    out += escapeInline(text.substring(last, start));
    out += url.toLowerCase().startsWith('www.') ? link(escapeInline(url), `https://${url}`) : `<${url}>`;
    last = start + url.length;
  }
  return out + escapeInline(text.substring(last));
}

/** Drops trailing punctuation from a matched address, keeping closing brackets that are balanced. */
function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const c = url[end - 1];
    const prefix = url.substring(0, end);
    const unbalanced = c === ')' && count(prefix, '(') < count(prefix, ')');
    if ('.,;:!?\'"'.includes(c) || unbalanced) end--;
    else break;
  }
  return url.substring(0, end);
}

const count = (text: string, c: string) => text.split(c).length - 1;

function expandTabs(line: string): string {
  const indent = /^[ \t]*/.exec(line)![0];
  return indent.replaceAll('\t', '    ') + line.substring(indent.length);
}
