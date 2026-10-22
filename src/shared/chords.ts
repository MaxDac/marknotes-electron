/**
 * Chord sequences: notes with `type: chords` in their front-matter whose body lists guitar and bass chord shapes.
 * See spec/note-format.md, "Chord sequences".
 */
import { generateNoteId, splitFrontMatter } from './frontMatter';

export const INSTRUMENTS = ['guitar', 'bass'] as const;
export type Instrument = (typeof INSTRUMENTS)[number];

/** Open-string tuning per instrument, lowest string first. */
export const TUNINGS: Record<Instrument, readonly string[]> = {
  guitar: ['E2', 'A2', 'D3', 'G3', 'B3', 'E4'],
  bass: ['E1', 'A1', 'D2', 'G2'],
};

export const MIN_FRET = 1;
export const MAX_FRET = 24;
export const MAX_FINGER = 4;
export const MAX_NAME_LENGTH = 80;
export const MAX_NOTE_LENGTH = 1000;
export const MAX_TAGS = 50;
export const MAX_TAG_LENGTH = 80;

export type StringSelection =
  { state: 'muted' } | { state: 'open' } | { state: 'fretted'; fret: number; finger: number };

export interface Chord {
  instrument: Instrument;
  baseName: string;
  strings: StringSelection[];
  tags: string[];
  note: string;
}

export interface ChordSequence {
  title: string | null;
  chords: Chord[];
}

export interface ChordParseError {
  /** 1-based line number in the body. */
  line: number;
  message: string;
}

export type ChordParseResult =
  { sequence: ChordSequence; error: null } | { sequence: null; error: ChordParseError };

export interface ChordValidationError {
  /** 0-based chord index, or null for the title. */
  chord: number | null;
  message: string;
}

// Whitespace is ASCII only (U+0009 to U+000D and U+0020).
const WS = '\\t-\\r ';
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, 'g');
const WS_RUN = new RegExp(`[${WS}]+`, 'g');
const BLANK = new RegExp(`^[${WS}]*$`);

export function trimAscii(text: string): string {
  return text.replace(TRIM, '');
}

const codePoints = (text: string): number => [...text].length;

export function normalizeTitle(title: string | null): string | null {
  if (title === null) return null;
  const trimmed = trimAscii(title);
  return trimmed === '' ? null : trimmed;
}

export function normalizeBaseName(name: string): string {
  return trimAscii(name).replace(WS_RUN, ' ');
}

export function normalizeNote(note: string): string {
  return trimAscii(note.replace(/\r\n/g, '\n'));
}

export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = trimAscii(raw);
    const key = tag.toLowerCase();
    if (tag && !seen.has(key)) {
      seen.add(key);
      result.push(tag);
    }
  }
  return result;
}

export function normalizeChord(chord: Chord): Chord {
  return {
    instrument: chord.instrument,
    baseName: normalizeBaseName(chord.baseName),
    strings: chord.strings.map((s) => ({ ...s })),
    tags: normalizeTags(chord.tags),
    note: normalizeNote(chord.note),
  };
}

export function normalizeSequence(sequence: ChordSequence): ChordSequence {
  return { title: normalizeTitle(sequence.title), chords: sequence.chords.map(normalizeChord) };
}

/** Lines of the front-matter block between the fences, each without its line ending. */
function frontMatterLines(frontMatter: string): string[] {
  const lines = frontMatter.split('\n').map((l) => l.replace(/\r$/, ''));
  // Drop the opening fence, the closing fence and the empty string after the final newline.
  const close = lines.findIndex((l, i) => i > 0 && /^---[ \t]*$/.test(l));
  return lines.slice(1, close < 0 ? lines.length : close);
}

