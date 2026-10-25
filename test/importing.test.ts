import { describe, expect, it } from 'vitest';
import { attachmentPath } from '../src/shared/attachments';
import { splitFrontMatter } from '../src/shared/frontMatter';
import { sha256Hex } from '../src/shared/hashing';
import {
  convertImport,
  DEFAULT_TITLE,
  sanitizeTitle,
  suggestTitle,
} from '../src/shared/importing/importConverter';
import { ImportError, NO_IMAGES } from '../src/shared/importing/importError';
import { looksLikeMarkdown, plainTextToMarkdown } from '../src/shared/importing/plainTextToMarkdown';
import {
  canFormat,
  composeBody,
  decodeText,
  kindOf,
  MAX_TEXT_BYTES,
  prepareImport,
  type ImportFile,
  type ImportPlatform,
} from '../src/shared/importing/prepareImport';
import { readZip, ZipFormatError, ZipTooLargeError } from '../src/shared/importing/zip';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';

const md = (text: string, reflow = false) => plainTextToMarkdown(text, reflow);

// Ported from Android's PlainTextToMarkdownTest.
describe('plainTextToMarkdown', () => {
  it('turns lines into paragraphs and bullets into lists', () => {
    const text = "Shopping for the weekend trip\r\n• Milk\r\n• Bread\r\n   ◦ Rye\r\nThat's all.";
    expect(md(text)).toBe("Shopping for the weekend trip\n\n- Milk\n- Bread\n    - Rye\n\nThat's all.\n");
  });

  it('converts numbered and task lines', () => {
    expect(md('1) First\n2) Second\n☐ Todo\n☑ Done')).toBe('1. First\n2. Second\n- [ ] Todo\n- [x] Done\n');
  });

  it('turns standalone title lines into headings', () => {
    const text =
      'Meeting Notes\n\nWe discussed the roadmap for the next quarter.\n\n' +
      'ACTION ITEMS\n\n- Send the summary\n\n2.1 Budget Review\n\nNumbers were fine overall.';
    expect(md(text)).toBe(
      '# Meeting Notes\n\nWe discussed the roadmap for the next quarter.\n\n## ACTION ITEMS\n\n' +
        '- Send the summary\n\n### 2.1 Budget Review\n\nNumbers were fine overall.\n',
    );
  });

  it('does not turn sentences and greetings into headings', () => {
    expect(md('Hi there\n\nThanks\n\nJohn')).toBe('Hi there\n\nThanks\n\nJohn\n');
    expect(md('This is a sentence.\n\nAnother one follows here.')).toBe(
      'This is a sentence.\n\nAnother one follows here.\n',
    );
  });

  it('converts setext headings', () => {
    expect(md('Title\n=====\n\nPart\n----\n\nBody')).toBe('# Title\n\n## Part\n\nBody\n');
  });

  it('joins hard-wrapped paragraphs', () => {
    const text =
      'This paragraph was wrapped at a fixed width by the\n' +
      'program that produced it, so every line is about the\n' +
      'same length and the sentences continue on the next\n' +
      'line until the end.\n\n' +
      'A second paragraph that is also wrapped by the same\n' +
      'tool and hyphen-\n' +
      'ates a word at the end of a line.';
    expect(md(text)).toBe(
      'This paragraph was wrapped at a fixed width by the program that produced it, so every line is ' +
        'about the same length and the sentences continue on the next line until the end.\n\n' +
        'A second paragraph that is also wrapped by the same tool and hyphenates a word at the end ' +
        'of a line.\n',
    );
  });

  it('joins PDF lines when reflowing', () => {
    expect(md('Short line\njoined with the next.', true)).toBe('Short line joined with the next.\n');
  });

  it('turns indented blocks into code', () => {
    expect(md('Run this:\n\n    npm install\n      npm test')).toBe(
      'Run this:\n\n```\nnpm install\n  npm test\n```\n',
    );
  });

  it('links addresses and escapes Markdown characters', () => {
    expect(md('See https://example.com/a_(b), www.x.io and *stars* or file_name.')).toBe(
      'See <https://example.com/a_(b)>, [www.x.io](https://www.x.io) and \\*stars\\* or file_name.\n',
    );
  });

  it('keeps Markdown as it is', () => {
    const text = '# Title\n\nSome **bold** and a [link](https://x.io).\n';
    expect(looksLikeMarkdown(text)).toBe(true);
    expect(md(text)).toBe(text);
    expect(looksLikeMarkdown('Just text with #hashtag and 3 * 4')).toBe(false);
  });
});

