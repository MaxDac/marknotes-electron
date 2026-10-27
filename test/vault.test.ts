import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSecretVault,
  FileSecretVault,
  MemorySecretVault,
  secureStorageStatus,
  type Encryptor,
} from '../src/main/vault';

const encryptor = (available = true, backend?: string): Encryptor => ({
  isEncryptionAvailable: async () => available,
  encryptString: async (plain) => Buffer.from(plain, 'utf8').reverse(),
  decryptString: async (encrypted) => Buffer.from(encrypted).reverse().toString('utf8'),
  ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }),
});

describe('secureStorageStatus', () => {
  it('is unavailable without encryption', async () => {
    expect(await secureStorageStatus(encryptor(false), 'darwin')).toBe('unavailable');
  });

  it('is secure on macOS and Windows', async () => {
    expect(await secureStorageStatus(encryptor(), 'darwin')).toBe('secure');
    expect(await secureStorageStatus(encryptor(), 'win32')).toBe('secure');
  });

  it('is weak on Linux without a keyring', async () => {
    expect(await secureStorageStatus(encryptor(true, 'basic_text'), 'linux')).toBe('weak');
    expect(await secureStorageStatus(encryptor(true, 'unknown'), 'linux')).toBe('weak');
    expect(await secureStorageStatus(encryptor(true), 'linux')).toBe('weak');
  });

  it('is secure on Linux with a keyring', async () => {
    expect(await secureStorageStatus(encryptor(true, 'gnome_libsecret'), 'linux')).toBe('secure');
    expect(await secureStorageStatus(encryptor(true, 'kwallet5'), 'linux')).toBe('secure');
  });
});

describe('createSecretVault', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'marknotes-vault-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('uses the encrypted file when storage is secure', async () => {
    const file = join(dir, 'vault.bin');
    const vault = await createSecretVault(file, encryptor(), 'secure');
    expect(vault).toBeInstanceOf(FileSecretVault);
    await vault.set('a', '1');
    expect(existsSync(file)).toBe(true);
  });

  it('keeps credentials in memory only when storage is weak', async () => {
    const file = join(dir, 'vault.bin');
    const vault = await createSecretVault(file, encryptor(true, 'basic_text'), 'weak');
    expect(vault).toBeInstanceOf(MemorySecretVault);
    await vault.set('a', '1');
    expect(await vault.get('a')).toBe('1');
    expect(existsSync(file)).toBe(false);
  });

  it('moves an existing file into memory and deletes it when storage is weak', async () => {
    const file = join(dir, 'vault.bin');
    const enc = encryptor(true, 'basic_text');
    await new FileSecretVault(file, enc).set('token', 'secret');
    const vault = await createSecretVault(file, enc, 'weak');
    expect(await vault.get('token')).toBe('secret');
    expect(existsSync(file)).toBe(false);
  });
});
