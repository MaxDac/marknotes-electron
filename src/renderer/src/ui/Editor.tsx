import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder, type ViewUpdate } from '@codemirror/view';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IMAGE_TYPES, imageMarkdown } from '../../../shared/attachments';
import { splitFrontMatter } from '../../../shared/frontMatter';
import * as E from '../../../shared/markdownEditing';
import {
  buildNoteIndex,
  ensureNoteId,
  filterNotes,
  findMention,
  noteLink,
  resolveNoteId,
  type IndexedNote,
  type Mention,
} from '../../../shared/noteLinks';
import * as P from '../../../shared/paths';
import { imageFiles, importImage } from '../data/images';
import { errorMessage, useApp, useNotesVersion } from './context';
import { Preview } from './Preview';

type Mode = 'edit' | 'split' | 'preview';

const SAVE_DELAY_MS = 500;
const MAX_MENTION_ROWS = 100;
const IMAGE_ACCEPT = Object.keys(IMAGE_TYPES).join(',');

function current(view: EditorView): E.EditorText {
  const sel = view.state.selection.main;
  return E.editorText(view.state.doc.toString(), sel.anchor, sel.head);
}

/** Applies `next` as the minimal change from the current document, keeping undo history meaningful. */
function apply(view: EditorView, next: E.EditorText) {
  const old = view.state.doc.toString();
  let start = 0;
  while (start < old.length && start < next.text.length && old[start] === next.text[start]) start++;
  let endOld = old.length;
  let endNew = next.text.length;
  while (endOld > start && endNew > start && old[endOld - 1] === next.text[endNew - 1]) {
    endOld--;
    endNew--;
  }
  view.dispatch({
    changes: { from: start, to: endOld, insert: next.text.substring(start, endNew) },
    selection: EditorSelection.single(next.selectionStart, next.selectionEnd),
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
}

/** Replaces `from`..`to` with `text` and puts the cursor after it. */
function insert(view: EditorView, from: number, to: number, text: string) {
  view.dispatch({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    scrollIntoView: true,
    userEvent: 'input',
  });
  view.focus();
}

/** The "@" mention being typed at the cursor, if the selection is empty. */
function mentionAt(state: EditorState): Mention | null {
  const sel = state.selection.main;
  if (!sel.empty) return null;
  const line = state.doc.lineAt(sel.head);
  return findMention(line.text.substring(0, sel.head - line.from), line.from);
}

const TOOLBAR: { label: string; text: string; action(v: E.EditorText): E.EditorText }[] = [
  { label: 'Bold', text: 'B', action: (v) => E.toggleInline(v, '**') },
  { label: 'Italic', text: 'I', action: (v) => E.toggleInline(v, '*') },
  { label: 'Strikethrough', text: 'S̶', action: (v) => E.toggleInline(v, '~~') },
  { label: 'Heading', text: 'H', action: E.cycleHeading },
  { label: 'Bullet list', text: '•', action: (v) => E.toggleLinePrefix(v, 'bullet') },
  { label: 'Numbered list', text: '1.', action: (v) => E.toggleLinePrefix(v, 'numbered') },
  { label: 'Checkbox', text: '☐', action: (v) => E.toggleLinePrefix(v, 'checkbox') },
  { label: 'Quote', text: '❝', action: (v) => E.toggleLinePrefix(v, 'quote') },
  { label: 'Inline code', text: '<>', action: (v) => E.toggleInline(v, '`') },
  { label: 'Code block', text: '{ }', action: E.toggleCodeBlock },
  { label: 'Link', text: '🔗', action: E.insertLink },
];

const editorTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--bg)', color: 'var(--text)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--primary) 30%, transparent) !important',
  },
  '.cm-gutters': { display: 'none' },
});

/**
 * The indexed notes, rebuilt whenever the note tree changes while `enabled`. With `assign`, missing and
 * duplicate ids are assigned and saved.
 */
