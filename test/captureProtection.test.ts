import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CaptureProtection } from '../src/main/captureProtection';

let dir: string;
let file: string;
let locked: boolean;
const windows = [{ setContentProtection: vi.fn() }, { setContentProtection: vi.fn() }];
const changed = vi.fn();
const policy = (platform = 'win32') =>
  new CaptureProtection(
    file,
    platform,
    () => locked,
    () => windows,
    changed,
  );

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'marknotes-capture-'));
  file = join(dir, 'capture-protection.json');
  locked = false;
  vi.clearAllMocks();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('capture protection', () => {
  it.each(['win32', 'darwin'])('defaults off and persists a device preference on %s', async (platform) => {
    const capture = policy(platform);
    await capture.init();
    expect(capture.status()).toEqual({ requested: false, forced: false, supported: true, enabled: false });
    await capture.setRequested(true);
    expect(await readFile(file, 'utf8')).toBe('true');
    for (const win of windows) expect(win.setContentProtection).toHaveBeenLastCalledWith(true);
    expect(changed).toHaveBeenLastCalledWith(capture.status());
    const restarted = policy(platform);
    await restarted.init();
    expect(restarted.status().enabled).toBe(true);
    await restarted.setRequested(false);
    for (const win of windows) expect(win.setContentProtection).toHaveBeenLastCalledWith(false);
  });

  it('forces protection with app lock, including startup, and restores the independent preference', async () => {
    const capture = policy();
    await capture.init();
    locked = true;
    capture.refresh();
    expect(capture.status()).toMatchObject({ requested: false, forced: true, enabled: true });
    for (const win of windows) expect(win.setContentProtection).toHaveBeenLastCalledWith(true);
    await expect(capture.setRequested(false)).rejects.toThrow('required while the app lock');
    const restarted = policy();
    await restarted.init();
    const recreated = { setContentProtection: vi.fn() };
    restarted.protect(recreated);
    expect(recreated.setContentProtection).toHaveBeenCalledWith(true);
    locked = false;
    capture.refresh();
    for (const win of windows) expect(win.setContentProtection).toHaveBeenLastCalledWith(false);
    await capture.setRequested(true);
    locked = true;
    capture.refresh();
    locked = false;
    capture.refresh();
    expect(capture.status().enabled).toBe(true);
  });

  it('reports unsupported platforms truthfully without calling the native API', async () => {
    await writeFile(file, 'true');
    locked = true;
    const capture = policy('linux');
    await capture.init();
    capture.refresh();
    expect(capture.status()).toEqual({ requested: true, forced: true, supported: false, enabled: false });
    for (const win of windows) expect(win.setContentProtection).not.toHaveBeenCalled();
    await expect(capture.setRequested(true)).rejects.toThrow('not supported');
  });

  it('serializes updates and rejects invalid IPC values without poisoning the queue', async () => {
    const capture = policy();
    await capture.init();
    // IPC inputs are untrusted even though the preload API is typed.
    // @ts-expect-error invalid renderer input
    await expect(capture.setRequested('false')).rejects.toThrow('boolean');
    await Promise.all([capture.setRequested(true), capture.setRequested(false)]);
    expect(capture.status().enabled).toBe(false);
    expect(await readFile(file, 'utf8')).toBe('false');
  });

  it.each(['{}', 'not json', '"false"'])(
    'turns protection on when the preference file is unreadable (%s)',
    async (text) => {
      await writeFile(file, text);
      const capture = policy();
      await capture.init();
      expect(capture.status()).toMatchObject({ requested: true, enabled: true });
      await capture.setRequested(false);
      expect(await readFile(file, 'utf8')).toBe('false');
    },
  );

  it('surfaces write errors without changing the preference', async () => {
    // The parent "directory" is a file, so the preference cannot be written.
    await writeFile(file, 'false');
    const capture = new CaptureProtection(
      join(file, 'invalid'),
      'win32',
      () => false,
      () => windows,
      changed,
    );
    await expect(capture.setRequested(true)).rejects.toThrow();
    expect(capture.status().requested).toBe(false);
    expect(changed).not.toHaveBeenCalled();
  });
});
