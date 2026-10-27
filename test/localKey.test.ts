import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalKeyManager, type LocalKeyOptions } from '../src/main/localKey';
import type { Encryptor } from '../src/main/vault';

const encryptor: Encryptor = {
  isEncryptionAvailable: async () => true,
  encryptString: async (plain) => Buffer.from(`wrapped:${plain}`, 'utf8'),
  decryptString: async (encrypted) => {
    const text = Buffer.from(encrypted).toString('utf8');
    if (!text.startsWith('wrapped:')) throw new Error('bad');
    return text.slice('wrapped:'.length);
  },
};

let dir: string;
let file: string;

const manager = (options: Partial<LocalKeyOptions> = {}) =>
  new LocalKeyManager(file, {
    defaultProtection: 'keychain',
    encryptor,
    scrypt: { N: 1024, r: 8, p: 1 },
    failureDelayMs: 0,
    ...options,
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marknotes-localkey-'));
  file = join(dir, 'localkey.bin');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const fileText = () => readFile(file, 'utf8');

describe('LocalKeyManager', () => {
  it('creates a key wrapped by the keychain and reads it back', async () => {
    const keys = manager();
    await keys.init();
    expect(keys.status()).toEqual({ state: 'unlocked', enabled: false, protection: 'keychain', error: null });
    const key = keys.key();
    expect(key).toHaveLength(32);
    expect(await fileText()).not.toContain(Buffer.from(key).toString('base64'));

    const again = manager();
    await again.init();
    expect(again.key()).toEqual(key);
  });

  it('stores the key as is without a keychain', async () => {
    const keys = manager({ defaultProtection: 'none' });
    await keys.init();
    expect(keys.status().protection).toBe('none');
    expect(JSON.parse(await fileText()).data).toBe(Buffer.from(keys.key()).toString('base64'));
  });

  it('reports an unreadable key', async () => {
    const keys = manager();
    await keys.init();
    const broken = manager({ encryptor: { ...encryptor, decryptString: async () => 'short' } });
    await broken.init();
    expect(broken.status().state).toBe('error');
    expect(() => broken.key()).toThrow('Locked');
  });

  it('locks the key behind a passphrase', async () => {
    const keys = manager();
    await keys.init();
    const key = keys.key();
    expect((await keys.enable('correct horse')).enabled).toBe(true);
    expect(await fileText()).not.toContain('wrapped:');
    expect(keys.lock()).toBe(true);
    expect(keys.status().state).toBe('locked');
    expect(() => keys.key()).toThrow('Locked');

    const restarted = manager();
    await restarted.init();
    expect(restarted.status()).toMatchObject({ state: 'locked', enabled: true, protection: 'passphrase' });
    await expect(restarted.unlock('wrong horse')).rejects.toThrow('Wrong passphrase');
    expect(restarted.status().state).toBe('locked');
    expect((await restarted.unlock('correct horse')).state).toBe('unlocked');
    expect(restarted.key()).toEqual(key);
  });

  it('does not lock without the app lock', async () => {
    const keys = manager();
    await keys.init();
    expect(keys.lock()).toBe(false);
    expect(keys.status().state).toBe('unlocked');
  });

  it('changes and disables the passphrase', async () => {
    const keys = manager();
    await keys.init();
    const key = keys.key();
    await keys.enable('first passphrase');
    await expect(keys.change('nope', 'second passphrase')).rejects.toThrow('Wrong passphrase');
    await keys.change('first passphrase', 'second passphrase');

    const restarted = manager();
    await restarted.init();
    await expect(restarted.unlock('first passphrase')).rejects.toThrow('Wrong passphrase');
    await restarted.unlock('second passphrase');
    expect(restarted.key()).toEqual(key);

    await expect(restarted.disable('first passphrase')).rejects.toThrow('Wrong passphrase');
    expect((await restarted.disable('second passphrase')).protection).toBe('keychain');
    const plain = manager();
    await plain.init();
    expect(plain.status().state).toBe('unlocked');
    expect(plain.key()).toEqual(key);
  });

  it('rejects empty passphrases and enabling twice', async () => {
    const keys = manager();
    await keys.init();
    await expect(keys.enable('')).rejects.toThrow('Enter a passphrase');
    await keys.enable('passphrase');
    await expect(keys.enable('passphrase')).rejects.toThrow('already enabled');
    keys.lock();
    await expect(keys.enable('other')).rejects.toThrow('Locked');
  });

  it('rotates the key keeping the passphrase while unlocked', async () => {
    const keys = manager();
    await keys.init();
    await keys.enable('passphrase');
    const old = keys.key();
    const fresh = await keys.reset();
    expect(fresh).not.toEqual(old);
    expect(keys.key()).toEqual(fresh);

    const restarted = manager();
    await restarted.init();
    expect(restarted.status().state).toBe('locked');
    await restarted.unlock('passphrase');
    expect(restarted.key()).toEqual(fresh);
  });

  it('removes the app lock when reset while locked (forgotten passphrase)', async () => {
    const keys = manager();
    await keys.init();
    await keys.enable('passphrase');
    const old = keys.key();
    keys.lock();
    const fresh = await keys.reset();
    expect(fresh).not.toEqual(old);
    expect(keys.status()).toMatchObject({ state: 'unlocked', enabled: false, protection: 'keychain' });
    expect(existsSync(file)).toBe(true);
  });
});
