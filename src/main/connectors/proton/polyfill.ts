/**
 * Polyfills the TC39 Uint8Array base64/hex methods used by the Proton Drive SDK. Electron's V8 has them,
 * Node (used by the tests) may not. Must be imported before the SDK runs.
 */
type Alphabet = 'base64' | 'base64url';

interface Base64Options {
  alphabet?: Alphabet;
  omitPadding?: boolean;
}

const ctor = Uint8Array as unknown as Record<string, unknown>;
const proto = Uint8Array.prototype as unknown as Record<string, unknown>;

function define(target: Record<string, unknown>, name: string, value: unknown) {
  if (typeof target[name] === 'function') return;
  Object.defineProperty(target, name, { value, writable: true, configurable: true, enumerable: false });
}

define(ctor, 'fromBase64', (value: string, options?: Base64Options) => {
  if (typeof value !== 'string') throw new TypeError('fromBase64 expects a string');
  const normalized = value.replace(/[\t\n\f\r ]/g, '');
  const pattern = options?.alphabet === 'base64url' ? /^[A-Za-z0-9_-]*={0,2}$/ : /^[A-Za-z0-9+/]*={0,2}$/;
  if (!pattern.test(normalized)) throw new SyntaxError('Invalid base64 string');
  return new Uint8Array(Buffer.from(normalized, options?.alphabet === 'base64url' ? 'base64url' : 'base64'));
});

define(ctor, 'fromHex', (value: string) => {
  if (typeof value !== 'string' || value.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(value)) {
    throw new SyntaxError('Invalid hex string');
  }
  return new Uint8Array(Buffer.from(value, 'hex'));
});

define(proto, 'toBase64', function (this: Uint8Array, options?: Base64Options) {
  const buffer = Buffer.from(this.buffer, this.byteOffset, this.byteLength);
  if (options?.alphabet === 'base64url') {
    const encoded = buffer.toString('base64url');
    return options.omitPadding ? encoded : encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
  }
  const encoded = buffer.toString('base64');
  return options?.omitPadding ? encoded.replace(/=+$/, '') : encoded;
});

define(proto, 'toHex', function (this: Uint8Array) {
  return Buffer.from(this.buffer, this.byteOffset, this.byteLength).toString('hex');
});

export {};
