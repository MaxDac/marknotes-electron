import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CaptureProtectionStatus } from '../preload/api';

interface CaptureWindow {
  setContentProtection(enabled: boolean): void;
}

/** Device policy must be available before the encrypted renderer database can be opened. */
export class CaptureProtection {
  private requested = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly platform: string,
    private readonly lockEnabled: () => boolean,
    private readonly windows: () => CaptureWindow[],
    private readonly changed: (status: CaptureProtectionStatus) => void,
  ) {}

  /** Loads the preference: off when missing, on (fail closed) when it cannot be read. */
  async init(): Promise<void> {
    try {
      const value: unknown = JSON.parse(await readFile(this.file, 'utf8'));
      if (typeof value !== 'boolean') throw new Error('Invalid capture protection preference');
      this.requested = value;
    } catch (error) {
      this.requested = !(error instanceof Error && 'code' in error && error.code === 'ENOENT');
    }
  }

  status(): CaptureProtectionStatus {
    const forced = this.lockEnabled();
    const supported = this.platform === 'win32' || this.platform === 'darwin';
    return { requested: this.requested, forced, supported, enabled: supported && (forced || this.requested) };
  }

  protect(window: CaptureWindow): void {
    const status = this.status();
    if (status.supported) window.setContentProtection(status.enabled);
  }

  refresh(): void {
    for (const window of this.windows()) this.protect(window);
    this.changed(this.status());
  }

  setRequested(requested: boolean): Promise<CaptureProtectionStatus> {
    const run = this.queue.then(async () => {
      if (typeof requested !== 'boolean') throw new Error('Expected a capture protection boolean');
      if (!this.status().supported) throw new Error('Capture protection is not supported on this platform');
      if (this.lockEnabled() && !requested) {
        throw new Error('Capture protection is required while the app lock is enabled');
      }
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(`${this.file}.tmp`, JSON.stringify(requested), { mode: 0o600 });
      await rename(`${this.file}.tmp`, this.file);
      this.requested = requested;
      this.refresh();
      return this.status();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
