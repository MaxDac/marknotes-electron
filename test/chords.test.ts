import { describe, expect, it } from 'vitest';
import {
  type Chord,
  type ChordSequence,
  chordDisplayNames,
  emptyChord,
  isChordSequence,
  lineEndingOf,
  newChordSequenceContent,
  parseChordBody,
  parseChordNote,
  serializeChordBody,
  validateChord,
  validateChordSequence,
} from '../src/shared/chords';

const cMajor: Chord = {
  instrument: 'guitar',
  baseName: 'C',
  strings: [
    { state: 'muted' },
    { state: 'fretted', fret: 3, finger: 3 },
    { state: 'fretted', fret: 2, finger: 2 },
    { state: 'open' },
    { state: 'fretted', fret: 1, finger: 1 },
    { state: 'open' },
  ],
  tags: ['open', 'major'],
  note: 'First position.\n\nStrum from the A string.',
};

const bassRoot: Chord = {
  instrument: 'bass',
  baseName: 'C',
  strings: [
    { state: 'muted' },
    { state: 'fretted', fret: 3, finger: 2 },
    { state: 'open' },
    { state: 'open' },
  ],
  tags: [],
  note: '',
};

describe('chord sequences', () => {
  it('round-trips a sequence through serialise and parse', () => {
    const sequence: ChordSequence = { title: 'Song', chords: [cMajor, bassRoot, { ...cMajor, note: '' }] };
    const body = serializeChordBody(sequence);
    expect(body).toBe(
      '# Song\n\n## C (guitar)\nfrets: x 3/3 2/2 0 1/1 0\ntags: open, major\n\nFirst position.\n\nStrum from the A string.\n\n' +
        '## C (bass)\nfrets: x 3/2 0 0\n\n## C (guitar)\nfrets: x 3/3 2/2 0 1/1 0\ntags: open, major\n',
    );
    expect(parseChordBody(body)).toEqual({ sequence, error: null });
  });

  it('writes CRLF only when the front-matter fence uses CRLF', () => {
    expect(lineEndingOf('---\r\nid: a\r\n---\r\n')).toBe('\r\n');
    expect(lineEndingOf('---\nid: a\n---\n')).toBe('\n');
    expect(serializeChordBody({ title: null, chords: [bassRoot] }, '\r\n')).toBe(
      '## C (bass)\r\nfrets: x 3/2 0 0\r\n',
    );
    expect(serializeChordBody({ title: null, chords: [] })).toBe('');
  });

  it('parses a whole note and reports errors with line numbers', () => {
    const note = parseChordNote('---\nid: abc\ntype: chords\n---\n# T\n\n## G (guitar)\nfrets: 3/22 x\n');
    expect(note.lineEnding).toBe('\n');
    expect(note.result.error).toEqual({ line: 4, message: 'Invalid string "3/22".' });
    expect(parseChordBody('<<<<<<< ours\n').error).toEqual({ line: 1, message: 'Expected a chord heading.' });
  });

  it('detects the type from the first type line of the front-matter', () => {
    expect(isChordSequence(newChordSequenceContent('abcdefgh'))).toBe(true);
    expect(newChordSequenceContent('abcdefgh')).toBe('---\nid: abcdefgh\ntype: chords\n---\n');
    expect(isChordSequence('---\ntype: "chords"\n---\n')).toBe(true);
    expect(isChordSequence('---\ntype: Chords\n---\n')).toBe(false);
    expect(isChordSequence('---\nid: a\n---\ntype: chords\n')).toBe(false);
    expect(isChordSequence('# plain note\n')).toBe(false);
  });

  it('validates chords like ChordBuilder', () => {
    expect(validateChord(emptyChord('bass'))).toEqual([
      'Enter a chord name.',
      'Select at least three non-muted strings.',
    ]);
    expect(validateChord(cMajor)).toEqual([]);
    expect(
      validateChordSequence({ title: 'a\nb', chords: [cMajor, { ...cMajor, note: '## nope' }] }),
    ).toEqual([
      { chord: null, message: 'Title must be a single line.' },
      { chord: 1, message: 'Note lines cannot start with "## ".' },
    ]);
  });

  it('numbers display names per instrument and case-insensitive name', () => {
    expect(
      chordDisplayNames([
        { instrument: 'guitar', baseName: 'Am' },
        { instrument: 'bass', baseName: 'Am' },
        { instrument: 'guitar', baseName: 'am' },
      ]),
    ).toEqual(['1 Am', '1 Am', '2 am']);
  });
});
