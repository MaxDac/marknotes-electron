import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  safeStorage,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import iconPath from '../../build/icon.png?asset';
import type { RemoteOp } from '../preload/api';
import { diagnosticEnvironment, type DiagnosticCode, type DiagnosticDraft } from '../shared/diagnostics';
import type { DriveProvider } from '../shared/types';
import { classifySyncFailure } from '../shared/syncFailure';
import { FakeConnector } from './connectors/fake';
import { CaptureProtection } from './captureProtection';
import { createConnectors } from './connectors/registry';
import type { DriveConnector } from './connectors/types';
import { PRERELEASE_BUILD } from './config';
import { DriveService } from './driveService';
import { DiagnosticsStore } from './diagnostics';
import { LocalKeyManager } from './localKey';
import { isAppUrl, isTrustedSender } from './security';
import { loadElectronUpdater, UpdateController } from './updater';
import { createSecretVault, secureStorageStatus, type SecureStorageStatus } from './vault';

// Test and development switches only apply to unpackaged builds, never to an installed app.
const devEnv = (name: string) => (app.isPackaged ? undefined : process.env[name]);
const e2e = devEnv('MARKNOTES_E2E') === '1';
// A separate profile folder (tests, the Linux package smoke test, portable setups); it cannot load other code.
const userDataOverride = process.env.MARKNOTES_USER_DATA;
if (userDataOverride) app.setPath('userData', userDataOverride);
const devServerUrl = devEnv('ELECTRON_RENDERER_URL') || undefined;
const indexHtml = join(import.meta.dirname, '../renderer/index.html');
const appUrl = devServerUrl ?? pathToFileURL(indexHtml).href;
let diagnostics: DiagnosticsStore | undefined;
let reviewedDraft: DiagnosticDraft | null = null;
let diagnosticsWarned = false;

function localDiagnostics(): DiagnosticsStore {
  if (!diagnostics) throw new Error('Local diagnostics unavailable');
  return diagnostics;
}

// Shown once per run: a broken log folder must not turn every later error into a modal box.
function warnDiagnosticsUnavailable(detail: string) {
  if (diagnosticsWarned) return;
  diagnosticsWarned = true;
  dialog.showErrorBox('Diagnostics unavailable', `${detail} No report was sent.`);
}

function recordDiagnostic(code: DiagnosticCode) {
  try {
    localDiagnostics().record(code);
  } catch {
    warnDiagnosticsUnavailable('Could not save local diagnostics.');
  }
}

/** Also works when the store could not be opened, so deleting local data always removes the logs. */
function clearDiagnostics() {
  reviewedDraft = null;
  if (diagnostics) diagnostics.clear();
  else rmSync(diagnosticsDirectory(), { recursive: true, force: true });
}

const diagnosticsDirectory = () => join(app.getPath('userData'), 'diagnostics');

const openExternal = async (url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened');
  await shell.openExternal(url);
};

async function createService(): Promise<{
  service: DriveService;
  storage: SecureStorageStatus;
  keys: LocalKeyManager;
}> {
  const userData = app.getPath('userData');
  let connectors: Record<DriveProvider, DriveConnector>;
  let storage: SecureStorageStatus = 'secure';
  if (e2e) {
    connectors = {
      proton: new FakeConnector('proton'),
      dropbox: new FakeConnector('dropbox'),
      onedrive: new FakeConnector('onedrive'),
    };
  } else {
    storage = secureStorageStatus(safeStorage);
    const vault = await createSecretVault(join(userData, 'credentials.bin'), safeStorage, storage);
    connectors = createConnectors({ vault, openExternal });
  }
  // Without a keychain that protects anything (and in e2e runs) the local key is stored as is: see the README.
  const keys = new LocalKeyManager(join(userData, 'localkey.bin'), {
    defaultProtection: !e2e && storage === 'secure' ? 'keychain' : 'none',
    encryptor: safeStorage,
  });
  await keys.init();
  return { service: new DriveService(join(userData, 'drives.json'), connectors), storage, keys };
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const user = (e as { userMessage?: unknown }).userMessage;
    return typeof user === 'string' && user ? user : e.message;
  }
  return String(e);
}

