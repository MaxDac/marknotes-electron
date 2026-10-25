import { useEffect, useMemo, useRef, useState } from 'react';
import { typeForPath } from '../../../shared/attachments';
import type { IndexedNote } from '../../../shared/noteLinks';
import type { NoteStore } from '../../../shared/noteStore';
import { api } from '../data/api';
import { attachmentUrl } from '../data/images';
import { useApp, useNotesVersion } from './context';
import { isRemoteImage, renderMarkdown } from './markdown';

/** Renders a note. Remote images stay blocked until the user loads them for this note (not remembered). */
export function Preview(props: {
  text: string;
  /** Indexed notes, used to style broken note links; null while loading. */
  index: IndexedNote[] | null;
  onNoteLink(id: string): void;
  /** Where attachments are read from (default: the notes), e.g. the images staged by an import. */
  attachmentStore?: NoteStore;
}) {
  const { notes: appNotes } = useApp();
  const notes = props.attachmentStore ?? appNotes;
  const version = useNotesVersion();
  const host = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(props.text), [props.text]);
  const hasRemoteImages = html.includes('data-remote-src=');
  const [loadRemote, setLoadRemote] = useState(false);

  useEffect(() => {
    const root = host.current;
    if (!root || !loadRemote) return;
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-remote-src]')) {
      const src = img.dataset.remoteSrc!;
      if (isRemoteImage(src)) {
        img.referrerPolicy = 'no-referrer';
        img.src = src;
        img.classList.remove('remote');
      }
    }
  }, [html, loadRemote]);

  useEffect(() => {
    const root = host.current;
    if (!root) return;
    let cancelled = false;
    for (const img of root.querySelectorAll<HTMLImageElement>('img[data-attachment]')) {
      const path = img.dataset.attachment!;
      attachmentUrl(notes, path, typeForPath(path) ?? 'application/octet-stream').then(
        (url) => {
          if (cancelled) return;
          img.src = url;
          img.classList.remove('missing');
        },
        () => {
          if (!cancelled) img.classList.add('missing');
        },
      );
    }
    return () => {
      cancelled = true;
    };
  }, [html, notes, version]);

  useEffect(() => {
    const root = host.current;
    if (!root || !props.index) return;
    const ids = new Set(props.index.map((n) => n.id));
    for (const link of root.querySelectorAll<HTMLAnchorElement>('a[data-note-id]')) {
      const broken = !ids.has(link.dataset.noteId!);
      link.classList.toggle('broken', broken);
      link.title = broken ? 'Note not found' : '';
    }
  }, [html, props.index]);

  return (
    <div className="preview-pane">
      {hasRemoteImages && !loadRemote && (
        <div className="remote-images" data-testid="remote-images">
          <span className="small">
            This note has images from the web. They are not loaded to protect your privacy.
          </span>
          <button className="outlined" onClick={() => setLoadRemote(true)}>
            Load remote images
          </button>
        </div>
      )}
      <div
        ref={host}
        className="preview"
        data-testid="markdown-preview"
        onClick={(e) => {
          const link = (e.target as HTMLElement).closest('a');
          if (!link) return;
          e.preventDefault();
          const noteId = link.dataset.noteId;
          if (noteId) {
            props.onNoteLink(noteId);
            return;
          }
          const href = link.getAttribute('href') ?? '';
          if (/^https?:\/\//i.test(href)) void api().openExternal(href);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
