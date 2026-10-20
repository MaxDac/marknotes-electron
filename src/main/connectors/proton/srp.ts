import { createHash, randomBytes } from 'node:crypto';
import bcryptjs from 'bcryptjs';

/**
 * Proton's SRP-6a variant (auth versions 3 and 4), ported from the Android app (itself ported from the
 * MIT-licensed ProtonMail/go-srp library). All big integers are encoded little-endian over 256 bytes.
 */
export const SRP_BIT_LENGTH = 2048;
export const SRP_BYTE_LENGTH = SRP_BIT_LENGTH / 8;
const GENERATOR = 2n;

export interface SrpProofs {
  clientEphemeral: Uint8Array;
  clientProof: Uint8Array;
  expectedServerProof: Uint8Array;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function expandHash(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(64 * 4);
  for (let i = 0; i < 4; i++) {
    const digest = createHash('sha512').update(data).update(Uint8Array.of(i)).digest();
    out.set(digest, i * 64);
  }
  return out;
}

export function toBigInt(littleEndian: Uint8Array): bigint {
  let value = 0n;
  for (let i = littleEndian.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(littleEndian[i]);
  return value;
}

export function fromBigInt(value: bigint, length = SRP_BYTE_LENGTH): Uint8Array {
  const out = new Uint8Array(length);
  let v = value;
  for (let i = 0; i < length && v > 0n; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= 1n;
  }
  return result;
}

const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;

function bitLength(value: bigint): number {
  return value === 0n ? 0 : value.toString(2).length;
}

export function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64'));
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/**
 * Extracts the base64 modulus from the PGP clear-signed message returned by the API.
 * Note: the PGP signature is not verified (same as the Android app).
 */
export function decodeModulus(signedModulus: string): Uint8Array {
  const lines = signedModulus.replace(/\r\n/g, '\n').split('\n');
  const begin = lines.findIndex((l) => l.startsWith('-----BEGIN PGP SIGNED MESSAGE-----'));
  const end = lines.findIndex((l) => l.startsWith('-----BEGIN PGP SIGNATURE-----'));
  let body: string;
  if (begin >= 0 && end > begin) {
    const inner = lines.slice(begin + 1, end);
    const firstBlank = inner.findIndex((l) => l.trim() === '');
    body = (firstBlank >= 0 ? inner.slice(firstBlank) : []).map((l) => l.trim()).join('');
  } else {
    body = signedModulus.trim();
  }
  const bytes = decodeBase64(body);
  if (bytes.length !== SRP_BYTE_LENGTH) throw new Error(`Unexpected modulus size ${bytes.length}`);
  return bytes;
}

/** Returns the 60-character "$2y$10$..." bcrypt string for `salt` (16 bytes). */
export async function bcrypt(password: string, salt: Uint8Array): Promise<string> {
  if (salt.length !== 16) throw new Error(`Unexpected bcrypt salt size ${salt.length}`);
  // bcryptjs doesn't accept the "$2y$" prefix; "$2a$" computes the same hash.
  const hash = await bcryptjs.hash(password, `$2a$10$${bcryptjs.encodeBase64(Array.from(salt), 16)}`);
  return `$2y$${hash.slice(4)}`;
}

/** Hashes the password for auth versions 3 and 4. `salt` is the base64 salt from auth/info. */
export async function hashPassword(
  version: number,
  password: string,
  salt: string,
  modulus: Uint8Array,
): Promise<Uint8Array> {
  if (version !== 3 && version !== 4) throw new Error(`Unsupported auth version ${version}`);
  const decodedSalt = decodeBase64(salt);
  const bcryptSalt = concatBytes(decodedSalt, new TextEncoder().encode('proton'));
  if (bcryptSalt.length !== 16) throw new Error(`Unexpected salt size ${decodedSalt.length}`);
  const crypted = new TextEncoder().encode(await bcrypt(password, bcryptSalt));
  return expandHash(concatBytes(crypted, modulus));
}

/** The passphrase used to unlock the user's private keys (go-srp MailboxPassword). */
export async function mailboxPassword(password: string, keySalt: string): Promise<string> {
  const salt = decodeBase64(keySalt);
  if (salt.length !== 16) throw new Error(`Unexpected key salt size ${salt.length}`);
  return (await bcrypt(password, salt)).slice(-31);
}

function randomBigInt(bits: number): bigint {
  const bytes = randomBytes(bits / 8);
  return toBigInt(bytes);
}

export function generateProofs(
  modulusBytes: Uint8Array,
  serverEphemeralBytes: Uint8Array,
  hashedPassword: Uint8Array,
  random: (bits: number) => bigint = randomBigInt,
): SrpProofs {
  const modulus = toBigInt(modulusBytes);
  if (bitLength(modulus) !== SRP_BIT_LENGTH) throw new Error('Invalid modulus');
  const modulusMinusOne = modulus - 1n;
  const serverEphemeral = toBigInt(serverEphemeralBytes);
  const multiplier = mod(toBigInt(expandHash(concatBytes(fromBigInt(GENERATOR), modulusBytes))), modulus);

  if (!(multiplier > 1n && multiplier < modulusMinusOne)) throw new Error('Invalid SRP multiplier');
  if (!(serverEphemeral > 1n && serverEphemeral < modulusMinusOne)) {
    throw new Error('Invalid server ephemeral');
  }

  const hashedPasswordInt = toBigInt(hashedPassword);
  const minSecret = BigInt(SRP_BIT_LENGTH * 2);
  let clientSecret: bigint;
  let clientEphemeral: bigint;
  let scramblingParam: bigint;
  do {
    do {
      clientSecret = random(SRP_BIT_LENGTH);
    } while (clientSecret <= minSecret || clientSecret >= modulusMinusOne);
    clientEphemeral = modPow(GENERATOR, clientSecret, modulus);
    scramblingParam = toBigInt(expandHash(concatBytes(fromBigInt(clientEphemeral), serverEphemeralBytes)));
  } while (scramblingParam === 0n);

  const subtracted = mod(
    serverEphemeral - mod(modPow(GENERATOR, hashedPasswordInt, modulus) * multiplier, modulus),
    modulus,
  );
  const exponent = mod(scramblingParam * hashedPasswordInt + clientSecret, modulusMinusOne);
  const sharedSession = modPow(subtracted, exponent, modulus);

  const clientEphemeralBytes = fromBigInt(clientEphemeral);
  const sharedSessionBytes = fromBigInt(sharedSession);
  const clientProof = expandHash(concatBytes(clientEphemeralBytes, serverEphemeralBytes, sharedSessionBytes));
  const expectedServerProof = expandHash(concatBytes(clientEphemeralBytes, clientProof, sharedSessionBytes));
  return { clientEphemeral: clientEphemeralBytes, clientProof, expectedServerProof };
}

export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
