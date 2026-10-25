import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { dismissFirstAccessGuide } from './onboarding';

const supported = process.platform === 'win32' || process.platform === 'darwin';
const exec = promisify(execFile);

test.setTimeout(120_000);

async function launch(userData: string) {
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    env: { ...process.env, MARKNOTES_E2E: '1', MARKNOTES_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  });
  const page = await app.firstWindow();
  await dismissFirstAccessGuide(page);
  await expect(page.getByRole('heading', { name: /MarkNotes/ })).toBeVisible();
  return { app, page };
}

async function status(page: Page) {
  return page.evaluate(async () => {
    const result = await window.marknotes.captureProtection();
    if (!result.ok) throw new Error(result.error);
    return result.value;
  });
}

async function enableLock(page: Page) {
  await page.getByRole('button', { name: 'Turn on app lock' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New passphrase', { exact: true }).fill('correct horse');
  await dialog.getByLabel('Repeat the new passphrase').fill('correct horse');
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await expect.poll(() => status(page)).toMatchObject({ forced: true, enabled: supported });
}

async function deleteLocalData(page: Page) {
  await page.getByRole('button', { name: 'Delete all local data' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MarkNotes', exact: true })).toBeVisible();
  await dismissFirstAccessGuide(page);
}

/** Query the OS, not a JS mock, to check Electron's native Windows integration. */
async function expectNativeProtection(app: ElectronApplication, enabled: boolean) {
  if (supported) {
    const values = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().map((win) => win.isContentProtected()),
    );
    expect(values.length).toBeGreaterThan(0);
    for (const value of values) expect(value).toBe(enabled);
  }
  if (process.platform !== 'win32') return;
  const handles = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((win) => win.getNativeWindowHandle().readBigUInt64LE().toString()),
  );
  const { stdout } = await exec('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class CaptureAffinity { [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity); }'; foreach ($handle in @(${handles.join(',')})) { $affinity = [uint32]0; if (-not [CaptureAffinity]::GetWindowDisplayAffinity([IntPtr][long]$handle, [ref]$affinity)) { throw "GetWindowDisplayAffinity failed" }; $affinity }`,
  ]);
  expect(stdout.trim().split(/\s+/).map(Number)).toEqual(handles.map(() => (enabled ? 0x11 : 0)));
}

async function anotherWindow(app: ElectronApplication, enabled: boolean, recreate = false) {
  const result = await app.evaluate(
    ({ app, BrowserWindow }, { recreate, preload }) => {
      const first = BrowserWindow.getAllWindows()[0];
      const calls: { enabled: boolean; visible: boolean; url: string }[] = [];
      app.prependOnceListener('browser-window-created', (_event, window) => {
        const original = window.setContentProtection.bind(window);
        window.setContentProtection = (value: boolean) => {
          calls.push({ enabled: value, visible: window.isVisible(), url: window.webContents.getURL() });
          original(value);
        };
      });
      if (recreate) {
        // Keep this test process alive on Windows/Linux to exercise the app's macOS activation path.
        app.removeAllListeners('window-all-closed');
        for (const window of BrowserWindow.getAllWindows()) window.destroy();
        app.emit('activate');
        return { id: BrowserWindow.getAllWindows()[0].id, calls };
      }
      const window = new BrowserWindow({
        show: false,
        webPreferences: {
          preload,
          contextIsolation: true,
          sandbox: true,
          nodeIntegration: false,
        },
      });
      void window.loadURL(first.webContents.getURL());
      return { id: window.id, calls };
    },
    { recreate, preload: join(process.cwd(), 'out', 'preload', 'index.cjs') },
  );
  expect(result.calls).toEqual(supported ? [{ enabled, visible: false, url: '' }] : []);
  return result.id;
}

test('capture preference persists, protects future windows before load, and updates every window', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'marknotes-capture-e2e-'));
  let { app, page } = await launch(userData);
  try {
    expect(await status(page)).toMatchObject({ requested: false, supported, enabled: false });
    await expectNativeProtection(app, false);
    await page.getByRole('button', { name: 'Settings' }).click();
    const toggle = page.getByRole('switch', { name: 'Protect notes from screen capture' });
    await expect(page.getByText(/including ScreenCaptureKit/)).toBeVisible();
    if (!supported) {
      await expect(toggle).toBeDisabled();
      await expect(page.getByText('Capture protection is not available on this platform.')).toBeVisible();
      await anotherWindow(app, false);
      return;
    }
    await toggle.click();
    await expect.poll(() => status(page)).toMatchObject({ requested: true, enabled: true });
    await expectNativeProtection(app, true);
    const id = await anotherWindow(app, true);
    await expectNativeProtection(app, true);
    await toggle.click();
    await expect.poll(() => status(page)).toMatchObject({ requested: false, enabled: false });
    await expectNativeProtection(app, false);
    await toggle.click();
    await expect.poll(() => status(page)).toMatchObject({ requested: true, enabled: true });
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), id);
    await app.close();
    ({ app, page } = await launch(userData));
    expect(await status(page)).toMatchObject({ requested: true, enabled: true });
    await expectNativeProtection(app, true);
    await anotherWindow(app, true);
    await anotherWindow(app, true, true);
    page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'MarkNotes', exact: true })).toBeVisible();
    await expectNativeProtection(app, true);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('app lock forces protection on startup, disable and reset restore the device preference', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'marknotes-capture-lock-'));
  let { app, page } = await launch(userData);
  try {
    await page.getByRole('button', { name: 'Settings' }).click();
    await anotherWindow(app, false);
    await enableLock(page);
    await expect
      .poll(() => status(page))
      .toMatchObject({ requested: false, forced: true, enabled: supported });
    await expectNativeProtection(app, supported);
    const toggle = page.getByRole('switch', { name: 'Protect notes from screen capture' });
    await expect(toggle).toBeDisabled();
    if (supported) await expect(toggle).toBeChecked();
    const rejected = await page.evaluate(() => window.marknotes.setCaptureProtection(false));
    expect(rejected.ok).toBe(false);
    await app.close();
    ({ app, page } = await launch(userData));
    await expect(page.getByRole('heading', { name: 'MarkNotes is locked' })).toBeVisible();
    expect(await status(page)).toMatchObject({ forced: true, enabled: supported });
    await expectNativeProtection(app, supported);
    await anotherWindow(app, supported);
    await page.getByLabel('Passphrase').fill('correct horse');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'MarkNotes', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Turn off app lock' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Passphrase', { exact: true }).fill('correct horse');
    await dialog.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect.poll(() => status(page)).toMatchObject({ forced: false });
    expect(await status(page)).toMatchObject({ requested: false, forced: false, enabled: false });
    await expectNativeProtection(app, false);

    if (supported) {
      expect((await page.evaluate(() => window.marknotes.setCaptureProtection(true))).ok).toBe(true);
    }
    await enableLock(page);
    await deleteLocalData(page);
    expect(await status(page)).toMatchObject({ forced: true, enabled: supported });
    await expectNativeProtection(app, supported);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Lock now' }).click();
    await expect(page.getByRole('heading', { name: 'MarkNotes is locked' })).toBeVisible();
    await deleteLocalData(page);
    expect(await status(page)).toMatchObject({ requested: supported, forced: false, enabled: supported });
    await expectNativeProtection(app, supported);
    await app.close();
    ({ app, page } = await launch(userData));
    expect(await status(page)).toMatchObject({ requested: supported, forced: false, enabled: supported });
    await expectNativeProtection(app, supported);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