// Ported from Android's ImportConverterTest (the HTML cases run in the Electron end-to-end tests).
describe('convertImport', () => {
  it('keeps text as it is without auto-format', async () => {
    const text = '• Milk\r\nURGENT\n\n*not emphasis*';
    expect(await convertImport({ kind: 'text', text }, false, NO_IMAGES)).toBe(
      '• Milk\nURGENT\n\n*not emphasis*\n',
    );
  });

  it('does not reformat Markdown files', async () => {
    const text = 'Line one\nLine two\n';
    expect(await convertImport({ kind: 'markdown', text }, true, NO_IMAGES)).toBe(text);
  });

  it('suggests a title from the subject, a heading, the file name or the first line', () => {
    expect(suggestTitle('# Heading', 'file.docx', 'Shared page')).toBe('Shared page');
    expect(suggestTitle('Intro\n\n## My **Report**', 'file.docx')).toBe('My Report');
    expect(suggestTitle('Body', 'quarterly-plan.pdf')).toBe('quarterly-plan');
    expect(suggestTitle('This is the first line of a rather long text that keeps going on and on')).toBe(
      'This is the first line of a rather long text that keeps',
    );
    expect(suggestTitle('[Link text](https://x.io) more')).toBe('Link text more');
    expect(suggestTitle('  \n')).toBe(DEFAULT_TITLE);
  });

  it('sanitizes titles', () => {
    expect(sanitizeTitle('a/b\\c: d')).toBe('a b c d');
    expect(sanitizeTitle('..notes.md')).toBe('notes');
    expect(sanitizeTitle('x'.repeat(200))).toBe('x'.repeat(80));
  });
});

describe('kindOf', () => {
  it('classifies by MIME type, then by extension', () => {
    expect(kindOf('application/pdf', 'a')).toBe('pdf');
    expect(kindOf('', 'Report.PDF')).toBe('pdf');
    expect(kindOf('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'x')).toBe(
      'docx',
    );
    expect(kindOf('', 'letter.docx')).toBe('docx');
    expect(kindOf('image/png', 'x')).toBe('image');
    expect(kindOf(null, 'photo.jpeg')).toBe('image');
    expect(kindOf('text/html; charset=utf-8', 'x')).toBe('html');
    expect(kindOf('', 'page.htm')).toBe('html');
    expect(kindOf('text/markdown', 'x')).toBe('markdown');
    expect(kindOf('', 'readme.md')).toBe('markdown');
    expect(kindOf('text/csv', 'x.csv')).toBe('text');
    expect(kindOf('', 'notes.txt')).toBe('text');
    expect(kindOf('application/zip', 'archive.zip')).toBe('unsupported');
    expect(kindOf('', 'document.doc')).toBe('unsupported');
  });
});

describe('decodeText', () => {
  it('decodes UTF-8 and UTF-16 with a byte order mark, and falls back to Windows-1252', () => {
    expect(decodeText(new TextEncoder().encode('\uFEFFcafé'))).toBe('café');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0xe9, 0x00]))).toBe('hé');
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0xe9]))).toBe('hé');
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80]))).toBe('café €');
  });
});

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A ZIP archive with the given entries, deflated unless `stored`. */
async function zip(entries: Record<string, string | Uint8Array>, stored = false): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const [name, value] of Object.entries(entries)) {
    const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    const compressed = stored ? data : await deflateRaw(data);
    const fileName = new TextEncoder().encode(name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(8, stored ? 0 : 8, true);
    local.setUint32(18, compressed.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, fileName.length, true);
    parts.push(new Uint8Array(local.buffer), fileName, compressed);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(10, stored ? 0 : 8, true);
    central.setUint32(20, compressed.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, fileName.length, true);
    central.setUint32(42, offset, true);
    directory.push(new Uint8Array(central.buffer), fileName);
    offset += 30 + fileName.length + compressed.length;
  }
  const size = directory.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, directory.length / 2, true);
  end.setUint16(10, directory.length / 2, true);
  end.setUint32(12, size, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...directory, new Uint8Array(end.buffer)];
  const result = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of all) {
    result.set(p, at);
    at += p.length;
  }
  return result;
}

