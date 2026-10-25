import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarkNotesApi, RemoteOp, Result } from '../src/preload/api';
import { IpcRemoteDriveStore, unwrap } from '../src/renderer/src/data/api';
import { installDiagnosticHandlers, recordDiagnostic } from '../src/renderer/src/data/diagnostics';
import { IMPORT_ACCEPT, ImportStaging } from '../src/renderer/src/data/documentImport';
import { attachmentUrl, imageFiles, importImage } from '../src/renderer/src/data/images';
import { MAX_ATTACHMENT_BYTES } from '../src/shared/attachments';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';
import { SyncFailureError } from '../src/shared/syncFailure';
import type { RemoteEntry } from '../src/shared/types';

const ok = <T>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value });
const setApi = (api: Partial<MarkNotesApi>) => vi.stubGlobal('window', { marknotes: api });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IPC results', () => {
  it('unwraps values and rethrows errors with their failure class', async () => {
    expect(await unwrap(ok(42))).toBe(42);
    const retryable = unwrap(
      Promise.resolve({ ok: false, error: 'busy', failure: { kind: 'retryable' } } as Result<never>),
    );
    await expect(retryable).rejects.toThrow(SyncFailureError);
    await expect(retryable).rejects.toMatchObject({ message: 'busy', failure: { kind: 'retryable' } });
    // Errors without a classification are permanent: they are never retried automatically.
    await expect(unwrap(Promise.resolve({ ok: false, error: 'no' } as Result<never>))).rejects.toMatchObject({
      failure: { kind: 'permanent' },
    });
  });

  it('forwards every remote drive operation to the main process', async () => {
    const calls: [string, RemoteOp][] = [];
    setApi({
      remote: (driveId, op) => {
        calls.push([driveId, op]);
        return ok(op.op);
      },
    });
    const entry = { path: 'a.md', id: '1' } as unknown as RemoteEntry;
    const bytes = new Uint8Array([1]);
    const store = new IpcRemoteDriveStore('d1', 'dropbox');
    const results = [
      await store.snapshot(),
      await store.download(entry),
      await store.uploadNew('b.md', bytes, 5),
      await store.uploadRevision(entry, bytes, 6),
      await store.createFolder('f'),
      await store.delete(entry),
      await store.rename(entry, 'c.md'),
      await store.readManifest(),
      await store.writeManifest(bytes),
    ];
    expect(results).toEqual([
      'snapshot',
      'download',
      'uploadNew',
      'uploadRevision',
      'createFolder',
      'delete',
      'rename',
      'readManifest',
      'writeManifest',
    ]);
    expect(calls).toEqual([
      ['d1', { op: 'snapshot' }],
      ['d1', { op: 'download', entry }],
      ['d1', { op: 'uploadNew', path: 'b.md', bytes, modifiedMillis: 5 }],
      ['d1', { op: 'uploadRevision', entry, bytes, modifiedMillis: 6 }],
      ['d1', { op: 'createFolder', path: 'f' }],
      ['d1', { op: 'delete', entry }],
      ['d1', { op: 'rename', entry, toPath: 'c.md' }],
      ['d1', { op: 'readManifest' }],
      ['d1', { op: 'writeManifest', bytes }],
    ]);
  });

  it('describes each provider: case-only renames, timestamp resolution and folder deletion', () => {
    expect(new IpcRemoteDriveStore('d', 'onedrive')).toMatchObject({
      supportsCaseOnlyRename: true,
      timestampResolutionMillis: 1,
      remoteFolderDeletion: 'unsupported',
    });
    expect(new IpcRemoteDriveStore('d', 'dropbox')).toMatchObject({
      supportsCaseOnlyRename: false,
      timestampResolutionMillis: 1000,
    });
    expect(new IpcRemoteDriveStore('d')).toMatchObject({
      supportsCaseOnlyRename: false,
      timestampResolutionMillis: 1,
      remoteFolderDeletion: undefined,
    });
  });
});

