import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { EditorSelection, EditorState, Prec } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { useEffect, useRef, useState } from 'react';
import * as E from '../../../shared/markdownEditing';
import * as P from '../../../shared/paths';
import { errorMessage, useApp } from './context';
import { Preview } from './Preview';

type Mode = 'edit' | 'split' | 'preview';

const SAVE_DELAY_MS = 500;

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

export function Editor(props: { path: string; onClose(): void }) {
  const { notes } = useApp();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [mode, setMode] = useState<Mode>('split');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let saved = '';

    const flush = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = null;
      const v = view.current;
      if (!v) return;
      const content = v.state.doc.toString();
      if (content === saved) return;
      saved = content;
      notes.write(props.path, content).catch((e) => setError(errorMessage(e)));
    };

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

    void notes.read(props.path).then(
      (content) => {
        if (disposed || !host.current) return;
        saved = content;
        setText(content);
        view.current = new EditorView({
          parent: host.current,
          state: EditorState.create({
            doc: content,
            extensions: [
              enter,
              history(),
              keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
              markdown({ base: markdownLanguage, codeLanguages: languages }),
              syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
              EditorView.lineWrapping,
              placeholder('Write markdown…'),
              editorTheme,
              EditorView.contentAttributes.of({ 'data-testid': 'editor-field', 'aria-label': 'Note' }),
              EditorView.updateListener.of((u) => {
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
          if (disposed || saveTimer || content === saved) return;
          saved = content;
          if (v.state.doc.toString() !== content) {
            v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: content } });
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
  }, [notes, props.path]);

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
        <button className="icon" aria-label="Close" onClick={props.onClose}>
          ✕
        </button>
      </div>
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
        </div>
      )}
      {error && <div className="status error">{error}</div>}
      <div className="editor-body">
        <div ref={host} style={mode === 'preview' ? { display: 'none' } : undefined} />
        {mode !== 'edit' && text !== null && <Preview text={text} />}
      </div>
    </section>
  );
}
