import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SecretVault } from './connectors/types';

export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
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
