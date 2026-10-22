import {
  extensionForType,
  MAX_ATTACHMENT_BYTES,
  saveAttachment,
  scaledSize,
} from '../../../shared/attachments';
import type { NoteStore } from '../../../shared/noteStore';

const JPEG_QUALITY = 0.9;
const WEBP_QUALITY = 0.9;

/** Downscales an image so its longest side is at most 2048 px, keeping its format (GIFs are kept as is). */
async function processImage(file: Blob): Promise<Uint8Array> {
  const original = new Uint8Array(await file.arrayBuffer());
  if (file.type === 'image/gif') return original;
  const bitmap = await createImageBitmap(file);
  try {
    const size = scaledSize(bitmap.width, bitmap.height);
    if (!size.scaled) return original;
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process the image');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    const quality =
      file.type === 'image/jpeg' ? JPEG_QUALITY : file.type === 'image/webp' ? WEBP_QUALITY : undefined;
    const blob = await canvas.convertToBlob({ type: file.type, quality });
    // convertToBlob falls back to PNG for unsupported types: never store bytes under the wrong extension.
    if (blob.type !== file.type) return original;
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/** Processes and stores an image file as an attachment; returns its path. Throws user-friendly errors. */
export async function importImage(notes: NoteStore, file: File): Promise<string> {
  if (!extensionForType(file.type)) {
    throw new Error(`${file.name || 'This file'} is not a supported image (PNG, JPEG, GIF or WebP)`);
  }
  let bytes: Uint8Array;
  try {
    bytes = await processImage(file);
  } catch {
    throw new Error(`${file.name || 'This image'} could not be read`);
  }
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(`${file.name || 'This image'} is too large: images must be at most 10 MB`);
  }
  return saveAttachment(notes, bytes, file.type);
}

/** Image files among `files` (pasted or dropped). */
export function imageFiles(files: FileList | null | undefined): File[] {
  return [...(files ?? [])].filter((f) => f.type.startsWith('image/'));
}

const objectUrls = new Map<string, string>();

/** An object URL for an attachment, cached for the lifetime of the window (attachments are immutable). */
export async function attachmentUrl(notes: NoteStore, path: string, type: string): Promise<string> {
  const cached = objectUrls.get(path);
  if (cached) return cached;
  const bytes = await notes.readBytes(path);
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  objectUrls.set(path, url);
  return url;
}
