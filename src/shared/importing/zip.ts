/**
 * A minimal reader for ZIP archives (the container of `.docx` files): stored and deflated entries, read through the
 * central directory and inflated with the platform's `DecompressionStream`, within size limits.
 */

export class ZipFormatError extends Error {}
export class ZipTooLargeError extends Error {}

export interface ZipLimits {
  /** Maximum uncompressed size of one entry. */
  entry: number;
  /** Maximum uncompressed size of all the entries read. */
  total: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const ZIP64_MARKER = 0xffffffff;

/** Reads the file entries whose (slash-trimmed) name passes `accept`. Directories are skipped. */
export async function readZip(
  bytes: Uint8Array,
  accept: (name: string) => boolean,
  limits: ZipLimits,
): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const result = new Map<string, Uint8Array>();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > view.byteLength || view.getUint32(offset, true) !== CENTRAL) throw new ZipFormatError();
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    if (offset + 46 + nameLength > view.byteLength) throw new ZipFormatError();
    const rawName = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;

    const name = rawName.replace(/^\/+/, '');
    if (name.endsWith('/') || !accept(name)) continue;
    if (flags & 1) throw new ZipFormatError(); // encrypted
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new ZipTooLargeError();
    }
    if (size > limits.entry) throw new ZipTooLargeError();

    if (localOffset + 30 > view.byteLength || view.getUint32(localOffset, true) !== LOCAL) {
      throw new ZipFormatError();
    }
    const dataStart =
      localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
    if (dataStart + compressedSize > view.byteLength) throw new ZipFormatError();
    const data = bytes.subarray(dataStart, dataStart + compressedSize);
    let content: Uint8Array;
    if (method === 0) content = data.slice();
    else if (method === 8) content = await inflate(data, limits.entry);
    else throw new ZipFormatError();
    if (content.byteLength > limits.entry) throw new ZipTooLargeError();
    total += content.byteLength;
    if (total > limits.total) throw new ZipTooLargeError();
    result.set(name, content);
  }
  return result;
}

function findEndOfCentralDirectory(view: DataView): number {
  const last = view.byteLength - EOCD_SIZE;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let i = last; i >= first; i--) {
    if (view.getUint32(i, true) === EOCD) return i;
  }
  throw new ZipFormatError();
}

async function inflate(data: Uint8Array, max: number): Promise<Uint8Array> {
  const stream = new Blob([data as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) {
        await reader.cancel().catch(() => undefined);
        throw new ZipTooLargeError();
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof ZipTooLargeError) throw e;
    throw new ZipFormatError();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}