describe('renderer diagnostics', () => {
  let body: { id: string; textContent: string; attributes: Record<string, string> }[];

  beforeEach(() => {
    body = [];
    vi.stubGlobal('document', {
      getElementById: (id: string) => body.find((e) => e.id === id) ?? null,
      createElement: () => ({
        id: '',
        className: '',
        textContent: '',
        attributes: {} as Record<string, string>,
        setAttribute(name: string, value: string) {
          this.attributes[name] = value;
        },
      }),
      body: { prepend: (e: (typeof body)[number]) => body.unshift(e) },
    });
  });

  const alerts = () => body.filter((e) => e.id === 'diagnostics-unavailable');

  it('records a code and shows nothing when it is saved', async () => {
    const recordDiagnosticCall = vi.fn(() => ok(undefined));
    setApi({ recordDiagnostic: recordDiagnosticCall });
    recordDiagnostic('UI_FAILED');
    await vi.waitFor(() => expect(recordDiagnosticCall).toHaveBeenCalledWith('UI_FAILED'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(alerts()).toEqual([]);
  });

  it('shows a single alert, without sending anything, when diagnostics cannot be saved', async () => {
    setApi({ recordDiagnostic: () => Promise.resolve({ ok: false, error: 'disk full' }) });
    recordDiagnostic('UI_FAILED');
    await vi.waitFor(() => expect(alerts()).toHaveLength(1));
    setApi({ recordDiagnostic: () => Promise.reject(new Error('IPC closed')) });
    recordDiagnostic('SAVE_FAILED');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({
      textContent: 'Could not save local diagnostics. No report was sent.',
      attributes: { role: 'alert' },
    });
  });

  it('records uncaught errors and unhandled rejections without their details', async () => {
    const handlers = new Map<string, () => void>();
    const recorded: string[] = [];
    vi.stubGlobal('window', {
      marknotes: {
        recordDiagnostic: (code: string) => {
          recorded.push(code);
          return ok(undefined);
        },
      },
      addEventListener: (type: string, handler: () => void) => handlers.set(type, handler),
    });
    installDiagnosticHandlers();
    handlers.get('error')!();
    handlers.get('unhandledrejection')!();
    expect(recorded).toEqual(['RENDERER_UNCAUGHT', 'RENDERER_REJECTION']);
  });
});

/** A fake image decoder and canvas: `createImageBitmap` reports `size`, `convertToBlob` returns `encoded`. */
function stubImageApis(size: { width: number; height: number }, encoded?: (type: string) => Blob) {
  const drawn: { width: number; height: number }[] = [];
  const closed = vi.fn();
  vi.stubGlobal('createImageBitmap', async (file: Blob) => {
    if (file.size === 0) throw new Error('decode failed');
    return { ...size, close: closed };
  });
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return { drawImage: () => drawn.push({ width: this.width, height: this.height }) };
      }
      async convertToBlob(options: { type: string; quality?: number }) {
        return encoded ? encoded(options.type) : new Blob([new Uint8Array([9, 9])], options);
      }
    },
  );
  return { drawn, closed };
}

const image = (type: string, bytes = new Uint8Array([1, 2, 3]), name = 'pic') =>
  new File([bytes], name, { type });

