import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecureStorageStatus } from '../preload/api';
import type { SecretVault } from './connectors/types';

export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: the keyring Chromium picked (`basic_text` means a hardcoded password, i.e. no protection). */
  getSelectedStorageBackend?(): string;
}

/**
 * `secure`: an OS keychain protects the credentials. `weak`: Linux without a keyring, where safeStorage falls back
 * to a hardcoded password, so credentials must not be written to disk. `unavailable`: no encryption at all.
 */
export type { SecureStorageStatus };

export function secureStorageStatus(
  encryptor: Encryptor,
  platform: NodeJS.Platform = process.platform,
): SecureStorageStatus {
  if (!encryptor.isEncryptionAvailable()) return 'unavailable';
  if (platform === 'linux') {
    const backend = encryptor.getSelectedStorageBackend?.() ?? 'unknown';
    if (backend === 'basic_text' || backend === 'unknown') return 'weak';
  }
  return 'secure';
}

/** Credentials vault: a JSON map encrypted with the OS keychain (Electron safeStorage). */
export class FileSecretVault implements SecretVault {
  private cache: Record<string, string> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly encryptor: Encryptor,
  ) {}

  private ensureAvailable() {
    if (!this.encryptor.isEncryptionAvailable()) {
      throw new Error('Secure storage is not available on this system, so credentials cannot be saved.');
    }
  }

  private async load(): Promise<Record<string, string>> {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) return (this.cache = {});
    this.ensureAvailable();
    try {
      this.cache = JSON.parse(this.encryptor.decryptString(await readFile(this.file))) as Record<
        string,
        string
      >;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(data: Record<string, string>) {
    this.ensureAvailable();
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, this.encryptor.encryptString(JSON.stringify(data)));
    await rename(tmp, this.file);
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  get(key: string) {
    return this.serial(async () => (await this.load())[key] ?? null);
  }

  /** Every stored entry, used to move credentials out of a weakly protected file. */
  entries() {
    return this.serial(async () => ({ ...(await this.load()) }));
  }

  set(key: string, value: string) {
    return this.serial(async () => {
      const data = { ...(await this.load()), [key]: value };
      await this.save(data);
      this.cache = data;
    });
  }

  delete(key: string) {
    return this.serial(async () => {
      const data = { ...(await this.load()) };
      if (!(key in data)) return;
      delete data[key];
      await this.save(data);
      this.cache = data;
    });
  }
}

/**
 * Picks the vault for the current secure storage status. With `weak` storage, credentials only live in memory
 * (the user signs in again after each launch); a credentials file written earlier is read once and deleted.
 */
export async function createSecretVault(
  file: string,
  encryptor: Encryptor,
  status: SecureStorageStatus,
): Promise<SecretVault> {
  if (status !== 'weak') return new FileSecretVault(file, encryptor);
  const memory = new MemorySecretVault();
  if (existsSync(file)) {
    try {
      for (const [key, value] of Object.entries(await new FileSecretVault(file, encryptor).entries())) {
        memory.data.set(key, value);
      }
    } catch {
      // Unreadable: nothing to keep.
    }
    await rm(file, { force: true });
  }
  return memory;
}

export class MemorySecretVault implements SecretVault {
  readonly data = new Map<string, string>();
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.data.set(key, value);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
}
