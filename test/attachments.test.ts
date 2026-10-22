import { beforeEach, describe, expect, it } from 'vitest';
import {
  attachmentFromSrc,
  attachmentRefs,
  cleanUnusedAttachments,
  extensionForType,
  imageMarkdown,
  isAttachmentPath,
  MAX_ATTACHMENT_BYTES,
  saveAttachment,
  scaledSize,
  typeForPath,
  unusedAttachments,
} from '../src/shared/attachments';
import { sha256Hex } from '../src/shared/hashing';
import { MemoryNodeBackend, NoteStore } from '../src/shared/noteStore';

const hash = (c: string) => c.repeat(64);

describe('attachments', () => {
  let store: NoteStore;
  beforeEach(() => {
    store = new NoteStore(new MemoryNodeBackend());
  });

  it('maps MIME types to extensions', () => {
    expect(extensionForType('image/png')).toBe('png');
    expect(extensionForType('image/JPEG')).toBe('jpg');
    expect(extensionForType('image/gif')).toBe('gif');
    expect(extensionForType('image/webp')).toBe('webp');
    expect(extensionForType('image/svg+xml')).toBeNull();
    expect(typeForPath(`attachments/${hash('a')}.jpg`)).toBe('image/jpeg');
  });

  it('recognizes attachment paths', () => {
    expect(isAttachmentPath(`attachments/${hash('a')}.png`)).toBe(true);
    expect(isAttachmentPath(`attachments/${hash('a')}.svg`)).toBe(false);
    expect(isAttachmentPath(`attachments/photo.png`)).toBe(false);
    expect(isAttachmentPath(`notes/attachments/${hash('a')}.png`)).toBe(false);
    expect(attachmentFromSrc(`./attachments/${hash('b')}.gif`)).toBe(`attachments/${hash('b')}.gif`);
    expect(attachmentFromSrc(`/attachments/${hash('b')}.gif`)).toBe(`attachments/${hash('b')}.gif`);
    expect(attachmentFromSrc('https://example.com/a.png')).toBeNull();
  });

  it('builds image markdown from the file name', () => {
    expect(imageMarkdown('Screen shot.png', 'attachments/x.png')).toBe('![Screen shot](attachments/x.png)');
    expect(imageMarkdown('a[1].jpg', 'attachments/x.jpg')).toBe('![a 1](attachments/x.jpg)');
  });

  it('saves attachments named after their hash, once', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const path = await saveAttachment(store, bytes, 'image/png');
    expect(path).toBe(`attachments/${await sha256Hex(bytes)}.png`);
    expect(await store.readBytes(path)).toEqual(bytes);
    expect(await saveAttachment(store, bytes, 'image/png')).toBe(path);
    await expect(saveAttachment(store, bytes, 'image/bmp')).rejects.toThrow('Only PNG');
    await expect(
      saveAttachment(store, new Uint8Array(MAX_ATTACHMENT_BYTES + 1), 'image/png'),
    ).rejects.toThrow('at most 10 MB');
  });

  it('finds references and cleans unused attachments', async () => {
    const used = `attachments/${hash('a')}.png`;
    const unused = `attachments/${hash('b')}.jpg`;
    await store.writeBytes(used, new Uint8Array([1]));
    await store.writeBytes(unused, new Uint8Array([2]));
    await store.write('deep/n.md', `text ![x](${used}) more`);
    expect(attachmentRefs(`![x](${used}) ![y](./${unused})`)).toEqual(new Set([used, unused]));
    expect(await unusedAttachments(store)).toEqual([unused]);
    expect(await cleanUnusedAttachments(store)).toBe(1);
    expect(await store.exists(unused)).toBe(false);
    expect(await store.exists(used)).toBe(true);
  });

  it('scales the longest side down to 2048 px', () => {
    expect(scaledSize(1000, 500)).toEqual({ width: 1000, height: 500, scaled: false });
    expect(scaledSize(4096, 1024)).toEqual({ width: 2048, height: 512, scaled: true });
    expect(scaledSize(1000, 3000)).toEqual({ width: 683, height: 2048, scaled: true });
  });
});
