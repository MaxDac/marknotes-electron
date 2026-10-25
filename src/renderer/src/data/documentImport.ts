/// <reference types="vite/client" />
import { typeForPath } from '../../../shared/attachments';
import { ImportError, type ImageSink } from '../../../shared/importing/importError';
import {
  MAX_TEXT_BYTES,
  type ImportFile,
  type ImportPlatform,
} from '../../../shared/importing/prepareImport';
import { MemoryNodeBackend, NoteStore } from '../../../shared/noteStore';
import { importImage } from './images';

/** File types offered by the import file picker. */
export const IMPORT_ACCEPT = [
  '.txt',
  '.md',
  '.markdown',
  '.html',
  '.htm',
  '.docx',
  '.pdf',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  'text/plain',
  'text/markdown',
  'text/html',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
].join(',');

/** Extracts the text of a PDF with pdf.js, loaded on first use. No fonts, character maps or scripts are fetched. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  }
  const task = pdfjs.getDocument({
    data: bytes,
    disableFontFace: true,
    useSystemFonts: false,
    useWasm: false,
    useWorkerFetch: false,
    enableXfa: false,
    stopAtErrors: false,
  });
  try {
    const pdf = await task.promise;
    const pages: string[] = [];
    let length = 0;
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if ('str' in item) text += item.str + (item.hasEOL ? '\n' : '');
      }
      page.cleanup();
      length += text.length;
      if (length > MAX_TEXT_BYTES) {
        throw new ImportError(
          `This file is too large to import (the limit is ${MAX_TEXT_BYTES / 1024 / 1024} MB).`,
        );
      }
      pages.push(text.trimEnd());
    }
    return pages.join('\n\n');
  } catch (e) {
    if (e instanceof ImportError) throw e;
    if (e instanceof Error && e.name === 'PasswordException') {
      throw new ImportError('This PDF is password protected.', { cause: e });
    }
    throw new ImportError(`Could not read the PDF: ${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  } finally {
    await task.destroy();
  }
}

/**
 * Imported images are processed and kept in memory until the note is saved, so cancelling the import leaves
 * nothing behind; only the images the saved note references are written to the notes.
 */
export class ImportStaging {
  readonly store = new NoteStore(new MemoryNodeBackend());

  readonly platform: ImportPlatform = {
    pdfText,
    stageImage: async (file: ImportFile) => {
      const dot = file.name.lastIndexOf('.');
      const extension =
        dot < 0
          ? ''
          : file.name
              .substring(dot + 1)
              .toLowerCase()
              .replace('jpeg', 'jpg');
      // Files without a MIME type are recognized by their extension.
      const type = file.type || typeForPath(`image.${extension}`) || '';
      const image =
        file instanceof File && file.type === type
          ? file
          : new File([await file.arrayBuffer()], file.name, { type });
      return importImage(this.store, image);
    },
  };

  readonly sink: ImageSink = async (bytes, extension, fileName) => {
    const type = typeForPath(`image.${extension}`);
    if (!type) return null;
    try {
      return await importImage(this.store, new File([bytes as Uint8Array<ArrayBuffer>], fileName, { type }));
    } catch {
      return null;
    }
  };

  /** The staged images that `paths` reference, to save with the note. */
  async images(paths: Iterable<string>): Promise<{ path: string; bytes: Uint8Array }[]> {
    const images: { path: string; bytes: Uint8Array }[] = [];
    for (const path of paths) {
      if (await this.store.exists(path)) images.push({ path, bytes: await this.store.readBytes(path) });
    }
    return images;
  }
}
