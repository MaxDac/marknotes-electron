/**
 * Small helpers to emit Markdown from imported content.
 * Mirrors Android's `core/importing/MarkdownText.kt`.
 */

/** Hard line break inside a paragraph (CommonMark backslash form, visible and not trimmed by editors). */
export const HARD_BREAK = '\\\n';

const headingStart = /^(#{1,6})(\s|$)/;
const orderedStart = /^(\d{1,9})([.)])(\s|$)/;
const bulletStart = /^([-+])(\s|$)/;
const thematicOrSetext = /^([-=_])\1*\s*$/;
const blankLines = /\n{3,}/g;

export const isBlank = (text: string): boolean => text.trim() === '';
export const isLetter = (c: string | undefined): boolean => c !== undefined && /^\p{L}$/u.test(c);
export const isUpperCase = (c: string | undefined): boolean => c !== undefined && /^\p{Lu}$/u.test(c);
export const isLowerCase = (c: string | undefined): boolean => c !== undefined && /^\p{Ll}$/u.test(c);
export const isLetterOrDigit = (c: string | undefined): boolean =>
  c !== undefined && /^[\p{L}\p{Nd}]$/u.test(c);

/** Escapes characters that would otherwise start inline Markdown constructs. */
export function escapeInline(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    switch (c) {
      case '\\':
      case '`':
      case '*':
      case '[':
      case ']':
      case '<':
        out += `\\${c}`;
        break;
      case '_':
        // Intraword underscores (snake_case) can't start emphasis, so they are left alone.
        out += isLetterOrDigit(text[i - 1]) && isLetterOrDigit(text[i + 1]) ? c : '\\_';
        break;
      default:
        out += c;
    }
  }
  return out;
}

/** Escapes a line start that would otherwise be read as a heading, quote, list item or rule. */
export function escapeLineStart(line: string): string {
  if (line.startsWith('>')) return `\\${line}`;
  if (headingStart.test(line)) return `\\${line}`;
  if (bulletStart.test(line)) return `\\${line}`;
  if (thematicOrSetext.test(line)) return `\\${line}`;
  const m = orderedStart.exec(line);
  if (!m) return line;
  const number = m[1];
  return `${number}\\${line.substring(number.length)}`;
}

/** Wraps `text` in an emphasis `marker`, keeping surrounding whitespace outside the markers. */
export function wrap(text: string, marker: string): string {
  if (isBlank(text)) return text;
  const lead = /^\s*/.exec(text)![0];
  const trail = /\s*$/.exec(text)![0];
  const core = text.substring(lead.length, text.length - trail.length);
  return lead + marker + core + marker + trail;
}

/** Inline code span for `code`, using a backtick run longer than any inside it. */
export function codeSpan(code: string): string {
  const text = code.replaceAll('\n', ' ');
  if (isBlank(text)) return text;
  const ticks = '`'.repeat(longestRun(text, '`') + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${text}${pad}${ticks}`;
}

/** Fenced code block for `code`, with an optional `language` info string. */
export function fence(code: string, language = ''): string {
  const marker = '`'.repeat(Math.max(3, longestRun(code, '`') + 1));
  return `${marker}${language}\n${code.replace(/\n+$/, '')}\n${marker}`;
}

/** Link destination usable in `[text](url)`: spaces and parentheses are percent-encoded. */
export function destination(url: string): string {
  return url.trim().replaceAll(' ', '%20').replaceAll('(', '%28').replaceAll(')', '%29');
}

export function link(text: string, url: string): string {
  const label = text.trim() || escapeInline(url);
  return `[${label}](${destination(url)})`;
}

/** A GitHub-flavoured table; the first row is the header. Cells must already be inline Markdown. */
export function table(rows: string[][]): string {
  const columns = Math.max(...rows.map((r) => r.length));
  const cell = (text: string) =>
    text.replaceAll(HARD_BREAK, ' ').replaceAll('\n', ' ').replaceAll('|', '\\|').trim();
  const line = (row: string[]) =>
    `| ${Array.from({ length: columns }, (_, i) => cell(row[i] ?? '')).join(' | ')} |`;
  const separator = `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
  return [line(rows[0]), separator, ...rows.slice(1).map(line)].join('\n');
}

/** Prefixes every non-empty line after the first with `indent` (list item continuation). */
export function indentContinuation(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 || line === '' ? line : indent + line))
    .join('\n');
}

/** Final clean-up: no trailing spaces, at most one blank line in a row, single trailing newline. */
export function tidy(text: string): string {
  const joined = text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(blankLines, '\n\n')
    .replace(/^\n+|\n+$/g, '');
  return joined === '' ? '' : `${joined}\n`;
}

function longestRun(text: string, c: string): number {
  let best = 0;
  let current = 0;
  for (const ch of text) {
    current = ch === c ? current + 1 : 0;
    best = Math.max(best, current);
  }
  return best;
}

/** Markdown blocks being assembled: list items are kept tight, other blocks are separated by a blank line. */
export class BlockBuilder {
  private out = '';
  private lastWasItem = false;

  block(text: string): void {
    if (isBlank(text)) return;
    this.separate(true);
    this.out += text.trimEnd();
    this.lastWasItem = false;
  }

  item(text: string): void {
    if (isBlank(text)) return;
    this.separate(!this.lastWasItem);
    this.out += text.trimEnd();
    this.lastWasItem = true;
  }

  private separate(blank: boolean): void {
    if (this.out === '') return;
    this.out += blank ? '\n\n' : '\n';
  }

  toString(): string {
    return this.out;
  }
}
