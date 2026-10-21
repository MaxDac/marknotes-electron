import { app, BrowserWindow, ipcMain, safeStorage, shell } from 'electron';
import { join } from 'node:path';
import type { RemoteOp } from '../preload/api';
import type { DriveProvider } from '../shared/types';
import { FakeConnector } from './connectors/fake';
import { createConnectors } from './connectors/registry';
import type { DriveConnector } from './connectors/types';
import { PRERELEASE_BUILD } from './config';
import { DriveService } from './driveService';
import { loadElectronUpdater, UpdateController } from './updater';
import { FileSecretVault } from './vault';

const e2e = process.env.MARKNOTES_E2E === '1';
if (process.env.MARKNOTES_USER_DATA) app.setPath('userData', process.env.MARKNOTES_USER_DATA);

const openExternal = async (url: string) => {
  if (!/^https?:\/\//i.test(url)) throw new Error('Only web links can be opened');
  await shell.openExternal(url);
};

function createService(): DriveService {
  const userData = app.getPath('userData');
  let connectors: Record<DriveProvider, DriveConnector>;
  if (e2e) {
    connectors = {
      proton: new FakeConnector('proton'),
      dropbox: new FakeConnector('dropbox'),
      onedrive: new FakeConnector('onedrive'),
    };
  } else {
    const vault = new FileSecretVault(join(userData, 'credentials.bin'), safeStorage);
    connectors = createConnectors({ vault, openExternal });
  }
  return new DriveService(join(userData, 'drives.json'), connectors);
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    const user = (e as { userMessage?: unknown }).userMessage;
    return typeof user === 'string' && user ? user : e.message;
  }
  return String(e);
}

function handle(channel: string, fn: (...args: never[]) => unknown) {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
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

function registerIpc(service: DriveService, updater: UpdateController) {
  handle('app:deviceId', () => service.deviceId());
  handle('app:openExternal', (url: string) => openExternal(url));
  handle('drives:providers', () => service.providers());
  handle('drives:list', () => service.drives());
  handle('drives:signIn', (provider: DriveProvider) => service.signIn(provider));
  handle('drives:cancelSignIn', () => service.cancelSignIn());
  handle('drives:protonLogin', (u: string, p: string) => service.protonLogin(u, p));
  handle('drives:protonTwoFactor', (id: string, code: string) => service.protonTwoFactor(id, code));
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
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '../renderer/index.html'));
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
  void app.whenReady().then(() => {
    const updater = createUpdater();
    registerIpc(createService(), updater);
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
