export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const utf8 = {
  encode: (text: string): Uint8Array => encoder.encode(text),
  decode: (bytes: Uint8Array): string => decoder.decode(bytes),
};
