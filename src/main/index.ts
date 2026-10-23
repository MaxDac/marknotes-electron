import { app, BrowserWindow, ipcMain, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import iconPath from '../../build/icon.png?asset';
import type { RemoteOp } from '../preload/api';
import type { DriveProvider } from '../shared/types';
import { FakeConnector } from './connectors/fake';
import { createConnectors } from './connectors/registry';
import type { DriveConnector } from './connectors/types';
import { PRERELEASE_BUILD } from './config';
import { DriveService } from './driveService';
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

const openExternal = async (url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened');
  await shell.openExternal(url);
};

async function createService(): Promise<{ service: DriveService; storage: SecureStorageStatus }> {
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
  return { service: new DriveService(join(userData, 'drives.json'), connectors), storage };
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
      return { ok: false, error: errorMessage(e) };
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
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:changed', status);
    },
  );
}

function registerIpc(service: DriveService, storage: SecureStorageStatus, updater: UpdateController) {
  handle('app:deviceId', () => service.deviceId());
  handle('app:secureStorage', () => storage);
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
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url).catch(() => undefined);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      void openExternal(url).catch(() => undefined);
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
    const { service, storage } = await createService();
    registerIpc(service, storage, updater);
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
