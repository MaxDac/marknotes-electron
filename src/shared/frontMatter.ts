/**
 * YAML front-matter at the very top of a note, used to store the stable note id:
 *
 *     ---
 *     id: k7f3q2xa
 *     ---
 *
 * Only the `id` key is interpreted; every other line is preserved verbatim. See spec/note-format.md.
 */

/** Crockford base32, lowercase, without i, l, o and u. */
export const NOTE_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const NOTE_ID_LENGTH = 8;
const ID_PATTERN = new RegExp(`^[${NOTE_ID_ALPHABET}]{${NOTE_ID_LENGTH}}$`);

export function isNoteId(value: string): boolean {
  return ID_PATTERN.test(value);
}

/** A random 8-character note id. */
export function generateNoteId(random: (bytes: Uint8Array) => Uint8Array = defaultRandom): string {
  const bytes = random(new Uint8Array(NOTE_ID_LENGTH));
  let id = '';
  // 256 is a multiple of 32, so masking keeps the distribution uniform.
  for (const b of bytes) id += NOTE_ID_ALPHABET[b & 31];
  return id;
}

const defaultRandom = (bytes: Uint8Array): Uint8Array => {
  globalThis.crypto.getRandomValues(bytes as Uint8Array<ArrayBuffer>);
  return bytes;
};

export interface SplitNote {
  /** The front-matter block including both `---` lines and the newline after the closing one; '' if none. */
  frontMatter: string;
  /** The note text after the front-matter, as edited by the user. */
  body: string;
  /** The `id` value, when present and valid. */
  id: string | null;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*(\r?\n|$)/m;
const ID_LINE = /^id:[ \t]*["']?([^"'\r\n]*?)["']?[ \t]*$/m;

/** Splits a note into its front-matter block and body. */
export function splitFrontMatter(text: string): SplitNote {
  const open = OPEN.exec(text);
  if (!open) return { frontMatter: '', body: text, id: null };
  const rest = text.substring(open[0].length);
  const close = CLOSE.exec(rest);
  if (!close) return { frontMatter: '', body: text, id: null };
  const end = open[0].length + close.index + close[0].length;
  const inner = rest.substring(0, close.index);
  const idMatch = ID_LINE.exec(inner);
  const id = idMatch && isNoteId(idMatch[1].trim()) ? idMatch[1].trim() : null;
  return { frontMatter: text.substring(0, end), body: text.substring(end), id };
}

/** The note id stored in `text`, or null. */
export function noteIdOf(text: string): string | null {
  return splitFrontMatter(text).id;
}

/** Returns `text` with its front-matter `id` set to `id`, preserving every other key and the body. */
export function withNoteId(text: string, id: string): string {
  const split = splitFrontMatter(text);
  if (!split.frontMatter) return `---\nid: ${id}\n---\n${text}`;
  const fm = split.frontMatter;
  const openEnd = OPEN.exec(fm)![0].length;
  const closeStart = CLOSE.exec(fm.substring(openEnd))!.index + openEnd;
  const inner = fm.substring(openEnd, closeStart);
  const newline = fm.includes('\r\n') ? '\r\n' : '\n';
  const nextInner = ID_LINE.test(inner) ? inner.replace(ID_LINE, `id: ${id}`) : `id: ${id}${newline}${inner}`;
  return fm.substring(0, openEnd) + nextInner + fm.substring(closeStart) + split.body;
}

/**
 * Re-attaches a front-matter block (as returned by splitFrontMatter) to an edited body. A block without a final line
 * break gets one before a non-empty body: CRLF when its opening `---` line ends with CRLF, LF otherwise.
 */
export function joinFrontMatter(frontMatter: string, body: string): string {
  if (frontMatter === '' || body === '' || frontMatter.endsWith('\n')) return frontMatter + body;
  return frontMatter + (/^---[ \t]*\r\n/.test(frontMatter) ? '\r\n' : '\n') + body;
}

/** Content of a brand-new note with a fresh id. */
export function newNoteContent(id = generateNoteId()): string {
  return `---\nid: ${id}\n---\n`;
}