/** True when the note's front-matter has `type: chords`. */
export function isChordSequence(text: string): boolean {
  const { frontMatter } = splitFrontMatter(text);
  if (!frontMatter) return false;
  for (const line of frontMatterLines(frontMatter)) {
    const m = /^type:[ \t](.*)$/.exec(line);
    if (!m) continue;
    let value = trimAscii(m[1]);
    const q = /^(["'])(.*)\1$/s.exec(value);
    if (q) value = q[2];
    return value === 'chords';
  }
  return false;
}

/** Content of a brand-new, empty chord sequence. */
export function newChordSequenceContent(id = generateNoteId()): string {
  return `---\nid: ${id}\ntype: chords\n---\n`;
}

/** The line ending used by a note: CRLF when its front-matter opening fence ends with CRLF. */
export function lineEndingOf(frontMatter: string): '\n' | '\r\n' {
  return /^---[ \t]*\r\n/.test(frontMatter) ? '\r\n' : '\n';
}

const HEADING = /^(.*)\((guitar|bass)\)[ \t]*$/s;
const TOKEN = /^(?:(x)|(0)|([0-9]{1,2})\/([0-9]))$/;

const isHeading = (line: string): boolean => line.startsWith('## ');

/** Parses a chord-sequence body (the text after the front-matter). */
export function parseChordBody(body: string): ChordParseResult {
  const lines = body.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  const fail = (index: number, message: string): ChordParseResult => ({
    sequence: null,
    error: { line: index + 1, message },
  });
  const blank = (line: string) => BLANK.test(line);
  const nextNonBlank = (from: number): number => {
    let i = from;
    while (i < lines.length && blank(lines[i])) i++;
    return i;
  };

  let title: string | null = null;
  let i = nextNonBlank(0);
  if (i < lines.length && lines[i].startsWith('# ')) {
    title = normalizeTitle(lines[i].substring(2));
    i = nextNonBlank(i + 1);
  }

  const chords: Chord[] = [];
  while (i < lines.length) {
    const heading = lines[i];
    if (!isHeading(heading)) return fail(i, 'Expected a chord heading.');
    const h = HEADING.exec(heading.substring(3));
    if (!h) return fail(i, 'Invalid chord heading.');
    const headingIndex = i;

    i = nextNonBlank(i + 1);
    if (i >= lines.length || !lines[i].startsWith('frets:'))
      return fail(headingIndex, 'Chord has no frets line.');
    const strings: StringSelection[] = [];
    for (const token of lines[i].substring(6).split(/[ \t]+/)) {
      if (token === '') continue;
      const t = TOKEN.exec(token);
      if (!t) return fail(i, `Invalid string "${token}".`);
      if (t[1]) strings.push({ state: 'muted' });
      else if (t[2]) strings.push({ state: 'open' });
      else strings.push({ state: 'fretted', fret: Number(t[3]), finger: Number(t[4]) });
    }
    let noteStart = i + 1;

    let tags: string[] = [];
    const t = nextNonBlank(i + 1);
    if (t < lines.length && lines[t].startsWith('tags:')) {
      tags = normalizeTags(lines[t].substring(5).split(','));
      noteStart = t + 1;
    }

    let end = noteStart;
    while (end < lines.length && !isHeading(lines[end])) end++;
    chords.push({
      instrument: h[2] as Instrument,
      baseName: normalizeBaseName(h[1]),
      strings,
      tags,
      note: normalizeNote(lines.slice(noteStart, end).join('\n')),
    });
    i = end;
  }

  return { sequence: { title, chords }, error: null };
}

export function stringToken(s: StringSelection): string {
  if (s.state === 'muted') return 'x';
  if (s.state === 'open') return '0';
  return `${s.fret}/${s.finger}`;
}

/** The canonical body for a sequence. */
export function serializeChordBody(sequence: ChordSequence, lineEnding: '\n' | '\r\n' = '\n'): string {
  const { title, chords } = normalizeSequence(sequence);
  const out: string[] = [];
  if (title !== null) out.push(`# ${title}`);
  for (const chord of chords) {
    if (out.length > 0) out.push('');
    out.push(`## ${chord.baseName} (${chord.instrument})`);
    out.push('frets:' + chord.strings.map((s) => ' ' + stringToken(s)).join(''));
    if (chord.tags.length > 0) out.push(`tags: ${chord.tags.join(', ')}`);
    else if (chord.note.startsWith('tags:')) out.push('tags:');
    if (chord.note !== '') out.push('', ...chord.note.split('\n'));
  }
  return out.map((line) => line + lineEnding).join('');
}

/** Every validation error of a sequence, in spec order. An empty list means the sequence can be saved. */
export function validateChordSequence(sequence: ChordSequence): ChordValidationError[] {
  const { title, chords } = normalizeSequence(sequence);
  const errors: ChordValidationError[] = [];
  if (title !== null && /[\r\n]/.test(title))
    errors.push({ chord: null, message: 'Title must be a single line.' });
  chords.forEach((chord, index) => {
    for (const message of validateChord(chord)) errors.push({ chord: index, message });
  });
  return errors;
}

/** Validation messages of one (normalised) chord, in spec order. */
export function validateChord(input: Chord): string[] {
  const chord = normalizeChord(input);
  const messages: string[] = [];
  if (chord.baseName === '') messages.push('Enter a chord name.');
  if (codePoints(chord.baseName) > MAX_NAME_LENGTH)
    messages.push('Chord names must be at most 80 characters.');
  const count = TUNINGS[chord.instrument].length;
  if (chord.strings.length !== count) messages.push(`${chord.instrument} requires ${count} strings.`);
  if (chord.strings.filter((s) => s.state !== 'muted').length < 3) {
    messages.push('Select at least three non-muted strings.');
  }
  const fretted = chord.strings.filter((s) => s.state === 'fretted');
  if (fretted.some((s) => !(s.fret >= MIN_FRET && s.fret <= MAX_FRET))) {
    messages.push('Frets must be between 1 and 24.');
  }
  if (fretted.some((s) => !(s.finger >= 1 && s.finger <= MAX_FINGER))) {
    messages.push('Fingers must be between 1 and 4.');
  }
  if (codePoints(chord.note) > MAX_NOTE_LENGTH) messages.push('Notes must be at most 1000 characters.');
  if (chord.note.split('\n').some(isHeading)) messages.push('Note lines cannot start with "## ".');
  if (chord.tags.length > MAX_TAGS) messages.push('Use at most 50 tags.');
  if (chord.tags.some((tag) => codePoints(tag) > MAX_TAG_LENGTH)) {
    messages.push('Tags must be at most 80 characters.');
  }
  if (chord.tags.some((tag) => /[,\r\n]/.test(tag)))
    messages.push('Tags cannot contain commas or line breaks.');
  return messages;
}

/** `<n> <baseName>` per chord, numbering chords with the same instrument and lowercased name in order. */
export function chordDisplayNames(chords: readonly Pick<Chord, 'instrument' | 'baseName'>[]): string[] {
  const counts = new Map<string, number>();
  return chords.map((chord) => {
    const name = normalizeBaseName(chord.baseName);
    const key = `${chord.instrument}\u0000${name.toLowerCase()}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return `${n} ${name}`;
  });
}

/** All strings muted, for a new chord. */
export function emptyStrings(instrument: Instrument): StringSelection[] {
  return TUNINGS[instrument].map(() => ({ state: 'muted' as const }));
}

export function emptyChord(instrument: Instrument = 'guitar'): Chord {
  return { instrument, baseName: '', strings: emptyStrings(instrument), tags: [], note: '' };
}

/** Parses a whole chord-sequence note into its front-matter and sequence. */
export function parseChordNote(text: string): {
  frontMatter: string;
  body: string;
  result: ChordParseResult;
  lineEnding: '\n' | '\r\n';
} {
  const { frontMatter, body } = splitFrontMatter(text);
  return { frontMatter, body, result: parseChordBody(body), lineEnding: lineEndingOf(frontMatter) };
}
