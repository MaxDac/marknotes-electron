import * as openpgp from 'openpgp';
import { describe, expect, it } from 'vitest';
import { ProtonAccount } from '../src/main/connectors/proton/account';
import { OpenPGPCryptoAdapter } from '../src/main/connectors/proton/openpgpCrypto';
import type { ProtonSession } from '../src/main/connectors/proton/session';
import { RemoteUnavailableError } from '../src/shared/types';

const crypto = new OpenPGPCryptoAdapter();
const bytes = (text: string) => new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('OpenPGPCryptoAdapter', { timeout: 60_000 }, () => {
  it('generates locked keys that decryptKey unlocks', async () => {
    const { privateKey, armoredKey } = await crypto.generateKey('pass', { enableAead: false });
    expect(privateKey.isDecrypted()).toBe(true);
    const unlocked = await crypto.decryptKey(armoredKey, 'pass');
    expect(unlocked.getFingerprint()).toBe(privateKey.getFingerprint());
    await expect(crypto.decryptKey(armoredKey, 'wrong')).rejects.toThrow();
  });

  it('encrypts and signs with a session key, then decrypts and verifies', async () => {
    const { privateKey } = await crypto.generateKey('p', { enableAead: false });
    const sessionKey = await crypto.generateSessionKey([privateKey], { enableAeadWithEncryptionKeys: false });
    const { encryptedData } = await crypto.encryptAndSign(bytes('hello'), sessionKey, [], privateKey, {
      enableAeadWithEncryptionKeys: false,
    });
    const { keyPacket } = await crypto.encryptSessionKey(sessionKey, privateKey);
    const decryptedKey = await crypto.decryptSessionKey(keyPacket, privateKey);
    const result = await crypto.decryptAndVerify(encryptedData, decryptedKey, privateKey);
    expect(text(result.data)).toBe('hello');
    expect(result.verified).toBe(1);
  });

  it('detached signatures with a context only verify with the same context', async () => {
    const { privateKey } = await crypto.generateKey('p', { enableAead: false });
    const { signature } = await crypto.sign(bytes('data'), privateKey, 'drive.share-member.inviter');
    expect(
      (await crypto.verify(bytes('data'), signature, privateKey, 'drive.share-member.inviter')).verified,
    ).toBe(1);
    expect((await crypto.verify(bytes('data'), signature, privateKey, 'other')).verified).toBe(2);
    expect(
      (await crypto.verify(bytes('tampered'), signature, privateKey, 'drive.share-member.inviter')).verified,
    ).toBe(2);
  });

  it('armored encrypt-and-sign round trip and wrong signer', async () => {
    const alice = (await crypto.generateKey('a', { enableAead: false })).privateKey;
    const bob = (await crypto.generateKey('b', { enableAead: false })).privateKey;
    const { armoredData } = await crypto.encryptAndSignArmored(bytes('name.md'), undefined, [alice], alice, {
      enableAeadWithEncryptionKeys: false,
    });
    const ok = await crypto.decryptArmoredAndVerify(armoredData, alice, alice);
    expect(text(ok.data)).toBe('name.md');
    expect(ok.verified).toBe(1);
    const wrong = await crypto.decryptArmoredAndVerify(armoredData, alice, bob);
    expect(wrong.verified).toBe(2);
    expect(text(await crypto.decryptArmored(armoredData, alice))).toBe('name.md');
  });

  it('detached armored variant and password-protected session keys', async () => {
    const { privateKey } = await crypto.generateKey('p', { enableAead: false });
    const sessionKey = await crypto.generateSessionKey([privateKey], { enableAeadWithEncryptionKeys: false });
    const { armoredData, armoredSignature } = await crypto.encryptAndSignDetachedArmored(
      bytes('x'),
      sessionKey,
      [privateKey],
      privateKey,
      { enableAeadWithEncryptionKeys: false },
    );
    const result = await crypto.decryptArmoredAndVerifyDetached(
      armoredData,
      armoredSignature,
      sessionKey,
      privateKey,
    );
    expect(text(result.data)).toBe('x');
    expect(result.verified).toBe(1);
    const { keyPacket } = await crypto.encryptSessionKeyWithPassword(sessionKey, 'pw');
    expect(keyPacket.length).toBeGreaterThan(0);
  });

  it('generates distinct passphrases', () => {
    expect(crypto.generatePassphrase()).not.toBe(crypto.generatePassphrase());
  });
});

