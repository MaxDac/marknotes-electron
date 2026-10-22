import { sha256Hex } from './hashing';
import type { NoteStore } from './noteStore';
import * as P from './paths';

/**
 * Images are stored at the root of the notes folder in `attachments/<sha256>.<ext>`, named after the hash of
 * their final bytes, and referenced from notes with a root-relative path. See docs/note-format.md.
 */
export const ATTACHMENTS_FOLDER = 'attachments';
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 2048;

export const IMAGE_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const ATTACHMENT_FILE = /^[0-9a-f]{64}\.(png|jpg|gif|webp)$/;
const ATTACHMENT_REF = /attachments\/([0-9a-f]{64}\.(?:png|jpg|gif|webp))/g;

export function extensionForType(mime: string): string | null {
  return IMAGE_TYPES[mime.toLowerCase()] ?? null;
}

export function typeForPath(path: string): string | null {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? null : (EXTENSION_TYPES[path.substring(dot + 1).toLowerCase()] ?? null);
}

/** True for the root `attachments` folder or anything inside it. */
export function isInAttachments(path: string): boolean {
  return path === ATTACHMENTS_FOLDER || path.startsWith(`${ATTACHMENTS_FOLDER}/`);
}

/** True for a file synced as an attachment: `attachments/<64 hex>.<png|jpg|gif|webp>`. */
export function isAttachmentPath(path: string): boolean {
  return P.parent(path) === ATTACHMENTS_FOLDER && ATTACHMENT_FILE.test(P.name(path));
}

export function attachmentPath(hash: string, extension: string): string {
  return `${ATTACHMENTS_FOLDER}/${hash}.${extension}`;
}

/** Normalizes an image `src` written in a note to an attachment path, or null when it is not one. */
export function attachmentFromSrc(src: string): string | null {
  const path = src.replace(/^(\.?\/)+/, '');
  return isAttachmentPath(path) ? path : null;
}

/** Markdown for an image: the alt text is the original file name without extension. */
export function imageMarkdown(fileName: string, path: string): string {
  const dot = fileName.lastIndexOf('.');
  const base = (dot > 0 ? fileName.substring(0, dot) : fileName).replace(/[[\]\\\r\n]/g, ' ').trim();
  return `![${base}](${path})`;
}

/** Every attachment path referenced by `text`. */
export function attachmentRefs(text: string): Set<string> {
  const refs = new Set<string>();
  for (const m of text.matchAll(ATTACHMENT_REF)) refs.add(`${ATTACHMENTS_FOLDER}/${m[1]}`);
  return refs;
}

/** Stores image bytes (already processed) as an attachment and returns its path. */
export async function saveAttachment(store: NoteStore, bytes: Uint8Array, mime: string): Promise<string> {
  const extension = extensionForType(mime);
  if (!extension) throw new Error('Only PNG, JPEG, GIF and WebP images are supported');
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error('This image is too large: images must be at most 10 MB');
  }
  const path = attachmentPath(await sha256Hex(bytes), extension);
  if (!(await store.exists(path))) await store.writeBytes(path, bytes);
  return path;
}

/** Attachment files that no note references. */
export async function unusedAttachments(store: NoteStore): Promise<string[]> {
  const all = await store.listAll();
  const used = new Set<string>();
  for (const e of all) {
    if (!e.isFolder && P.isNote(e.path))
      for (const r of attachmentRefs(await store.read(e.path))) used.add(r);
  }
  return all.filter((e) => !e.isFolder && isAttachmentPath(e.path) && !used.has(e.path)).map((e) => e.path);
}

/** Deletes unreferenced attachments locally (the deletion reaches the drives on the next sync). */
export async function cleanUnusedAttachments(store: NoteStore): Promise<number> {
  const unused = await unusedAttachments(store);
  for (const path of unused) await store.delete(path);
  return unused.length;
}

/** The size of an image scaled so that its longest side is at most `max`. */
export function scaledSize(width: number, height: number, max = MAX_IMAGE_SIDE) {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height, scaled: false };
  const factor = max / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
    scaled: true,
  };
}
