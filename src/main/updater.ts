import type { UpdateStatus } from '../preload/api';

/** The subset of electron-updater's `AppUpdater` used by the controller. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  on(event: 'checking-for-update' | 'update-not-available', listener: () => void): unknown;
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateEnvironment {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  /** Current app version (`app.getVersion()`). */
  version: string;
  /** Set by the AppImage runtime; other Linux packages (deb) can't self-update. */
  appImage: string | undefined;
  /** Whether this build was published as a GitHub pre-release. */
  prereleaseBuild: boolean;
  /** End-to-end test runs never check for updates. */
  e2e: boolean;
}

/** Why auto-update is unavailable in this environment, or null when it is supported. */
export function unsupportedReason(env: UpdateEnvironment): string | null {
  if (env.e2e) return 'Updates are disabled in end-to-end tests.';
  if (!env.isPackaged) return 'Updates are only checked in packaged builds.';
  if (env.platform === 'linux' && !env.appImage) {
    return 'This Linux package cannot update itself. Download new versions from GitHub Releases.';
  }
  if (!['win32', 'darwin', 'linux'].includes(env.platform))
    return 'Updates are not supported on this platform.';
  return null;
}

/** Pre-release builds (or semver pre-release versions) follow pre-releases; stable builds only see stable releases. */
export function followsPrereleases(env: Pick<UpdateEnvironment, 'version' | 'prereleaseBuild'>): boolean {
  return env.prereleaseBuild || /^\d+\.\d+\.\d+-/.test(env.version);
}

/** Loads electron-updater lazily so dev and test runs never touch it. */
export async function loadElectronUpdater(): Promise<Updater> {
  const mod = await import('electron-updater');
  const { autoUpdater } = (mod.default ?? mod) as { autoUpdater: Updater };
  return autoUpdater;
}

/** Checks GitHub Releases once on startup, downloads in the background and reports progress. */
export class UpdateController {
  private current: UpdateStatus = { state: 'idle' };
  private updater: Updater | null = null;

  constructor(
    private readonly env: UpdateEnvironment,
    private readonly load: () => Promise<Updater>,
    private readonly notify: (status: UpdateStatus) => void,
  ) {
    const reason = unsupportedReason(env);
    if (reason) this.current = { state: 'disabled', reason };
  }

  status(): UpdateStatus {
    return this.current;
  }

  private set(status: UpdateStatus) {
    this.current = status;
    this.notify(status);
  }

  /** Starts the update check; never throws. */
  async start(): Promise<void> {
    if (this.current.state !== 'idle') return;
    try {
      const updater = await this.load();
      this.updater = updater;
      updater.autoDownload = true;
      updater.autoInstallOnAppQuit = true;
      updater.allowPrerelease = followsPrereleases(this.env);
      updater.on('checking-for-update', () => this.set({ state: 'checking' }));
      updater.on('update-not-available', () => this.set({ state: 'upToDate' }));
      updater.on('update-available', (info) =>
        this.set({ state: 'downloading', version: info.version, percent: 0 }),
      );
      updater.on('download-progress', (progress) => {
        if (this.current.state === 'downloading') {
          this.set({ ...this.current, percent: Math.round(progress.percent) });
        }
      });
      updater.on('update-downloaded', (info) => this.set({ state: 'downloaded', version: info.version }));
      updater.on('error', (error) => this.fail(error));
      await updater.checkForUpdates();
    } catch (e) {
      this.fail(e);
    }
  }

  private fail(e: unknown) {
    // Keep a downloaded update installable even if a later check fails.
    if (this.current.state === 'downloaded') return;
    this.set({ state: 'error', message: e instanceof Error ? e.message : String(e) });
  }

  /** Quits the app and installs the downloaded update. */
  install(): void {
    if (this.current.state !== 'downloaded' || !this.updater)
      throw new Error('No update is ready to install');
    this.updater.quitAndInstall(false, true);
  }
}
