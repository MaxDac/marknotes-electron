/**
 * Encryption of the records stored in IndexedDB. The data key from the main process is only used through HKDF to
 * derive a non-extractable AES-256-GCM key (record contents) and an HMAC-SHA-256 key (record keys, so paths and
 * drive ids are not stored in clear).
 */
export interface DbKeys {
  enc: CryptoKey;
  mac: CryptoKey;
}

type Bytes = Uint8Array<ArrayBuffer>;

const text = new TextEncoder();
const utf8 = (s: string): Bytes => text.encode(s);

export async function deriveDbKeys(raw: Uint8Array): Promise<DbKeys> {
  const base = await crypto.subtle.importKey('raw', new Uint8Array(raw), 'HKDF', false, ['deriveKey']);
  const hkdf = (info: string) => ({
    name: 'HKDF',
    hash: 'SHA-256',
    salt: new Uint8Array(0),
    info: utf8(info),
  });
  const [enc, mac] = await Promise.all([
    crypto.subtle.deriveKey(hkdf('marknotes-idb-enc-v1'), base, { name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]),
    crypto.subtle.deriveKey(hkdf('marknotes-idb-mac-v1'), base, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]),
  ]);
  return { enc, mac };
}

const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

/** Deterministic, keyed tag of `value`: the same input always gives the same tag, without revealing it. */
export async function tag(keys: DbKeys, value: string): Promise<string> {
  return hex(await crypto.subtle.sign('HMAC', keys.mac, utf8(value)));
}

export interface Sealed {
  iv: Uint8Array;
  ct: Uint8Array;
}

export async function seal(keys: DbKeys, aad: string, value: unknown): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(aad) },
    keys.enc,
    encodeValue(value),
  );
  return { iv, ct: new Uint8Array(ct) };
}

/** Throws when the record was not encrypted with this key or was moved or tampered with. */
export async function open<T>(keys: DbKeys, aad: string, sealed: Sealed): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(sealed.iv), additionalData: utf8(aad) },
    keys.enc,
    new Uint8Array(sealed.ct),
  );
  return decodeValue(new Uint8Array(plain)) as T;
}

/**
 * Serializes a JSON-like value that may contain `Uint8Array`s: a 4-byte length, the JSON (byte arrays replaced by
 * `{"$b": [offset, length]}`), then the bytes of every array.
 */
export function encodeValue(value: unknown): Bytes {
  const blobs: Uint8Array[] = [];
  let offset = 0;
  const json = JSON.stringify(value === undefined ? null : value, (_key, v: unknown) => {
    if (v instanceof Uint8Array) {
      blobs.push(v);
      const ref = { $b: [offset, v.length] };
      offset += v.length;
      return ref;
    }
    return v;
  });
  const head = utf8(json);
  const out = new Uint8Array(4 + head.length + offset);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  let at = 4 + head.length;
  for (const blob of blobs) {
    out.set(blob, at);
    at += blob.length;
  }
  return out;
}

export function decodeValue(bytes: Uint8Array): unknown {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(0);
  const body = 4 + length;
  return JSON.parse(new TextDecoder().decode(bytes.subarray(4, body)), (_key, v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const ref = (v as { $b?: unknown }).$b;
      if (Array.isArray(ref) && Object.keys(v).length === 1) {
        const [start, size] = ref as [number, number];
        return bytes.slice(body + start, body + start + size);
      }
    }
    return v;
  });
}
