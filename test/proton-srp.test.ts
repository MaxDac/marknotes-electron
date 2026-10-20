import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canEncrypt, canVerify, primaryKey, ProtonKeysJson } from '../src/main/connectors/proton/keys';
import {
  bcrypt,
  concatBytes,
  decodeModulus,
  encodeBase64,
  expandHash,
  fromBigInt,
  generateProofs,
  hashPassword,
  mailboxPassword,
  modPow,
  toBigInt,
} from '../src/main/connectors/proton/srp';
import { ProtonSrpModule } from '../src/main/connectors/proton/srpModule';

const MODULUS_BASE64 =
  'W2z5HBi8RvsfYzZTS7qBaUxxPhsfHJFZpu3Kd6s1JafNrCCH9rfvPLrfuqocxWPgWDH2R8neK7PkNvjxto9TStuY5z7jAzWRvFWN9cQhAKkdWgy0JY6ywVn22+HFpF4cYesHrqFIKUPDMSSIlWjBVmEJZ/MusD44ZT29xcPrOqeZvwtCffKtGAIjLYPZIEbZKnDM1Dm3q2K/xS5h+xdhjnndhsrkwm9U9oyA2wxzSXFL+pdfj2fOdRwuR5nW0J2NFrq3kJjkRmpO/Genq1UW+TEknIWAb6VzJJJA244K/H8cnSx2+nSNZO3bbo6Ys228ruV9A8m6DhxmS+bihN3ttQ==';

const SIGNED_MODULUS = [
  '-----BEGIN PGP SIGNED MESSAGE-----',
  'Hash: SHA256',
  '',
  MODULUS_BASE64,
  '-----BEGIN PGP SIGNATURE-----',
  'Version: ProtonMail',
  'Comment: https://protonmail.com',
  '',
  'wl4EARYIABAFAlwB1j0JEDUFhcTpUY8mAAD8CgEAnsFnF4cF0uSHKkXa1GIa',
  'GO86yMV4zDZEZcDSJo0fgr8A/AlupGN9EdHlsrZLmTA1vhIx+rOgxdEff28N',
  'kvNM7qIK',
  '=q6vu',
  '-----END PGP SIGNATURE-----',
].join('\n');

const randomSalt = () => encodeBase64(randomBytes(10));

const equalBytes = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));

/** Minimal SRP server (port of the Android SrpTestFixtures) used to check client proofs. */
class SrpServer {
  readonly serverEphemeral: Uint8Array;
  private readonly n: bigint;
  private readonly v: bigint;
  private readonly b: bigint;

  constructor(modulus: Uint8Array, hashedPassword: Uint8Array) {
    this.n = toBigInt(modulus);
    const g = 2n;
    const k = toBigInt(expandHash(concatBytes(fromBigInt(g), modulus))) % this.n;
    this.v = modPow(g, toBigInt(hashedPassword), this.n);
    this.b = toBigInt(randomBytes(256)) % (this.n - 1n);
    this.serverEphemeral = fromBigInt((k * this.v + modPow(g, this.b, this.n)) % this.n);
  }

  verify(clientEphemeral: Uint8Array, clientProof: Uint8Array): Uint8Array | null {
    const u = toBigInt(expandHash(concatBytes(clientEphemeral, this.serverEphemeral)));
    const a = toBigInt(clientEphemeral);
    const s = fromBigInt(modPow((a * modPow(this.v, u, this.n)) % this.n, this.b, this.n));
    const expected = expandHash(concatBytes(clientEphemeral, this.serverEphemeral, s));
    if (!equalBytes(expected, clientProof)) return null;
    return expandHash(concatBytes(clientEphemeral, clientProof, s));
  }
}

function decodeBcryptBase64(text: string): Uint8Array {
  const alphabet = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let buffer = 0;
  let bits = 0;
  const out: number[] = [];
  for (const c of text) {
    buffer = ((buffer << 6) | alphabet.indexOf(c)) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out.slice(0, 16));
}

