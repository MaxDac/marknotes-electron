import { useEffect, useMemo, useRef } from 'react';
import { typeForPath } from '../../../shared/attachments';
import type { IndexedNote } from '../../../shared/noteLinks';
import { api } from '../data/api';
import { attachmentUrl } from '../data/images';
import { useApp, useNotesVersion } from './context';
import { renderMarkdown } from './markdown';

export function Preview(props: {
  text: string;
  /** Indexed notes, used to style broken note links; null while loading. */
  index: IndexedNote[] | null;
  onNoteLink(id: string): void;
}) {
  const { notes } = useApp();
  const version = useNotesVersion();
  const host = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(props.text), [props.text]);

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
  );
}