const senderOf = (event: IpcMainInvokeEvent) => {
  const frame = event.senderFrame;
  return { frameUrl: frame?.url ?? null, isMainFrame: !!frame && frame.parent === null };
};

function handle(channel: string, fn: (...args: never[]) => unknown) {
  ipcMain.handle(channel, async (event, ...args: unknown[]) => {
    if (!isTrustedSender(senderOf(event), appUrl)) return { ok: false, error: 'Untrusted sender' };
    try {
      return { ok: true, value: await (fn as (...a: unknown[]) => unknown)(...args) };
    } catch (e) {
      if (!channel.startsWith('diagnostics:')) {
        recordDiagnostic(
          channel.startsWith('drives:') || channel === 'remote:op'
            ? 'DRIVE_FAILED'
            : channel.startsWith('lock:')
              ? 'LOCK_FAILED'
              : 'IPC_FAILED',
        );
      }
      return { ok: false, error: errorMessage(e), failure: classifySyncFailure(e) };
    }
  });
}

function createUpdater(): UpdateController {
  return new UpdateController(
    {
      isPackaged: app.isPackaged,
      platform: process.platform,
      version: app.getVersion(),
      appImage: process.env.APPIMAGE,
      prereleaseBuild: PRERELEASE_BUILD,
      e2e,
    },
    loadElectronUpdater,
    (status) => {
      if (status.state === 'error') recordDiagnostic('UPDATE_FAILED');
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:changed', status);
    },
  );
}

/**
 * Locks the app (with the app lock enabled): the key is forgotten, then every window reloads to the lock screen.
 * The page reloads itself once its pending edits are saved; it is reloaded anyway if it doesn't within 2 s.
 */
function lockApp(keys: LocalKeyManager): boolean {
  if (!keys.lock()) return false;
  for (const win of BrowserWindow.getAllWindows()) {
    const contents = win.webContents;
    const timer = setTimeout(() => !contents.isDestroyed() && contents.reload(), 2000);
    contents.once('did-start-loading', () => clearTimeout(timer));
    contents.send('lock:locked');
  }
  return true;
}