describe('readZip', () => {
  it('reads stored and deflated entries, keeping only the accepted ones', async () => {
    const text = 'Hello '.repeat(100);
    for (const stored of [false, true]) {
      const entries = await readZip(
        await zip(
          { 'word/document.xml': text, 'word/media/a.png': new Uint8Array([1, 2]), 'other.bin': 'x' },
          stored,
        ),
        (name) => name.startsWith('word/'),
        { entry: 1024 * 1024, total: 1024 * 1024 },
      );
      expect([...entries.keys()].sort()).toEqual(['word/document.xml', 'word/media/a.png']);
      expect(new TextDecoder().decode(entries.get('word/document.xml'))).toBe(text);
      expect([...entries.get('word/media/a.png')!]).toEqual([1, 2]);
    }
  });

  it('rejects files that are not archives and archives that expand too much', async () => {
    await expect(
      readZip(new TextEncoder().encode('not a zip'), () => true, { entry: 10, total: 10 }),
    ).rejects.toThrow(ZipFormatError);
    const big = await zip({ 'a.txt': 'a'.repeat(5000) });
    await expect(readZip(big, () => true, { entry: 1000, total: 10_000 })).rejects.toThrow(ZipTooLargeError);
    const many = await zip({ 'a.txt': 'a'.repeat(600), 'b.txt': 'b'.repeat(600) });
    await expect(readZip(many, () => true, { entry: 1000, total: 1000 })).rejects.toThrow(ZipTooLargeError);
  });
});

const file = (name: string, type: string, content: string | Uint8Array): ImportFile => {
  const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content;
  return {
    name,
    type,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.slice().buffer,
  };
};

const platform = (pdf = 'PDF text'): ImportPlatform => ({
  pdfText: async () => pdf,
  stageImage: async (f) => {
    if (f.name.startsWith('bad')) throw new Error('unreadable');
    return attachmentPath(await sha256Hex(new Uint8Array(await f.arrayBuffer())), 'png');
  },
});

