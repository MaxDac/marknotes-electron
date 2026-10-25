/**
 * Reads what the user imports (files, or pasted text and HTML) into a prepared import, and composes the body of the
 * new note. Mirrors Android's `SharedContentReader` and `ImportViewModel`; the platform parts (reading PDF text,
 * processing and staging images) are passed in.
 */
import { imageMarkdown } from '../attachments';
import { convertImport, type ImportSource } from './importConverter';
import { ImportError, type ImageSink } from './importError';

export const MAX_TEXT_BYTES = 5 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export const UNSUPPORTED = 'MarkNotes can import text, HTML, Markdown, Word (.docx) and PDF files.';
export const ONE_DOCUMENT = 'Import one document at a time.';
export const NO_PDF_TEXT = 'This PDF has no text to import (it may be a scanned image).';
export const PDF_PASSWORD = 'This PDF is password protected.';
export const NOTHING = 'Nothing to import.';
export const IMAGES_UNREADABLE = 'The images could not be read.';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const BYTES_PER_MB = 1024 * 1024;

export type ImportKind = 'image' | 'pdf' | 'docx' | 'html' | 'markdown' | 'text' | 'unsupported';

/** A file to import: a browser `File` satisfies it. */
export interface ImportFile {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Pasted or dropped content without files. */
export interface ImportClipboard {
  html?: string | null;
  text?: string | null;
}

export interface ImportPlatform {
  /** The text of a PDF; throws `ImportError` with a user-facing message. */
  pdfText(bytes: Uint8Array): Promise<string>;
  /** Processes and stages an image file as an attachment; returns its path. */
  stageImage(file: ImportFile): Promise<string>;
}

export interface StagedImage {
  fileName: string;
  path: string;
}

export interface PreparedImport {
  source: ImportSource | null;
  fileName: string | null;
  subject: string | null;
  images: StagedImage[];
  skippedImages: number;
}

/** Classifies a file by its MIME type, falling back to the file name's extension. */
export function kindOf(mime: string | null | undefined, name: string | null | undefined): ImportKind {
  const type = mime ? mime.toLowerCase().split(';')[0].trim() || null : null;
  const dot = name ? name.lastIndexOf('.') : -1;
  const ext = name && dot >= 0 ? name.substring(dot + 1).toLowerCase() : '';
  if (type === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (type === DOCX_MIME || ext === 'docx') return 'docx';
  if (type?.startsWith('image/') || IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (type === 'text/html' || type === 'application/xhtml+xml' || ext === 'html' || ext === 'htm')
    return 'html';
  if (type === 'text/markdown' || type === 'text/x-markdown' || ext === 'md' || ext === 'markdown') {
    return 'markdown';
  }
  if (type?.startsWith('text/') || ext === 'txt') return 'text';
  return 'unsupported';
}

/** Decodes text as UTF-8 (or UTF-16 with a byte order mark), falling back to Windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return new TextDecoder('utf-16be').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return new TextDecoder('utf-16le').decode(bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    text = new TextDecoder('windows-1252').decode(bytes);
  }
  return text.startsWith('\uFEFF') ? text.substring(1) : text;
}

async function readBytes(file: ImportFile, max: number): Promise<Uint8Array> {
  if (file.size > max) throw tooLarge(max);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > max) throw tooLarge(max);
  return bytes;
}

const tooLarge = (max: number) =>
  new ImportError(`This file is too large to import (the limit is ${max / BYTES_PER_MB} MB).`);

async function readDocument(file: ImportFile, platform: ImportPlatform): Promise<ImportSource> {
  switch (kindOf(file.type, file.name)) {
    case 'pdf': {
      const text = await platform.pdfText(await readBytes(file, MAX_DOCUMENT_BYTES));
      if (text.trim() === '') throw new ImportError(NO_PDF_TEXT);
      return { kind: 'text', text, reflow: true };
    }
    case 'docx':
      return { kind: 'docx', bytes: await readBytes(file, MAX_DOCUMENT_BYTES) };
    case 'html':
      return { kind: 'html', html: decodeText(await readBytes(file, MAX_TEXT_BYTES)) };
    case 'markdown':
      return { kind: 'markdown', text: decodeText(await readBytes(file, MAX_TEXT_BYTES)) };
    case 'text':
      return { kind: 'text', text: decodeText(await readBytes(file, MAX_TEXT_BYTES)) };
    default:
      throw new ImportError(UNSUPPORTED);
  }
}

/** Reads `files` (at most one document plus images) or else the pasted `clipboard` content. */
export async function prepareImport(
  files: readonly ImportFile[],
  clipboard: ImportClipboard | null,
  platform: ImportPlatform,
): Promise<PreparedImport> {
  const imageFiles = files.filter((f) => kindOf(f.type, f.name) === 'image');
  const documents = files.filter((f) => kindOf(f.type, f.name) !== 'image');
  if (documents.length > 1) throw new ImportError(ONE_DOCUMENT);
  const images: StagedImage[] = [];
  let skipped = 0;
  for (const [i, file] of imageFiles.entries()) {
    try {
      images.push({ fileName: file.name || `image ${i + 1}`, path: await platform.stageImage(file) });
    } catch {
      skipped++;
    }
  }
  const document = documents.at(0);
  let source: ImportSource | null = null;
  if (document) source = await readDocument(document, platform);
  else if (clipboard?.html) source = { kind: 'html', html: clipboard.html, text: clipboard.text ?? null };
  else if (clipboard?.text) source = { kind: 'text', text: clipboard.text };
  if (source === null && images.length === 0)
    throw new ImportError(skipped > 0 ? IMAGES_UNREADABLE : NOTHING);
  return { source, fileName: document?.name ?? null, subject: null, images, skippedImages: skipped };
}

/** False when there is nothing to format (Markdown files, images only). */
export function canFormat(prepared: PreparedImport): boolean {
  return prepared.source !== null && prepared.source.kind !== 'markdown';
}

/** The body of the new note: the converted content followed by the imported images. */
export async function composeBody(
  prepared: PreparedImport,
  autoFormat: boolean,
  sink: ImageSink,
): Promise<string> {
  const text = prepared.source ? (await convertImport(prepared.source, autoFormat, sink)).trimEnd() : '';
  const images = prepared.images.map((image) => imageMarkdown(image.fileName, image.path)).join('\n\n');
  return `${[text, images].filter((part) => part !== '').join('\n\n')}\n`;
}
