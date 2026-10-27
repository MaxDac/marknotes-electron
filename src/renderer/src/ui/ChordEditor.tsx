import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './icons';
import {
  chordDisplayNames,
  emptyChord,
  isChordSequence,
  lineEndingOf,
  normalizeTitle,
  normalizeTags,
  parseChordBody,
  serializeChordBody,
  stringToken,
  validateChord,
  type Chord,
  type ChordParseError,
  type ChordSequence,
  type Instrument,
} from '../../../shared/chords';
import { splitFrontMatter } from '../../../shared/frontMatter';
import { ensureNoteId } from '../../../shared/noteLinks';
import * as P from '../../../shared/paths';
import { ConfirmDialog } from './Dialog';
import { Editor } from './Editor';
import { ChordPreview, Fretboard } from './Fretboard';
import { errorMessage, useApp } from './context';

interface Draft {
  /** Index of the chord being edited, or null for a new chord. */
  index: number | null;
  instrument: Instrument;
  baseName: string;
  tagText: string;
  note: string;
  strings: Chord['strings'];
}

const newDraft = (instrument: Instrument): Draft => {
  const c = emptyChord(instrument);
  return { index: null, instrument, baseName: '', tagText: '', note: '', strings: c.strings };
};

const chordToDraft = (chord: Chord, index: number): Draft => ({
  index,
  instrument: chord.instrument,
  baseName: chord.baseName,
  tagText: chord.tags.join(', '),
  note: chord.note,
  strings: chord.strings.map((s) => ({ ...s })),
});

const draftToChord = (d: Draft): Chord => ({
  instrument: d.instrument,
  baseName: d.baseName,
  strings: d.strings,
  tags: normalizeTags(d.tagText.split(',')),
  note: d.note,
});

/** Draft content without its position, so reordering does not make the draft dirty. */
const fingerprint = ({ index: _index, ...content }: Draft) => JSON.stringify(content);

type Analysis = { chords: false } | { chords: true; error: ChordParseError | null };

function analyse(text: string): Analysis {
  if (!isChordSequence(text)) return { chords: false };
  return { chords: true, error: parseChordBody(splitFrontMatter(text).body).error };
}

const describeError = (e: ChordParseError) => `Line ${e.line}: ${e.message}`;

/**
 * Opens a note in the right editor: chord sequences (`type: chords`) in the chord editor, everything else and chord
 * sequences that do not parse in the markdown editor.
 */
export function NoteEditor(props: { path: string; onClose(): void; onOpenNote(path: string): void }) {
  const { notes } = useApp();
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [asText, setAsText] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = () =>
      notes.read(props.path).then(
        (text) => !disposed && setAnalysis(analyse(text)),
        (e) => !disposed && setLoadError(errorMessage(e)),
      );
    void refresh();
    const unsubscribe = notes.onChange(() => void refresh());
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [notes, props.path]);

  if (loadError) {
    return (
      <section className="editor-pane" aria-label="Editor">
        <div className="status error">{loadError}</div>
      </section>
    );
  }
  if (analysis === null) return <section className="editor-pane" aria-label="Editor" />;

  if (analysis.chords && !asText && analysis.error === null) {
    return <ChordEditor path={props.path} onClose={props.onClose} onViewAsText={() => setAsText(true)} />;
  }

  if (!analysis.chords) return <Editor {...props} />;

  const parseError = analysis.error;
  return (
    <Editor
      {...props}
      headerExtra={
        <button
          data-testid="open-chord-editor"
          disabled={parseError !== null}
          title={parseError ? 'Fix the error to open the chord editor' : undefined}
          onClick={() => setAsText(false)}
        >
          Chord editor
        </button>
      }
      notice={
        parseError && (
          <div className="status error" role="alert" data-testid="chord-parse-error">
            This chord sequence cannot be shown in the chord editor. {describeError(parseError)}
          </div>
        )
      }
    />
  );
}