describe('image import', () => {
  let notes: NoteStore;
  beforeEach(() => {
    notes = new NoteStore(new MemoryNodeBackend());
  });

  it('keeps small images and GIFs unchanged', async () => {
    const { drawn, closed } = stubImageApis({ width: 100, height: 50 });
    const png = await importImage(notes, image('image/png'));
    expect(png).toMatch(/^attachments\/[0-9a-f]+\.png$/);
    expect(await notes.readBytes(png)).toEqual(new Uint8Array([1, 2, 3]));
    expect(closed).toHaveBeenCalledOnce();
    const gif = await importImage(notes, image('image/gif', new Uint8Array([4])));
    expect(await notes.readBytes(gif)).toEqual(new Uint8Array([4]));
    expect(drawn).toEqual([]);
  });

  it('downscales large images to 2048 px on their longest side, in their own format', async () => {
    const { drawn } = stubImageApis({ width: 4096, height: 1024 });
    const path = await importImage(notes, image('image/jpeg'));
    expect(drawn).toEqual([{ width: 2048, height: 512 }]);
    expect(path).toMatch(/\.jpg$/);
    expect(await notes.readBytes(path)).toEqual(new Uint8Array([9, 9]));
  });

  it('keeps the original bytes when the canvas cannot encode the format', async () => {
    stubImageApis(
      { width: 4096, height: 4096 },
      () => new Blob([new Uint8Array([7])], { type: 'image/png' }),
    );
    const path = await importImage(notes, image('image/webp'));
    expect(path).toMatch(/\.webp$/);
    expect(await notes.readBytes(path)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects unsupported, unreadable and oversized images with a readable message', async () => {
    stubImageApis({ width: 10, height: 10 });
    await expect(importImage(notes, image('image/bmp', undefined, 'scan.bmp'))).rejects.toThrow(
      'scan.bmp is not a supported image (PNG, JPEG, GIF or WebP)',
    );
    await expect(importImage(notes, image('image/svg+xml', undefined, ''))).rejects.toThrow(
      'This file is not a supported image',
    );
    await expect(importImage(notes, image('image/png', new Uint8Array(), 'empty.png'))).rejects.toThrow(
      'empty.png could not be read',
    );
    await expect(
      importImage(notes, image('image/gif', new Uint8Array(MAX_ATTACHMENT_BYTES + 1), 'big.gif')),
    ).rejects.toThrow('big.gif is too large: images must be at most 10 MB');
    expect(await notes.list('attachments').catch(() => [])).toEqual([]);
  });

  it('picks the images among pasted or dropped files', () => {
    const files = [image('image/png'), new File(['x'], 'a.txt', { type: 'text/plain' }), image('image/gif')];
    expect(imageFiles(files as unknown as FileList)).toEqual([files[0], files[2]]);
    expect(imageFiles(null)).toEqual([]);
    expect(imageFiles(undefined)).toEqual([]);
  });

  it('reads an attachment once and reuses its object URL', async () => {
    await notes.writeBytes('attachments/x.png', new Uint8Array([1]));
    const read = vi.spyOn(notes, 'readBytes');
    const createObjectURL = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', { createObjectURL });
    expect(await attachmentUrl(notes, 'attachments/x.png', 'image/png')).toBe('blob:x');
    expect(await attachmentUrl(notes, 'attachments/x.png', 'image/png')).toBe('blob:x');
    expect(read).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledOnce();
  });
});

describe('import staging', () => {
  it('offers the supported document and image types', () => {
    for (const type of ['.md', '.docx', '.pdf', '.html', '.webp', 'text/plain', 'application/pdf']) {
      expect(IMPORT_ACCEPT.split(',')).toContain(type);
    }
  });

  it('stages images in memory, recognizing files without a type by their extension', async () => {
    stubImageApis({ width: 10, height: 10 });
    const staging = new ImportStaging();
    const typed = await staging.platform.stageImage(image('image/png', new Uint8Array([1]), 'a.png'));
    const untyped = await staging.platform.stageImage({
      name: 'photo.JPEG',
      type: '',
      size: 1,
      arrayBuffer: async () => new Uint8Array([2]).buffer,
    } as unknown as File);
    expect(typed).toMatch(/\.png$/);
    expect(untyped).toMatch(/\.jpg$/);
    await expect(
      staging.platform.stageImage({
        name: 'noextension',
        type: '',
        size: 1,
        arrayBuffer: async () => new Uint8Array([3]).buffer,
      } as unknown as File),
    ).rejects.toThrow('noextension is not a supported image');
    expect(await staging.images([typed, 'attachments/missing.png', untyped])).toEqual([
      { path: typed, bytes: new Uint8Array([1]) },
      { path: untyped, bytes: new Uint8Array([2]) },
    ]);
  });

  it('stages embedded document images, skipping unsupported or unreadable ones', async () => {
    stubImageApis({ width: 10, height: 10 });
    const staging = new ImportStaging();
    const path = await staging.sink(new Uint8Array([5]), 'gif', 'image1.gif');
    expect(path).toMatch(/\.gif$/);
    expect(await staging.sink(new Uint8Array([5]), 'emf', 'image2.emf')).toBeNull();
    expect(await staging.sink(new Uint8Array(), 'png', 'image3.png')).toBeNull();
    expect(await staging.images([path!])).toEqual([{ path, bytes: new Uint8Array([5]) }]);
  });
});
