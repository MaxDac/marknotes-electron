/**
 * Converts imported content to the body of a new note, either formatted as Markdown or kept as plain text, and
 * suggests a title. Mirrors Android's `core/importing/ImportConverter.kt`.
 */
import { docxToMarkdown, docxToPlainText } from './docxToMarkdown';
import { htmlToMarkdown, htmlToPlainText } from './htmlToMarkdown';
import { NO_IMAGES, type ImageSink } from './importError';
import { isBlank, tidy } from './markdownText';
import { normalizeText, plainTextToMarkdown } from './plainTextToMarkdown';

/** What is imported, before conversion. */
export type ImportSource =
  /** Plain text; `reflow` joins wrapped lines (text extracted from PDFs). */
  | { kind: 'text'; text: string; reflow?: boolean }
  /** Rich text; `text` is the plain-text version shared alongside, used when keeping it as is. */
  | { kind: 'html'; html: string; text?: string | null }
  /** A Markdown file: kept as it is. */
  | { kind: 'markdown'; text: string }
  /** A Word document (`.docx`). */
  | { kind: 'docx'; bytes: Uint8Array };

export const DEFAULT_TITLE = 'Imported note';
const MAX_TITLE = 80;
const MAX_FIRST_LINE = 60;
const HEADING = /^#{1,6}\s+(.+)$/m;
const LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const AUTOLINK = /<([^>]+)>/g;
const LINE_PREFIX = /^(#{1,6}|>|[-*+]|\d+[.)])\s+/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[/\\:*?"<>|\x00-\x1F\x7F]/g;
const SPACES = /[ \t\n\v\f\r]+/g;

export async function convertImport(
  source: ImportSource,
  autoFormat: boolean,
  images: ImageSink = NO_IMAGES,
): Promise<string> {
  switch (source.kind) {
    case 'text':
      return autoFormat
        ? plainTextToMarkdown(source.text, source.reflow ?? false)
        : tidy(normalizeText(source.text));
    case 'html':
      if (autoFormat) return htmlToMarkdown(source.html);
      return source.text != null && !isBlank(source.text)
        ? tidy(normalizeText(source.text))
        : htmlToPlainText(source.html);
    case 'markdown':
      return tidy(normalizeText(source.text));
    case 'docx':
      return autoFormat ? docxToMarkdown(source.bytes, images) : docxToPlainText(source.bytes);
  }
}

/**
 * A note name for imported content: the `subject`, else the first heading of `body`, else the `fileName` without
 * extension, else the first line of `body`; cleaned up so it is a valid, portable name.
 */
export function suggestTitle(body: string, fileName?: string | null, subject?: string | null): string {
  const heading = HEADING.exec(body)?.[1];
  const firstLine = body
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('!['));
  const candidates = [
    subject,
    heading === undefined ? undefined : stripMarkdown(heading),
    fileName == null ? undefined : withoutExtension(fileName),
    firstLine === undefined ? undefined : shorten(stripMarkdown(firstLine)),
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const name = sanitizeTitle(candidate);
    if (name !== '') return name;
  }
  return DEFAULT_TITLE;
}

/** Makes `name` a valid note name on every platform the notes sync to. */
export function sanitizeTitle(name: string): string {
  const cleaned = name.replace(FORBIDDEN, ' ').replace(SPACES, ' ').trim().replace(/^\.+/, '').trim();
  const stripped = cleaned.toLowerCase().endsWith('.md') ? cleaned.slice(0, -3).trim() : cleaned;
  return stripped.substring(0, MAX_TITLE).replace(/[. ]+$/, '');
}

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  const base = dot < 0 ? name : name.substring(0, dot);
  return isBlank(base) ? name : base;
}

function stripMarkdown(text: string): string {
  return text
    .replace(LINK, '$1')
    .replace(AUTOLINK, '$1')
    .replace(LINE_PREFIX, '')
    .replace(/[*_`~]/g, '')
    .replaceAll('\\', '');
}

function shorten(text: string): string {
  if (text.length <= MAX_FIRST_LINE) return text;
  const cut = text.substring(0, MAX_FIRST_LINE);
  const space = cut.lastIndexOf(' ');
  return space > MAX_FIRST_LINE / 2 ? cut.substring(0, space) : cut;
}