type Pending = { title: string; message: string; confirm: string; danger?: boolean; action(): void };

/** Graphical editor of a chord sequence, ported from MaxDac/ChordBuilder. */
export function ChordEditor(props: { path: string; onClose(): void; onViewAsText(): void }) {
  const { notes } = useApp();
  const [sequence, setSequence] = useState<ChordSequence | null>(null);
  const [draft, setDraft] = useState<Draft>(() => newDraft('guitar'));
  const baseline = useRef(fingerprint(newDraft('guitar')));
  const [titleText, setTitleText] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /** The note content last read or written, to ignore our own change notifications. */
  const lastText = useRef<string | null>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());

  const dirty = fingerprint(draft) !== baseline.current;
  const displayNames = useMemo(() => chordDisplayNames(sequence?.chords ?? []), [sequence]);

  const resetDraft = useCallback((instrument: Instrument) => {
    const next = newDraft(instrument);
    setDraft(next);
    baseline.current = fingerprint(next);
    setErrors([]);
  }, []);

  useEffect(() => {
    let disposed = false;
    const load = (initial: boolean) =>
      (initial ? ensureNoteId(notes, props.path).then((r) => r.text) : notes.read(props.path)).then(
        (text) => {
          if (disposed || text === lastText.current) return;
          lastText.current = text;
          const parsed = parseChordBody(splitFrontMatter(text).body);
          // The NoteEditor switches to the markdown editor when the note stops parsing.
          if (!parsed.sequence) return;
          setSequence(parsed.sequence);
          setTitleText(parsed.sequence.title ?? '');
          if (!initial) {
            setDraft((d) =>
              d.index !== null && d.index >= parsed.sequence.chords.length ? { ...d, index: null } : d,
            );
          }
        },
      );
    load(true).catch((e) => setError(errorMessage(e)));
    const unsubscribe = notes.onChange(() => void load(false).catch(() => undefined));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [notes, props.path]);

  const write = (next: ChordSequence, message?: string) => {
    setSequence(next);
    writes.current = writes.current
      .then(async () => {
        // Re-read the front-matter: the id may have changed meanwhile (duplicate ids).
        const { frontMatter } = splitFrontMatter(await notes.read(props.path));
        const text = frontMatter + serializeChordBody(next, lineEndingOf(frontMatter));
        lastText.current = text;
        await notes.write(props.path, text);
        if (message) setStatus(message);
      })
      .catch((e) => setError(errorMessage(e)));
  };

  const guard = (message: string, action: () => void) => {
    if (!dirty) action();
    else setPending({ title: 'Discard changes?', message, confirm: 'Discard', danger: true, action });
  };

  if (!sequence) {
    return (
      <section className="editor-pane" aria-label="Chord editor">
        {error && <div className="status error">{error}</div>}
      </section>
    );
  }

  const chords = sequence.chords;
  const editingName = draft.index !== null ? displayNames[draft.index] : null;

  const saveChord = () => {
    const chord = draftToChord(draft);
    const messages = validateChord(chord);
    setErrors(messages);
    if (messages.length > 0) return;
    const index = draft.index ?? chords.length;
    const nextChords = [...chords];
    nextChords.splice(index, draft.index === null ? 0 : 1, chord);
    const next = { ...sequence, chords: nextChords };
    write(next, `Saved ${chordDisplayNames(nextChords)[index]}`);
    const saved = chordToDraft(parseChordBody(serializeChordBody(next)).sequence!.chords[index], index);
    setDraft(saved);
    baseline.current = fingerprint(saved);
  };

  const editChord = (index: number) =>
    guard('Discard the unsaved changes to the current chord?', () => {
      const next = chordToDraft(chords[index], index);
      setDraft(next);
      baseline.current = fingerprint(next);
      setErrors([]);
      setStatus(`Editing ${displayNames[index]}`);
    });

  const duplicateChord = (index: number) => {
    const nextChords = [...chords];
    nextChords.splice(index + 1, 0, {
      ...chords[index],
      strings: chords[index].strings.map((s) => ({ ...s })),
    });
    if (draft.index !== null && draft.index > index) setDraft({ ...draft, index: draft.index + 1 });
    write({ ...sequence, chords: nextChords }, `Duplicated ${displayNames[index]}`);
  };

  const moveChord = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= chords.length) return;
    const nextChords = [...chords];
    [nextChords[index], nextChords[target]] = [nextChords[target], nextChords[index]];
    if (draft.index === index || draft.index === target) {
      setDraft({ ...draft, index: draft.index === index ? target : index });
    }
    write({ ...sequence, chords: nextChords });
  };

  const deleteChord = (index: number) =>
    setPending({
      title: 'Delete chord',
      message: `Delete ${displayNames[index]}?`,
      confirm: 'Delete',
      danger: true,
      action: () => {
        const nextChords = chords.filter((_, i) => i !== index);
        if (draft.index === index) resetDraft(draft.instrument);
        else if (draft.index !== null && draft.index > index) setDraft({ ...draft, index: draft.index - 1 });
        write({ ...sequence, chords: nextChords }, `Deleted ${displayNames[index]}`);
      },
    });

  const saveTitle = () => {
    const title = normalizeTitle(titleText);
    if (title === sequence.title) return;
    write({ ...sequence, title });
  };

  const switchInstrument = (instrument: Instrument) => {
    if (instrument === draft.instrument) return;
    guard('Switching instrument clears the current chord.', () => resetDraft(instrument));
  };

  return (
    <section className="editor-pane chord-editor" aria-label="Chord editor" data-testid="chord-editor">
      <div className="editor-header">
        <span className="title" data-testid="note-title">
          <Icon name="chords" /> {P.displayName(props.path)}
        </span>
        <button
          data-testid="view-as-text"
          onClick={() => guard('Discard the unsaved changes to the current chord?', props.onViewAsText)}
        >
          View as text
        </button>
        <button
          className="icon"
          aria-label="Close"
          onClick={() => guard('Discard the unsaved changes to the current chord?', props.onClose)}
        >
          <Icon name="close" />
        </button>
      </div>
      {error && (
        <div className="status error" role="alert">
          {error}
          <button className="icon" aria-label="Dismiss" onClick={() => setError(null)}>
            <Icon name="close" />
          </button>
        </div>
      )}
      {status && !error && (
        <div className="status" role="status" data-testid="chord-status">
          {status}
        </div>
      )}
      <div className="chord-body">
        <div className="field chord-title">
          <label htmlFor="chord-sequence-title">Title</label>
          <input
            id="chord-sequence-title"
            type="text"
            value={titleText}
            placeholder="Song or progression"
            onChange={(e) => setTitleText(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
        </div>

        <section className="chord-panel" aria-labelledby="chord-builder-heading">
          <div className="chord-panel-heading">
            <h3 id="chord-builder-heading">{editingName ? `Edit ${editingName}` : 'New chord'}</h3>
            <div className="instrument-switch" role="group" aria-label="Instrument">
              {(['guitar', 'bass'] as const).map((instrument) => (
                <button
                  key={instrument}
                  type="button"
                  aria-pressed={draft.instrument === instrument}
                  className={draft.instrument === instrument ? 'selected' : ''}
                  onClick={() => switchInstrument(instrument)}
                >
                  {instrument === 'guitar' ? 'Guitar' : 'Bass'}
                </button>
              ))}
            </div>
            <div className="spacer" />
            <button
              type="button"
              className="outlined"
              disabled={!dirty && draft.index === null}
              onClick={() => guard('Clear the current chord?', () => resetDraft(draft.instrument))}
            >
              New chord
            </button>
          </div>
          <div className="chord-fields">
            <div className="field">
              <label htmlFor="chord-name">Name</label>
              <input
                id="chord-name"
                data-testid="chord-name"
                type="text"
                maxLength={80}
                value={draft.baseName}
                placeholder="Am7"
                onChange={(e) => setDraft({ ...draft, baseName: e.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="chord-tags">Tags (comma separated)</label>
              <input
                id="chord-tags"
                type="text"
                value={draft.tagText}
                placeholder="jazz, open"
                onChange={(e) => setDraft({ ...draft, tagText: e.target.value })}
              />
            </div>
            <div className="field chord-note">
              <label htmlFor="chord-note">Note</label>
              <textarea
                id="chord-note"
                maxLength={1000}
                value={draft.note}
                onChange={(e) => setDraft({ ...draft, note: e.target.value })}
              />
            </div>
          </div>
          <div className="small chord-hint">
            Choose mute, open or a fret for each string. At least three strings must not be muted.
          </div>
          <Fretboard
            instrument={draft.instrument}
            strings={draft.strings}
            onChange={(strings) => setDraft({ ...draft, strings })}
          />
          {errors.length > 0 && (
            <ul className="chord-errors error" role="alert" data-testid="chord-errors">
              {errors.map((m) => (
                <li key={m}>{m}</li>
              ))}
            </ul>
          )}
          <div className="chord-actions">
            <span className="small">{draft.strings.map(stringToken).join(' ')}</span>
            <button type="button" className="filled" data-testid="save-chord" onClick={saveChord}>
              {draft.index === null ? 'Add chord' : 'Update chord'}
            </button>
          </div>
        </section>

        <section className="chord-panel" aria-labelledby="chord-list-heading">
          <div className="chord-panel-heading">
            <h3 id="chord-list-heading">Sequence</h3>
          </div>
          {chords.length === 0 ? (
            <div className="empty">No chords yet. Build one above and add it.</div>
          ) : (
            <ol className="chord-list" data-testid="chord-list">
              {chords.map((chord, index) => (
                <li
                  key={index}
                  className={`chord-card ${draft.index === index ? 'open' : ''}`}
                  data-testid="chord-card"
                >
                  <div className="chord-card-head">
                    <span className="instrument-badge">{chord.instrument}</span>
                    <strong className="chord-card-name">{displayNames[index]}</strong>
                  </div>
                  <ChordPreview
                    instrument={chord.instrument}
                    strings={chord.strings}
                    label={`${displayNames[index]}: ${chord.strings.map(stringToken).join(' ')}`}
                  />
                  {chord.tags.length > 0 && (
                    <div className="chord-tags">
                      {chord.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  )}
                  {chord.note && <div className="small chord-card-note">{chord.note}</div>}
                  <div className="chord-card-actions">
                    <button className="icon" aria-label="Edit" title="Edit" onClick={() => editChord(index)}>
                      <Icon name="pencil" />
                    </button>
                    <button
                      className="icon"
                      aria-label="Duplicate"
                      title="Duplicate"
                      onClick={() => duplicateChord(index)}
                    >
                      <Icon name="copy" />
                    </button>
                    <button
                      className="icon"
                      aria-label="Move up"
                      title="Move up"
                      disabled={index === 0}
                      onClick={() => moveChord(index, -1)}
                    >
                      <Icon name="up" />
                    </button>
                    <button
                      className="icon"
                      aria-label="Move down"
                      title="Move down"
                      disabled={index === chords.length - 1}
                      onClick={() => moveChord(index, 1)}
                    >
                      <Icon name="down" />
                    </button>
                    <button
                      className="icon danger"
                      aria-label="Delete"
                      title="Delete"
                      onClick={() => deleteChord(index)}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
      {pending && (
        <ConfirmDialog
          title={pending.title}
          message={pending.message}
          confirm={pending.confirm}
          danger={pending.danger}
          onConfirm={pending.action}
          onClose={() => setPending(null)}
        />
      )}
    </section>
  );
}