function useNoteIndex(enabled: boolean, assign: boolean): IndexedNote[] | null {
  const { notes } = useApp();
  const version = useNotesVersion();
  const [index, setIndex] = useState<IndexedNote[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    buildNoteIndex(notes, { assign }).then(
      (result) => {
        if (!cancelled) setIndex(result);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [notes, version, enabled, assign]);
  return enabled ? index : null;
}

interface MentionPopupState {
  mention: Mention;
  matches: IndexedNote[];
  selected: number;
}

export function Editor(props: {
  path: string;
  onClose(): void;
  onOpenNote(path: string): void;
  /** Extra header controls, e.g. the switch back to the chord editor. */
  headerExtra?: ReactNode;
  /** A banner shown above the editor. */
  notice?: ReactNode;
}) {
  const { notes } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState<Mode>('split');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mention, setMention] = useState<Mention | null>(null);
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);
  /** Position of an "@" whose popup was dismissed; it stays closed until that mention ends. */
  const dismissed = useRef<number | null>(null);
  const popup = useRef<MentionPopupState | null>(null);
  const mentionRef = useRef<Mention | null>(null);
  const acceptRef = useRef<(note: IndexedNote) => void>(() => undefined);
  const insertImagesRef = useRef<(files: File[], at?: number) => void>(() => undefined);

  const mentionIndex = useNoteIndex(mention !== null, true);
  const previewIndex = useNoteIndex(mode !== 'edit' && (text?.includes('marknotes:') ?? false), false);
  const matches = useMemo(
    () => (mention && mentionIndex ? filterNotes(mentionIndex, mention.query) : []),
    [mention, mentionIndex],
  );

  const closeMention = useCallback(() => {
    const m = mentionRef.current;
    if (m) dismissed.current = m.from;
    popup.current = null;
    mentionRef.current = null;
    setMention(null);
  }, []);

  const updateMention = useCallback((state: EditorState) => {
    const m = mentionAt(state);
    if (!m || m.from !== dismissed.current) dismissed.current = null;
    const next = m && m.from !== dismissed.current ? m : null;
    mentionRef.current = next;
    setMention((prev) => (prev?.from === next?.from && prev?.query === next?.query ? prev : next));
  }, []);

  // Typing a space when nothing matches closes the popup.
  useEffect(() => {
    if (mention && mentionIndex && matches.length === 0 && /\s$/.test(mention.query)) closeMention();
  }, [mention, mentionIndex, matches, closeMention]);

  useEffect(() => setSelected(0), [mention?.from, mention?.query]);

  useEffect(() => {
    popup.current = mention && mentionIndex ? { mention, matches, selected } : null;
  }, [mention, mentionIndex, matches, selected]);

  acceptRef.current = (note: IndexedNote) => {
    const v = view.current;
    const m = mentionRef.current;
    if (!v || !m) return;
    insert(v, m.from, v.state.selection.main.head, noteLink(note.title, note.id));
    // A title containing " @" must not reopen the popup right after the link.
    dismissed.current = mentionAt(v.state)?.from ?? null;
    popup.current = null;
    mentionRef.current = null;
    setMention(null);
  };

  insertImagesRef.current = (files: File[], at?: number) => {
    void (async () => {
      const inserted: string[] = [];
      for (const file of files) {
        try {
          inserted.push(imageMarkdown(file.name, await importImage(notes, file)));
        } catch (e) {
          setError(errorMessage(e));
        }
      }
      const v = view.current;
      if (!v || inserted.length === 0) return;
      const sel = v.state.selection.main;
      const from = at ?? sel.from;
      insert(v, from, at ?? sel.to, inserted.join('\n'));
    })();
  };

  useEffect(() => {
    let disposed = false;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    /** The body last written or loaded; the editor only ever shows the body, never the front-matter. */
    let savedBody = '';
    /** The front-matter last seen in the stored note, used if the stored note cannot be read. */
    let frontMatter = '';
    let writes: Promise<void> = Promise.resolve();

    const flush = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      const v = view.current;
      if (!v) return;
      const body = v.state.doc.toString();
      if (body === savedBody) return;
      savedBody = body;
      writes = writes
        .then(async () => {
          // Re-read the header: another component may have changed the id meanwhile (duplicate ids).
          const stored = await notes.read(props.path).then(splitFrontMatter, () => null);
          if (stored?.frontMatter) frontMatter = stored.frontMatter;
          await notes.write(props.path, frontMatter + body);
        })
        .catch((e) => setError(errorMessage(e)));
    };

    const keys = Prec.highest(
      keymap.of([
        {
          key: 'ArrowDown',
          run: () => {
            const p = popup.current;
            if (!p) return false;
            if (p.matches.length > 0)
              setSelected((p.selected + 1) % Math.min(p.matches.length, MAX_MENTION_ROWS));
            return true;
          },
        },
        {
          key: 'ArrowUp',
          run: () => {
            const p = popup.current;
            if (!p) return false;
            const count = Math.min(p.matches.length, MAX_MENTION_ROWS);
            if (count > 0) setSelected((p.selected - 1 + count) % count);
            return true;
          },
        },
        {
          key: 'Enter',
          run: () => {
            const p = popup.current;
            if (!p || p.matches.length === 0) return false;
            acceptRef.current(p.matches[Math.min(p.selected, p.matches.length - 1)]);
            return true;
          },
        },
        {
          key: 'Tab',
          run: () => {
            const p = popup.current;
            if (!p || p.matches.length === 0) return false;
            acceptRef.current(p.matches[Math.min(p.selected, p.matches.length - 1)]);
            return true;
          },
        },
        {
          key: 'Escape',
          run: () => {
            if (!mentionRef.current) return false;
            closeMention();
            return true;
          },
        },
      ]),
    );

    const enter = Prec.high(
      keymap.of([
        {
          key: 'Enter',
          run: (v) => {
            const next = E.continueListOnEnter(current(v));
            if (!next) return false;
            apply(v, next);
            return true;
          },
        },
      ]),
    );

    const images = EditorView.domEventHandlers({
      paste: (event) => {
        const files = imageFiles(event.clipboardData?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        insertImagesRef.current(files);
        return true;
      },
      drop: (event, v) => {
        const files = imageFiles(event.dataTransfer?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        insertImagesRef.current(files, v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined);
        return true;
      },
    });

    void ensureNoteId(notes, props.path).then(
      ({ text: content }) => {
        if (disposed || !host.current) return;
        const split = splitFrontMatter(content);
        frontMatter = split.frontMatter;
        savedBody = split.body;
        setText(split.body);
        view.current = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: split.body,
            extensions: [
              keys,
              enter,
              images,
              history(),
              keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
              markdown({ base: markdownLanguage, codeLanguages: languages }),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              EditorView.lineWrapping,
              placeholder('Write markdown… Type @ to link a note.'),
              editorTheme,
              EditorView.contentAttributes.of({ 'data-testid': 'editor-field', 'aria-label': 'Note' }),
              EditorView.updateListener.of((u: ViewUpdate) => {
                if (u.docChanged || u.selectionSet) updateMention(u.state);
                if (!u.docChanged) return;
                setText(u.state.doc.toString());
                if (saveTimer) clearTimeout(saveTimer);
                saveTimer = setTimeout(flush, SAVE_DELAY_MS);
              }),
            ],
          }),
        });
        view.current.focus();
      },
      (e) => setError(errorMessage(e)),
    );

    // Reload when the note changes underneath (sync, conflict resolution) and there are no unsaved edits.
    const unsubscribe = notes.onChange(() => {
      const v = view.current;
      if (!v || saveTimer) return;
      void notes
        .read(props.path)
        .then((content) => {
          if (disposed || saveTimer) return;
          const split = splitFrontMatter(content);
          if (split.frontMatter) frontMatter = split.frontMatter;
          if (split.body === savedBody) return;
          savedBody = split.body;
          if (v.state.doc.toString() !== split.body) {
            v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: split.body } });
          }
        })
        .catch(() => undefined);
    });

    const onBlur = () => flush();
    window.addEventListener('blur', onBlur);
    return () => {
      disposed = true;
      unsubscribe();
      window.removeEventListener('blur', onBlur);
      flush();
      view.current?.destroy();
      view.current = null;
    };
  }, [notes, props.path, updateMention, closeMention]);

  const openLinkedNote = useCallback(
    (id: string) => {
      void buildNoteIndex(notes).then(
        (index) => {
          const target = resolveNoteId(index, id);
          if (target) props.onOpenNote(target.path);
          else setError('Note not found');
        },
        (e) => setError(errorMessage(e)),
      );
    },
    [notes, props],
  );

  const copyId = (id: string) => {
    void navigator.clipboard.writeText(id).then(
      () => {
        setCopied(id);
        setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
      },
      () => setError('Could not copy to the clipboard'),
    );
  };

  const showPopup = mention !== null && mode !== 'preview';

  return (
    <section className="editor-pane" aria-label="Editor">
      <div className="editor-header">
        <span className="title" data-testid="note-title">
          {P.displayName(props.path)}
        </span>
        {(['edit', 'split', 'preview'] as const).map((m) => (
          <button key={m} className={mode === m ? 'selected' : ''} onClick={() => setMode(m)}>
            {m === 'edit' ? 'Edit' : m === 'split' ? 'Split' : 'Preview'}
          </button>
        ))}
        {props.headerExtra}
        <button className="icon" aria-label="Close" onClick={props.onClose}>
          ✕
        </button>
      </div>
      {props.notice}
      {mode !== 'preview' && (
        <div className="toolbar" data-testid="format-toolbar">
          {TOOLBAR.map((t) => (
            <button
              key={t.label}
              className="icon"
              title={t.label}
              aria-label={t.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => view.current && apply(view.current, t.action(current(view.current)))}
            >
              {t.text}
            </button>
          ))}
          <button
            className="icon"
            title="Insert image"
            aria-label="Insert image"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fileInput.current?.click()}
          >
            🖼
          </button>
          <input
            ref={fileInput}
            type="file"
            accept={IMAGE_ACCEPT}
            multiple
            hidden
            data-testid="image-input"
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = '';
              if (files.length > 0) insertImagesRef.current(files);
            }}
          />
        </div>
      )}
      {error && (
        <div className="status error" role="alert">
          {error}
          <button className="icon" aria-label="Dismiss" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
      <div className="editor-body">
        <div ref={host} style={mode === 'preview' ? { display: 'none' } : undefined} />
        {mode !== 'edit' && text !== null && (
          <Preview text={text} index={previewIndex} onNoteLink={openLinkedNote} />
        )}
      </div>
      {showPopup && (
        <div className="mention-popup" role="listbox" aria-label="Link a note" data-testid="mention-popup">
          {mentionIndex === null && <div className="small mention-empty">Loading notes…</div>}
          {mentionIndex !== null && matches.length === 0 && (
            <div className="small mention-empty">No matching notes</div>
          )}
          {matches.slice(0, MAX_MENTION_ROWS).map((n, i) => (
            <div
              key={n.id}
              role="option"
              aria-selected={i === selected}
              className={`mention-row ${i === selected ? 'selected' : ''}`}
              data-testid="mention-option"
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSelected(i)}
              onClick={() => acceptRef.current(n)}
            >
              <div className="mention-text">
                <div className="mention-title">{n.title}</div>
                <div className="small mention-path">{n.fullPath}</div>
              </div>
              <span className="id-chip" data-testid="note-id">
                {n.id}
              </span>
              <button
                className="icon"
                title="Copy id"
                aria-label={`Copy id ${n.id}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => {
                  e.stopPropagation();
                  copyId(n.id);
                }}
              >
                {copied === n.id ? '✓' : '⧉'}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
