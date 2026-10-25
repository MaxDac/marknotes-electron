import { useEffect, useRef, useState } from 'react';
import { attachmentRefs } from '../../../shared/attachments';
import { suggestTitle } from '../../../shared/importing/importConverter';
import {
  canFormat,
  composeBody,
  prepareImport,
  type ImportClipboard,
  type PreparedImport,
} from '../../../shared/importing/prepareImport';
import { IMPORT_ACCEPT, ImportStaging } from '../data/documentImport';
import { useApp } from './context';
import { Dialog } from './Dialog';
import { Preview } from './Preview';

/** What to import right away (dropped or pasted content); without it the dialog asks for it. */
export interface ImportRequest {
  files: File[];
  clipboard: ImportClipboard | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Imports text, HTML, Markdown, Word and PDF documents and images into a new note, after a review of its title,
 * folder and formatting. Nothing is written to the notes until the note is saved.
 */
export function ImportDialog(props: {
  request: ImportRequest | null;
  folder: string;
  folders: string[];
  onClose(): void;
  onImported(path: string): void;
}) {
  const { notes } = useApp();
  const [text, setText] = useState('');
  const [staging, setStaging] = useState(() => new ImportStaging());
  const [prepared, setPrepared] = useState<PreparedImport | null>(null);
  const [autoFormat, setAutoFormat] = useState(true);
  const [body, setBody] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState(props.folder);
  const [showSource, setShowSource] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titled = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const prepare = async (files: File[], clipboard: ImportClipboard | null) => {
    if (busy) return;
    const next = new ImportStaging();
    setBusy(true);
    setError(null);
    try {
      const result = await prepareImport(files, clipboard, next.platform);
      if (!mounted.current) return;
      titled.current = false;
      setStaging(next);
      setAutoFormat(true);
      setBody(null);
      setShowSource(false);
      setPrepared(result);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const initial = useRef(props.request);
  useEffect(() => {
    const request = initial.current;
    initial.current = null;
    if (request) void prepare(request.files, request.clipboard);
    // Runs once, for the content the dialog was opened with.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!prepared) return;
    let cancelled = false;
    setBusy(true);
    composeBody(prepared, autoFormat, staging.sink).then(
      (result) => {
        if (cancelled) return;
        setBody(result);
        setError(null);
        if (!titled.current) {
          titled.current = true;
          setTitle(suggestTitle(result, prepared.fileName, prepared.subject));
        }
        setBusy(false);
      },
      (e: unknown) => {
        if (cancelled) return;
        setBody(null);
        setError(message(e));
        setBusy(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [prepared, autoFormat, staging]);

  const save = async () => {
    if (body === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      const images = await staging.images(attachmentRefs(body));
      const path = await notes.importNote(folder, title, body, images);
      props.onImported(path);
      props.onClose();
    } catch (e) {
      if (mounted.current) {
        setError(message(e));
        setBusy(false);
      }
    }
  };

  const close = () => {
    if (!busy) props.onClose();
  };

  return (
    <Dialog
      title="Import note"
      onClose={close}
      actions={
        <>
          <button disabled={busy} onClick={close}>
            Cancel
          </button>
          {prepared ? (
            <button
              className="filled"
              data-testid="import-save"
              disabled={busy || body === null || title.trim() === ''}
              onClick={() => void save()}
            >
              Save
            </button>
          ) : (
            <button
              className="filled"
              disabled={busy || text.trim() === ''}
              onClick={() => void prepare([], { text })}
            >
              Next
            </button>
          )}
        </>
      }
    >
      <div
        className="import-content"
        onDrop={(e) => {
          const files = [...e.dataTransfer.files];
          if (files.length === 0) return;
          e.preventDefault();
          if (!prepared) void prepare(files, null);
        }}
      >
        {!prepared ? (
          <>
            <p className="small">
              Import text, HTML, Markdown, Word (.docx) and PDF files, and images. You can also paste or drop
              them. Nothing is saved until you review the note.
            </p>
            <div className="field">
              <label htmlFor="import-files">Files</label>
              <input
                id="import-files"
                data-testid="import-files"
                type="file"
                accept={IMPORT_ACCEPT}
                multiple
                disabled={busy}
                onChange={(e) => {
                  const files = [...(e.target.files ?? [])];
                  e.target.value = '';
                  if (files.length > 0) void prepare(files, null);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="import-text">Text</label>
              <textarea
                id="import-text"
                data-testid="import-text"
                rows={8}
                value={text}
                disabled={busy}
                placeholder="Paste or type the text to import"
                onChange={(e) => setText(e.target.value)}
                onPaste={(e) => {
                  const files = [...e.clipboardData.files];
                  const html = e.clipboardData.getData('text/html');
                  if (files.length > 0) {
                    e.preventDefault();
                    void prepare(files, null);
                  } else if (html.trim() !== '' && text === '') {
                    e.preventDefault();
                    void prepare([], { html, text: e.clipboardData.getData('text/plain') });
                  }
                }}
              />
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label htmlFor="import-title">Title</label>
              <input
                id="import-title"
                data-testid="import-title"
                type="text"
                value={title}
                disabled={busy}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="import-folder">Folder</label>
              <select
                id="import-folder"
                data-testid="import-folder"
                value={folder}
                disabled={busy}
                onChange={(e) => setFolder(e.target.value)}
              >
                <option value="">All notes</option>
                {props.folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </div>
            <label className="row">
              <input
                type="checkbox"
                role="switch"
                data-testid="import-auto-format"
                checked={autoFormat}
                disabled={busy || !canFormat(prepared)}
                onChange={(e) => setAutoFormat(e.target.checked)}
              />
              <span>
                Auto-format as Markdown
                <br />
                <span className="small">
                  {autoFormat ? 'Headings, lists, links and tables' : 'Keep the text as it is'}
                </span>
              </span>
            </label>
            <div className="row" role="radiogroup" aria-label="View">
              <button
                role="radio"
                aria-checked={!showSource}
                className={showSource ? 'outlined' : 'selected'}
                onClick={() => setShowSource(false)}
              >
                Preview
              </button>
              <button
                role="radio"
                aria-checked={showSource}
                className={showSource ? 'selected' : 'outlined'}
                onClick={() => setShowSource(true)}
              >
                Markdown
              </button>
            </div>
            {prepared.skippedImages > 0 && (
              <p className="error">{prepared.skippedImages} image(s) could not be added.</p>
            )}
            {body !== null &&
              (showSource ? (
                <pre className="import-source" data-testid="import-source">
                  {body}
                </pre>
              ) : (
                <div className="import-preview">
                  <Preview text={body} index={null} onNoteLink={() => {}} attachmentStore={staging.store} />
                </div>
              ))}
          </>
        )}
        {busy && (
          <p className="small" role="status">
            Converting…
          </p>
        )}
        {error && (
          <p className="error" role="alert" data-testid="import-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