function registerIpc(
  service: DriveService,
  storage: SecureStorageStatus,
  keys: LocalKeyManager,
  updater: UpdateController,
  capture: CaptureProtection,
) {
  handle('privacy:capture', () => capture.status());
  handle('privacy:setCapture', (enabled: boolean) => capture.setRequested(enabled));
  const refreshCapture = async <T>(operation: Promise<T>): Promise<T> => {
    try {
      return await operation;
    } finally {
      capture.refresh();
    }
  };
  handle('app:deviceId', () => service.deviceId());
  handle('app:secureStorage', () => storage);
  handle('lock:status', () => keys.status());
  handle('lock:key', () => keys.key());
  handle('lock:unlock', (passphrase: string) => keys.unlock(passphrase));
  handle('lock:enable', (passphrase: string) => refreshCapture(keys.enable(passphrase)));
  handle('lock:disable', (passphrase: string) => refreshCapture(keys.disable(passphrase)));
  handle('lock:change', (oldPassphrase: string, newPassphrase: string) =>
    keys.change(oldPassphrase, newPassphrase),
  );
  handle('lock:lockNow', () => lockApp(keys));
  handle('lock:reset', async () => {
    clearDiagnostics();
    return refreshCapture(keys.reset());
  });
  handle('diagnostics:record', (code: unknown) => localDiagnostics().record(code));
  handle('diagnostics:clear', () => clearDiagnostics());
  handle('diagnostics:export', () => shell.showItemInFolder(localDiagnostics().export()));
  handle('diagnostics:draft', () => {
    reviewedDraft = localDiagnostics().draft(
      diagnosticEnvironment(app.getVersion(), process.platform, process.arch),
    );
    return reviewedDraft;
  });
  handle('diagnostics:open', async (draft: DiagnosticDraft, consent: boolean) => {
    if (
      consent !== true ||
      !reviewedDraft ||
      draft?.url !== reviewedDraft.url ||
      draft?.body !== reviewedDraft.body
    )
      throw new Error('Review the diagnostics and explicitly consent before opening GitHub');
    const url = reviewedDraft.url;
    reviewedDraft = null;
    await openExternal(url);
  });
  handle('app:openExternal', (url: string) => openExternal(url));
  handle('drives:providers', () => service.providers());
  handle('drives:list', () => service.drives());
  handle('drives:signIn', (provider: DriveProvider) => service.signIn(provider));
  handle('drives:cancelSignIn', () => service.cancelSignIn());
  handle('drives:protonLogin', (u: string, p: string) => service.protonLogin(u, p));
  handle('drives:protonTwoFactor', (id: string, code: string) => service.protonTwoFactor(id, code));
  handle('drives:protonCancel', (id: string) => service.protonCancel(id));
  handle('drives:listFolders', (id: string, path: string) => service.listFolders(id, path));
  handle('drives:add', (id: string, options) => service.addDrive(id, options));
  handle('drives:discardSignIn', (id: string) => service.discardSignIn(id));
  handle('drives:remove', (id: string) => service.removeDrive(id));
  handle('remote:op', (id: string, op: RemoteOp) => service.remote(id, op));
  handle('update:status', () => updater.status());
  handle('update:install', () => updater.install());
  if (e2e) {
    handle('test:remote', async (driveId: string, action: string, path?: string, text?: string) => {
      const drive = (await service.drives()).find((d) => d.id === driveId);
      if (!drive) throw new Error('Unknown drive');
      const fake = (service.connectors[drive.provider] as FakeConnector).drive(drive.id);
      if (action === 'put') return fake.put(path!, text!);
      if (action === 'read') return fake.text(path!) ?? null;
      return [...fake.nodes.keys()].sort();
    });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 480,
    minHeight: 400,
    show: false,
    title: 'MarkNotes',
    // Windows and macOS take the icon from the executable; Linux needs it on the window.
    ...(process.platform === 'linux' ? { icon: iconPath } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('render-process-gone', (_event, details) => {
    if (details.reason !== 'clean-exit') recordDiagnostic('RENDERER_EXITED');
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch(() => recordDiagnostic('LINK_FAILED'));
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      void openExternal(url).catch(() => recordDiagnostic('LINK_FAILED'));
    }
  });
  if (devServerUrl) void win.loadURL(devServerUrl);
  else void win.loadFile(indexHtml);
}

/**
 * The app needs no camera, microphone, location, notifications…: every permission is denied except writing to the
 * clipboard ("Copy link" in the editor), and only for the app page.
 */
function denyPermissions() {
  const allowed = (permission: string, url: string) =>
    permission === 'clipboard-sanitized-write' && isAppUrl(url, appUrl);
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) =>
    callback(allowed(permission, wc.getURL())),
  );
  session.defaultSession.setPermissionCheckHandler((wc, permission) =>
    allowed(permission, wc?.getURL() ?? ''),
  );
}

if (!e2e && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  try {
    diagnostics = new DiagnosticsStore(diagnosticsDirectory());
    diagnostics.init();
  } catch {
    diagnostics = undefined;
    warnDiagnosticsUnavailable('Could not open local diagnostics.');
  }
  process.on('uncaughtExceptionMonitor', () => recordDiagnostic('MAIN_UNCAUGHT'));
  // Only the code is stored; the reason stays on the console, as without a listener.
  process.on('unhandledRejection', (reason) => {
    recordDiagnostic('MAIN_REJECTION');
    console.error('Unhandled rejection in the main process:', reason);
  });
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  void app.whenReady().then(async () => {
    denyPermissions();
    const updater = createUpdater();
    const { service, storage, keys } = await createService();
    const capture = new CaptureProtection(
      join(app.getPath('userData'), 'capture-protection.json'),
      process.platform,
      () => keys.status().enabled,
      () => BrowserWindow.getAllWindows(),
      (status) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('privacy:captureChanged', status);
        }
      },
    );
    await capture.init();
    app.on('browser-window-created', (_event, win) => capture.protect(win));
    capture.refresh();
    registerIpc(service, storage, keys, updater, capture);
    powerMonitor.on('suspend', () => lockApp(keys));
    powerMonitor.on('lock-screen', () => lockApp(keys));
    createWindow();
    void updater.start();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
