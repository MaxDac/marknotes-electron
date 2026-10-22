import { generateNoteId, isNoteId, splitFrontMatter, withNoteId } from './frontMatter';
import type { NoteStore } from './noteStore';
import * as P from './paths';

/** Links between notes are written `[Note title](marknotes:<id>)`. See docs/note-format.md. */
export const NOTE_LINK_SCHEME = 'marknotes:';

export interface IndexedNote {
  id: string;
  path: string;
  title: string;
  /** Folder path plus title, e.g. "Work/Projects/Roadmap". */
  fullPath: string;
}

export function noteLink(title: string, id: string): string {
  const text = title.replace(/[[\]\\]/g, (c) => `\\${c}`).replace(/[\r\n]+/g, ' ');
  return `[${text}](${NOTE_LINK_SCHEME}${id})`;
}

/** The note id of a `marknotes:<id>` href, or null for other links. */
export function noteIdFromHref(href: string): string | null {
  if (!href.toLowerCase().startsWith(NOTE_LINK_SCHEME)) return null;
  const id = href.substring(NOTE_LINK_SCHEME.length).trim().toLowerCase();
  return isNoteId(id) ? id : null;
}

export function fullPathOf(path: string): string {
  const folder = P.parent(path);
  const title = P.displayName(path);
  return folder === '' ? title : `${folder}/${title}`;
}

/**
 * Indexes every note by id, sorted by path. With `assign`, notes without an id get one and later notes
 * (by sorted path) whose id duplicates an earlier one get a new id; both are written back so they sync.
 * Without `assign`, notes lacking an id are skipped and duplicates resolve to the first by sorted path.
 */
export async function buildNoteIndex(
  store: NoteStore,
  options: { assign?: boolean; newId?: () => string } = {},
): Promise<IndexedNote[]> {
  const newId = options.newId ?? (() => generateNoteId());
  const paths = (await store.listAll())
    .filter((e) => !e.isFolder && P.isNote(e.path))
    .map((e) => e.path)
    .sort();
  const seen = new Set<string>();
  const result: IndexedNote[] = [];
  for (const path of paths) {
    let text: string;
    try {
      text = await store.read(path);
    } catch {
      continue;
    }
    let id = splitFrontMatter(text).id;
    if (options.assign && (id === null || seen.has(id))) {
      do id = newId();
      while (seen.has(id));
      await store.write(path, withNoteId(text, id));
    }
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, path, title: P.displayName(path), fullPath: fullPathOf(path) });
  }
  return result;
}

/**
 * Ensures the note at `path` has an id (assigning and saving one if missing) and returns it with the content.
 */
export async function ensureNoteId(
  store: NoteStore,
  path: string,
  newId: () => string = () => generateNoteId(),
): Promise<{ id: string; text: string }> {
  const text = await store.read(path);
  const existing = splitFrontMatter(text).id;
  if (existing) return { id: existing, text };
  const id = newId();
  const updated = withNoteId(text, id);
  await store.write(path, updated);
  return { id, text: updated };
}

/** Notes matching `query`: id prefix, or case-insensitive substring of the title or full path. */
export function filterNotes(notes: IndexedNote[], query: string): IndexedNote[] {
  const q = query.trim().toLowerCase();
  if (q === '') return notes;
  return notes.filter(
    (n) => n.id.startsWith(q) || n.title.toLowerCase().includes(q) || n.fullPath.toLowerCase().includes(q),
  );
}

export function resolveNoteId(notes: IndexedNote[], id: string): IndexedNote | undefined {
  return notes.find((n) => n.id === id);
}

/** The `@query` being typed before the cursor, if any. `from` is the position of the "@". */
export interface Mention {
  from: number;
  query: string;
}

/**
 * Finds an "@" mention ending at `cursor` in `line` (the text of the cursor's line up to the cursor;
 * `lineStart` is its document offset). The "@" must start the line or follow whitespace.
 */
export function findMention(lineBeforeCursor: string, lineStart: number): Mention | null {
  const at = lineBeforeCursor.lastIndexOf('@');
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(lineBeforeCursor[at - 1])) return null;
  const query = lineBeforeCursor.substring(at + 1);
  if (/^\s/.test(query) || query.length > 80) return null;
  return { from: lineStart + at, query };
}