describe('ProtonSrp', () => {
  it('expandHash is 256 bytes', () => {
    expect(expandHash(Uint8Array.from([1, 2, 3]))).toHaveLength(256);
  });

  it('little-endian round trip', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(equalBytes(fromBigInt(toBigInt(bytes)), bytes)).toBe(true);
  });

  it('decodes the signed modulus', () => {
    const modulus = decodeModulus(SIGNED_MODULUS);
    expect(modulus).toHaveLength(256);
    expect(toBigInt(modulus).toString(2)).toHaveLength(2048);
  });

  it('bcrypt matches the go-srp vectors', async () => {
    const vectors: Record<string, string> = {
      'PTTsDBs/mlLnSk6VmtFghe': '$2y$10$PTTsDBs/mlLnSk6VmtFgheNSiK/lSwtJsrBLLDK3kZYI7193nInqy',
      '4DZHd6WZX4fEaWKtCfYdde': '$2y$10$4DZHd6WZX4fEaWKtCfYddeZfcryISo9eEMgbA90O.Wnnz1s1VKmKC',
      'RpyeXO7K2eD3r/ZZ/B63V.': '$2y$10$RpyeXO7K2eD3r/ZZ/B63V.Tya53OExbyO8LR7TB93KYP4PvC.EPMW',
    };
    for (const [encodedSalt, expected] of Object.entries(vectors)) {
      expect(await bcrypt('test!!!', decodeBcryptBase64(encodedSalt))).toBe(expected);
    }
  });

  it('client proof is accepted by the SRP server', async () => {
    const modulus = decodeModulus(SIGNED_MODULUS);
    const hashed = await hashPassword(4, 'correct horse', randomSalt(), modulus);
    const server = new SrpServer(modulus, hashed);
    const proofs = generateProofs(modulus, server.serverEphemeral, hashed);
    const serverProof = server.verify(proofs.clientEphemeral, proofs.clientProof);
    expect(serverProof).not.toBeNull();
    expect(equalBytes(proofs.expectedServerProof, serverProof!)).toBe(true);
  });

  it('wrong password is rejected by the SRP server', async () => {
    const modulus = decodeModulus(SIGNED_MODULUS);
    const salt = randomSalt();
    const server = new SrpServer(modulus, await hashPassword(4, 'right', salt, modulus));
    const wrong = await hashPassword(4, 'wrong', salt, modulus);
    const proofs = generateProofs(modulus, server.serverEphemeral, wrong);
    expect(server.verify(proofs.clientEphemeral, proofs.clientProof)).toBeNull();
  });

  it('mailbox password is 31 chars', async () => {
    const salt = encodeBase64(new Uint8Array(16).fill(7));
    expect(await mailboxPassword('secret', salt)).toHaveLength(31);
  });

  it('SDK SRP module produces proofs the server accepts', async () => {
    const modulus = decodeModulus(SIGNED_MODULUS);
    const salt = randomSalt();
    const server = new SrpServer(modulus, await hashPassword(4, 'pw', salt, modulus));
    const srp = await new ProtonSrpModule().getSrp(
      4,
      SIGNED_MODULUS,
      encodeBase64(server.serverEphemeral),
      salt,
      'pw',
    );
    const proof = server.verify(
      Buffer.from(srp.clientEphemeral, 'base64'),
      Buffer.from(srp.clientProof, 'base64'),
    );
    expect(proof && encodeBase64(proof)).toBe(srp.expectedServerProof);
    expect(Buffer.from(new ProtonSrpModule().generateKeySalt(), 'base64')).toHaveLength(16);
  });
});

describe('ProtonKeysJson', () => {
  it('parses user keys', () => {
    const keys = ProtonKeysJson.userKeys(
      JSON.parse(`{"Code":1000,"User":{"ID":"u","Keys":[
        {"ID":"k1","PrivateKey":"PK1","Primary":1,"Active":1},
        {"ID":"k2","PrivateKey":"PK2","Primary":0,"Active":0},
        {"ID":"broken"}
      ]}}`),
    );
    expect(keys).toEqual([
      { id: 'k1', privateKey: 'PK1', primary: true, active: true },
      { id: 'k2', privateKey: 'PK2', primary: false, active: false },
    ]);
  });

  it('parses addresses sorted by order', () => {
    const addresses = ProtonKeysJson.addresses(
      JSON.parse(`{"Addresses":[
        {"ID":"a2","Email":"two@proton.me","Status":0,"Order":2,"Keys":[]},
        {"ID":"a1","Email":"one@proton.me","Status":1,"Order":1,"Keys":[
          {"ID":"ak1","PrivateKey":"APK1","Token":"TOKEN","Signature":"SIG","Primary":0,"Active":1,"Flags":1},
          {"ID":"ak2","PrivateKey":"APK2","Token":null,"Primary":1,"Active":1,"Flags":3}
        ]}
      ]}`),
    );
    expect(addresses.map((a) => a.id)).toEqual(['a1', 'a2']);
    const [first, second] = addresses;
    expect(first.enabled).toBe(true);
    expect(second.enabled).toBe(false);
    expect(first.keys[0].token).toBe('TOKEN');
    expect(first.keys[1].token).toBeNull();
    expect(canVerify(first.keys[0])).toBe(true);
    expect(canEncrypt(first.keys[0])).toBe(false);
    expect(canEncrypt(first.keys[1])).toBe(true);
    expect(primaryKey(first)?.id).toBe('ak2');
  });

  it('parses public keys from both shapes', () => {
    expect(
      ProtonKeysJson.publicKeys(
        JSON.parse(`{"Address":{"Keys":[{"Flags":3,"PublicKey":"P1"}]},
          "Unverified":{"Keys":[{"Flags":3,"PublicKey":"P2"}]}}`),
      ),
    ).toEqual(['P1', 'P2']);
    expect(ProtonKeysJson.publicKeys(JSON.parse('{"Keys":[{"Flags":3,"PublicKey":"P3"}]}'))).toEqual(['P3']);
  });
});
