import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LockStatus, LocalKeyProtection } from '../preload/api';
import type { Encryptor } from './vault';

export type { LockStatus, LocalKeyProtection };

export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** About 64 MiB and a few hundred milliseconds per attempt. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 16, r: 8, p: 1 };

type KeyFile =
  | { v: 1; mode: 'keychain'; data: string }
  | { v: 1; mode: 'none'; data: string }
  | { v: 1; mode: 'passphrase'; salt: string; iv: string; tag: string; data: string; scrypt: ScryptParams };

export interface LocalKeyOptions {
  /** How the key is protected without an app lock: by the OS keychain, or not at all. */
  defaultProtection: 'keychain' | 'none';
  encryptor?: Encryptor;
  scrypt?: ScryptParams;
  /** Delay before a wrong passphrase is reported. */
  failureDelayMs?: number;
}

const WRONG_PASSPHRASE = 'Wrong passphrase';
const KEY_BYTES = 32;

const scrypt = (passphrase: string, salt: Buffer, params: ScryptParams) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(
      passphrase.normalize('NFKC'),
      salt,
      KEY_BYTES,
      { ...params, maxmem: 256 * params.N * params.r + 16 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function checkPassphrase(passphrase: unknown): asserts passphrase is string {
  if (typeof passphrase !== 'string' || passphrase.length === 0) throw new Error('Enter a passphrase');
}

/**
 * The key that encrypts the notes stored on this device (the IndexedDB data key), kept in `localkey.bin`.
 * Without an app lock it is wrapped by the OS keychain (or stored as is when no keychain protects anything); with the
 * app lock it is wrapped with a key derived from the passphrase (scrypt) and only kept in memory while unlocked.
 * There is no recovery: a forgotten passphrase means deleting the local data with `reset`.
 */
export class LocalKeyManager {
  private dek: Buffer | null = null;
  /** Wrapping key derived from the passphrase, kept while unlocked so the data key can be rotated. */
  private kek: { key: Buffer; salt: Buffer; scrypt: ScryptParams } | null = null;
  private stored: KeyFile | null = null;
  private error: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly options: LocalKeyOptions,
  ) {}

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Loads the key file, creating a key on first start. Keys not protected by a passphrase are unlocked at once. */
  init(): Promise<void> {
    return this.serial(async () => {
      this.error = null;
      if (!existsSync(this.file)) {
        await this.create();
        return;
      }
      try {
        this.stored = JSON.parse(await readFile(this.file, 'utf8')) as KeyFile;
        if (this.stored.mode === 'keychain') {
          this.dek = Buffer.from(
            this.encryptor().decryptString(Buffer.from(this.stored.data, 'base64')),
            'base64',
          );
        } else if (this.stored.mode === 'none') {
          this.dek = Buffer.from(this.stored.data, 'base64');
        }
        if (this.dek && this.dek.length !== KEY_BYTES) throw new Error('Invalid key');
      } catch {
        this.dek = null;
        this.error = 'The key that encrypts the notes on this device cannot be read.';
      }
    });
  }

  status(): LockStatus {
    const mode = this.stored?.mode ?? this.options.defaultProtection;
    return {
      state: this.error ? 'error' : this.dek ? 'unlocked' : 'locked',
      enabled: mode === 'passphrase',
      protection: mode,
      error: this.error,
    };
  }

  /** The data key, only while unlocked. */
  key(): Uint8Array {
    if (!this.dek) throw new Error('Locked');
    return new Uint8Array(this.dek);
  }

  unlock(passphrase: string): Promise<LockStatus> {
    return this.serial(async () => {
      checkPassphrase(passphrase);
      if (this.dek) return this.status();
      const file = this.stored;
      if (file?.mode !== 'passphrase') throw new Error('The app lock is not enabled');
      const unwrapped = await this.unwrap(file, passphrase);
      this.dek = unwrapped.dek;
      this.kek = unwrapped.kek;
      return this.status();
    });
  }

  enable(passphrase: string): Promise<LockStatus> {
    return this.serial(async () => {
      checkPassphrase(passphrase);
      const dek = this.requireUnlocked();
      if (this.stored?.mode === 'passphrase') throw new Error('The app lock is already enabled');
      await this.wrapWithPassphrase(dek, passphrase);
      return this.status();
    });
  }

  disable(passphrase: string): Promise<LockStatus> {
    return this.serial(async () => {
      checkPassphrase(passphrase);
      const file = this.stored;
      if (file?.mode !== 'passphrase') throw new Error('The app lock is not enabled');
      const { dek } = await this.unwrap(file, passphrase);
      this.dek = dek;
      this.kek = null;
      await this.save(this.wrapDefault(dek));
      return this.status();
    });
  }

  change(oldPassphrase: string, newPassphrase: string): Promise<LockStatus> {
    return this.serial(async () => {
      checkPassphrase(oldPassphrase);
      checkPassphrase(newPassphrase);
      const file = this.stored;
      if (file?.mode !== 'passphrase') throw new Error('The app lock is not enabled');
      const { dek } = await this.unwrap(file, oldPassphrase);
      this.dek = dek;
      await this.wrapWithPassphrase(dek, newPassphrase);
      return this.status();
    });
  }

  /** Forgets the keys when the app lock is enabled; returns whether anything was locked. */
  lock(): boolean {
    if (this.stored?.mode !== 'passphrase' || !this.dek) return false;
    this.dek.fill(0);
    this.kek?.key.fill(0);
    this.dek = null;
    this.kek = null;
    return true;
  }

  /**
   * Replaces the data key with a new one, so the data encrypted with the old key can no longer be read. While
   * unlocked the protection is kept (same passphrase); while locked or unreadable the app lock is removed.
   */
  reset(): Promise<Uint8Array> {
    return this.serial(async () => {
      const dek = randomBytes(KEY_BYTES);
      if (this.dek && this.kek && this.stored?.mode === 'passphrase') {
        await this.save(this.seal(dek, this.kek.key, this.kek.salt, this.kek.scrypt));
      } else {
        this.kek = null;
        await this.save(this.wrapDefault(dek));
      }
      this.dek?.fill(0);
      this.dek = dek;
      this.error = null;
      return new Uint8Array(dek);
    });
  }

  private async create() {
    const dek = randomBytes(KEY_BYTES);
    await this.save(this.wrapDefault(dek));
    this.dek = dek;
  }

  private requireUnlocked(): Buffer {
    if (!this.dek) throw new Error('Locked');
    return this.dek;
  }

  private encryptor(): Encryptor {
    const encryptor = this.options.encryptor;
    if (!encryptor?.isEncryptionAvailable()) throw new Error('Secure storage is not available');
    return encryptor;
  }

  private wrapDefault(dek: Buffer): KeyFile {
    if (this.options.defaultProtection === 'keychain') {
      return {
        v: 1,
        mode: 'keychain',
        data: this.encryptor().encryptString(dek.toString('base64')).toString('base64'),
      };
    }
    return { v: 1, mode: 'none', data: dek.toString('base64') };
  }

  private async wrapWithPassphrase(dek: Buffer, passphrase: string) {
    const salt = randomBytes(16);
    const params = this.options.scrypt ?? DEFAULT_SCRYPT;
    const kek = await scrypt(passphrase, salt, params);
    await this.save(this.seal(dek, kek, salt, params));
    this.kek?.key.fill(0);
    this.kek = { key: kek, salt, scrypt: params };
  }

  private seal(dek: Buffer, kek: Buffer, salt: Buffer, params: ScryptParams): KeyFile {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', kek, iv);
    cipher.setAAD(Buffer.from('marknotes-localkey-v1'));
    const data = Buffer.concat([cipher.update(dek), cipher.final()]);
    return {
      v: 1,
      mode: 'passphrase',
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: data.toString('base64'),
      scrypt: params,
    };
  }

  private async unwrap(file: Extract<KeyFile, { mode: 'passphrase' }>, passphrase: string) {
    const salt = Buffer.from(file.salt, 'base64');
    const kek = await scrypt(passphrase, salt, file.scrypt);
    try {
      const decipher = createDecipheriv('aes-256-gcm', kek, Buffer.from(file.iv, 'base64'));
      decipher.setAAD(Buffer.from('marknotes-localkey-v1'));
      decipher.setAuthTag(Buffer.from(file.tag, 'base64'));
      const dek = Buffer.concat([decipher.update(Buffer.from(file.data, 'base64')), decipher.final()]);
      if (dek.length !== KEY_BYTES) throw new Error('Invalid key');
      return { dek, kek: { key: kek, salt, scrypt: file.scrypt } };
    } catch {
      kek.fill(0);
      await sleep(this.options.failureDelayMs ?? 1000);
      throw new Error(WRONG_PASSPHRASE);
    }
  }

  private async save(file: KeyFile) {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(file), { mode: 0o600 });
    await rename(tmp, this.file);
    this.stored = file;
  }
}