describe('prepareImport', () => {
  it('reads one document with its images and composes the note body', async () => {
    const prepared = await prepareImport(
      [
        file('photo.png', 'image/png', 'p1'),
        file('Trip.txt', 'text/plain', 'Day one\n• Beach'),
        file('bad.png', 'image/png', 'x'),
      ],
      null,
      platform(),
    );
    expect(prepared.fileName).toBe('Trip.txt');
    expect(prepared.skippedImages).toBe(1);
    expect(canFormat(prepared)).toBe(true);
    const path = attachmentPath(await sha256Hex(new TextEncoder().encode('p1')), 'png');
    expect(await composeBody(prepared, true, NO_IMAGES)).toBe(`Day one\n\n- Beach\n\n![photo](${path})\n`);
    expect(await composeBody(prepared, false, NO_IMAGES)).toBe(`Day one\n• Beach\n\n![photo](${path})\n`);
  });

  it('imports images alone, and Markdown files without formatting', async () => {
    const images = await prepareImport([file('a.png', '', 'a')], null, platform());
    expect(images.source).toBeNull();
    expect(canFormat(images)).toBe(false);
    expect(await composeBody(images, true, NO_IMAGES)).toMatch(
      /^!\[a\]\(attachments\/[0-9a-f]{64}\.png\)\n$/,
    );
    const markdown = await prepareImport([file('n.md', '', '*x*\n')], null, platform());
    expect(canFormat(markdown)).toBe(false);
    expect(await composeBody(markdown, true, NO_IMAGES)).toBe('*x*\n');
  });

  it('prefers files, then HTML, then text from the clipboard', async () => {
    expect((await prepareImport([], { html: '<b>x</b>', text: 'x' }, platform())).source).toEqual({
      kind: 'html',
      html: '<b>x</b>',
      text: 'x',
    });
    expect((await prepareImport([], { html: '', text: 'plain' }, platform())).source).toEqual({
      kind: 'text',
      text: 'plain',
    });
  });

  it('reads PDF text reflowed and reports PDFs without text', async () => {
    const prepared = await prepareImport([file('r.pdf', 'application/pdf', '%PDF')], null, platform('A\nB'));
    expect(prepared.source).toEqual({ kind: 'text', text: 'A\nB', reflow: true });
    await expect(
      prepareImport([file('s.pdf', 'application/pdf', '%PDF')], null, platform(' \n')),
    ).rejects.toThrow('This PDF has no text to import (it may be a scanned image).');
  });

  it('reports what cannot be imported', async () => {
    const reject = (files: ImportFile[], message: string) =>
      expect(prepareImport(files, null, platform())).rejects.toThrow(new ImportError(message));
    await reject(
      [file('a.zip', 'application/zip', 'x')],
      'MarkNotes can import text, HTML, Markdown, Word (.docx) and PDF files.',
    );
    await reject([file('a.txt', '', 'a'), file('b.txt', '', 'b')], 'Import one document at a time.');
    await reject([], 'Nothing to import.');
    await reject([file('bad.png', 'image/png', 'x')], 'The images could not be read.');
    await reject(
      [{ ...file('big.txt', '', ''), size: MAX_TEXT_BYTES + 1 }],
      'This file is too large to import (the limit is 5 MB).',
    );
  });
});

describe('NoteStore.importNote', () => {
  it('saves the note with a fresh id and its images, naming it uniquely', async () => {
    const backend = new MemoryNodeBackend();
    const store = new NoteStore(backend);
    await store.createChildFolder('', 'Inbox');
    await store.createNote('Inbox', 'Trip');
    const bytes = new Uint8Array([1, 2, 3]);
    const image = attachmentPath(await sha256Hex(bytes), 'png');
    const path = await store.importNote('Inbox', 'Trip', `Body\n\n![a](${image})\n`, [
      { path: image, bytes },
    ]);
    expect(path).toBe('Inbox/Trip 2.md');
    const { frontMatter, body } = splitFrontMatter(await store.read(path));
    expect(frontMatter).toMatch(/^---\nid: \S+\n---\n$/);
    expect(body).toBe(`Body\n\n![a](${image})\n`);
    expect([...(await store.readBytes(image))]).toEqual([1, 2, 3]);
    expect(await store.isFolder('attachments')).toBe(true);
    expect(await store.importNote('', 'Trip.md', 'x\n', [{ path: image, bytes }])).toBe('Trip.md');
  });

  it('rejects images that do not match their path and missing folders', async () => {
    const store = new NoteStore(new MemoryNodeBackend());
    const image = attachmentPath('0'.repeat(64), 'png');
    await expect(
      store.importNote('', 'Note', 'x', [{ path: image, bytes: new Uint8Array([1]) }]),
    ).rejects.toThrow('Invalid imported image');
    await expect(store.importNote('Missing', 'Note', 'x', [])).rejects.toThrow('does not exist');
    await expect(store.importNote('attachments', 'Note', 'x', [])).rejects.toThrow('reserved');
    expect(await store.listAll()).toEqual([]);
  });
});