describe('ProtonAccount', { timeout: 60_000 }, () => {
  async function fixture() {
    const userKey = await crypto.generateKey('user-pass', { enableAead: false });
    const addressPass = 'random-address-passphrase';
    const addressKey = await crypto.generateKey(addressPass, { enableAead: false });
    const token = await openpgp.encrypt({
      message: await openpgp.createMessage({ text: addressPass }),
      encryptionKeys: userKey.privateKey.toPublic(),
    });
    const legacyKey = await crypto.generateKey('user-pass', { enableAead: false });
    const responses: Record<string, unknown> = {
      '/core/v4/users': {
        Code: 1000,
        User: { Keys: [{ ID: 'uk', PrivateKey: userKey.armoredKey, Primary: 1 }] },
      },
      '/core/v4/addresses': {
        Code: 1000,
        Addresses: [
          {
            ID: 'a1',
            Email: 'alice@proton.me',
            Status: 1,
            Order: 1,
            Keys: [
              { ID: 'ak', PrivateKey: addressKey.armoredKey, Token: token, Primary: 1, Active: 1, Flags: 3 },
              {
                ID: 'legacy',
                PrivateKey: legacyKey.armoredKey,
                Token: null,
                Primary: 0,
                Active: 1,
                Flags: 3,
              },
            ],
          },
        ],
      },
      '/core/v4/keys/all?Email=bob%40proton.me&InternalOnly=0': {
        Code: 1000,
        Address: { Keys: [{ Flags: 3, PublicKey: addressKey.privateKey.toPublic().armor() }] },
      },
    };
    const calls: string[] = [];
    const api = {
      getJson: async (path: string) => {
        calls.push(path);
        return (responses[path] ?? { Code: 1000 }) as Record<string, unknown>;
      },
    };
    let session: ProtonSession | null = {
      uid: 'u',
      accessToken: 'a',
      refreshToken: 'r',
      username: 'alice',
      userId: 'user',
      keyPassphrases: { uk: 'user-pass' },
    };
    const account = new ProtonAccount(api, () => session, crypto);
    return {
      account,
      calls,
      addressKey,
      legacyKey,
      setSession: (s: ProtonSession | null) => (session = s),
    };
  }

  it('unlocks token-based and legacy address keys', async () => {
    const { account, addressKey, legacyKey } = await fixture();
    const address = await account.getOwnPrimaryAddress();
    expect(address.email).toBe('alice@proton.me');
    expect(address.addressId).toBe('a1');
    expect(address.keys.map((k) => k.id)).toEqual(['ak', 'legacy']);
    expect(address.keys[address.primaryKeyIndex].id).toBe('ak');
    expect(address.keys[0].key.getFingerprint()).toBe(addressKey.privateKey.getFingerprint());
    expect(address.keys[1].key.getFingerprint()).toBe(legacyKey.privateKey.getFingerprint());
    expect((await account.getOwnAddress('ALICE@proton.me')).addressId).toBe('a1');
    expect(await account.getOwnAddresses()).toHaveLength(1);
  });

  it('fetches and caches public keys', async () => {
    const { account, calls } = await fixture();
    expect(await account.hasProtonAccount('bob@proton.me')).toBe(true);
    await account.getPublicKeys('bob@proton.me');
    expect(calls.filter((c) => c.includes('keys/all'))).toHaveLength(1);
    await account.getPublicKeys('bob@proton.me', true);
    expect(calls.filter((c) => c.includes('keys/all'))).toHaveLength(2);
    expect(await account.hasProtonAccount('nobody@proton.me')).toBe(false);
  });

  it('asks to sign in again without key passphrases', async () => {
    const { account, setSession } = await fixture();
    setSession({
      uid: 'u',
      accessToken: 'a',
      refreshToken: 'r',
      username: 'alice',
      userId: 'user',
      keyPassphrases: {},
    });
    await expect(account.getOwnPrimaryAddress()).rejects.toThrow(/no key passphrases/);
    await expect(account.getOwnAddress('missing')).rejects.toBeInstanceOf(RemoteUnavailableError);
  });
});
