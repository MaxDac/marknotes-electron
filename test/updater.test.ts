import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../src/preload/api';
import {
  followsPrereleases,
  loadElectronUpdater,
  unsupportedReason,
  UpdateController,
  type UpdateEnvironment,
  type Updater,
} from '../src/main/updater';

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  allowPrerelease = false;
  checkForUpdates = vi.fn(async () => {
    this.emit('checking-for-update');
    return null;
  });
  quitAndInstall = vi.fn();
}

vi.mock('electron-updater', () => ({ default: { autoUpdater: { marker: 'electron-updater' } } }));

const env = (overrides: Partial<UpdateEnvironment> = {}): UpdateEnvironment => ({
  isPackaged: true,
  platform: 'win32',
  version: '1.2.3',
  appImage: undefined,
  prereleaseBuild: false,
  e2e: false,
  ...overrides,
});

function setup(overrides: Partial<UpdateEnvironment> = {}) {
  const updater = new FakeUpdater();
  const statuses: UpdateStatus[] = [];
  const load = vi.fn(async () => updater as unknown as Updater);
  const controller = new UpdateController(env(overrides), load, (s) => statuses.push(s));
  return { updater, statuses, load, controller };
}

describe('unsupportedReason', () => {
  it('allows packaged Windows, macOS and AppImage builds', () => {
    expect(unsupportedReason(env({ platform: 'win32' }))).toBeNull();
    expect(unsupportedReason(env({ platform: 'darwin' }))).toBeNull();
    expect(unsupportedReason(env({ platform: 'linux', appImage: '/tmp/MarkNotes.AppImage' }))).toBeNull();
  });

  it('disables dev, e2e and non-AppImage Linux builds', () => {
    expect(unsupportedReason(env({ isPackaged: false }))).toMatch(/packaged/);
    expect(unsupportedReason(env({ e2e: true }))).toMatch(/end-to-end/);
    expect(unsupportedReason(env({ platform: 'linux' }))).toMatch(/GitHub Releases/);
  });
});

describe('followsPrereleases', () => {
  it('follows pre-releases for pre-release builds or versions only', () => {
    expect(followsPrereleases({ version: '1.2.3', prereleaseBuild: false })).toBe(false);
    expect(followsPrereleases({ version: '1.2.3', prereleaseBuild: true })).toBe(true);
    expect(followsPrereleases({ version: '1.3.0-beta.1', prereleaseBuild: false })).toBe(true);
  });
});

describe('UpdateController', () => {
  it('does not load the updater when updates are unsupported', async () => {
    const { controller, load, statuses } = setup({ isPackaged: false });
    await controller.start();
    expect(load).not.toHaveBeenCalled();
    expect(controller.status()).toEqual({ state: 'disabled', reason: expect.any(String) });
    expect(statuses).toEqual([]);
  });

  it('configures background download and checks once', async () => {
    const { controller, updater } = setup({ prereleaseBuild: true });
    await controller.start();
    await controller.start();
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
    expect(updater.allowPrerelease).toBe(true);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(controller.status()).toEqual({ state: 'checking' });
  });

  it('reports an up-to-date app', async () => {
    const { controller, updater } = setup();
    await controller.start();
    updater.emit('update-not-available', { version: '1.2.3' });
    expect(controller.status()).toEqual({ state: 'upToDate' });
  });

  it('reports download progress and a ready update, then installs it', async () => {
    const { controller, updater, statuses } = setup();
    expect(() => controller.install()).toThrow(/No update/);
    await controller.start();
    updater.emit('update-available', { version: '1.3.0' });
    updater.emit('download-progress', { percent: 41.6 });
    updater.emit('update-downloaded', { version: '1.3.0' });
    expect(statuses).toEqual([
      { state: 'checking' },
      { state: 'downloading', version: '1.3.0', percent: 0 },
      { state: 'downloading', version: '1.3.0', percent: 42 },
      { state: 'downloaded', version: '1.3.0' },
    ]);
    controller.install();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
  });

  it('reports errors without throwing, but keeps a downloaded update', async () => {
    const { controller, updater } = setup();
    updater.checkForUpdates.mockRejectedValueOnce(new Error('offline'));
    await expect(controller.start()).resolves.toBeUndefined();
    expect(controller.status()).toEqual({ state: 'error', message: 'offline' });

    updater.emit('update-downloaded', { version: '1.3.0' });
    updater.emit('error', new Error('signature check failed'));
    expect(controller.status()).toEqual({ state: 'downloaded', version: '1.3.0' });
  });

  it('reports a failure to load the updater', async () => {
    const controller = new UpdateController(
      env(),
      async () => {
        throw new Error('missing app-update.yml');
      },
      () => undefined,
    );
    await controller.start();
    expect(controller.status()).toEqual({ state: 'error', message: 'missing app-update.yml' });
  });
});

describe('loadElectronUpdater', () => {
  it('returns the electron-updater autoUpdater singleton', async () => {
    expect(await loadElectronUpdater()).toEqual({ marker: 'electron-updater' });
  });
});
