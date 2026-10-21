import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function launch(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    // Ubuntu 24.04 runners block the Chromium sandbox (AppArmor userns restrictions).
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    env: { ...process.env, MARKNOTES_E2E: '1', MARKNOTES_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  });
  const page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'MarkNotes' })).toBeVisible();
  return { app, page };
}

const newUserData = () => mkdtempSync(join(tmpdir(), 'marknotes-e2e-'));

test('offers real Dropbox and OneDrive connections without environment configuration', async () => {
  const userData = newUserData();
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    env: {
      ...process.env,
      MARKNOTES_E2E: '0',
      MARKNOTES_USER_DATA: userData,
      ELECTRON_RENDERER_URL: '',
      DROPBOX_APP_KEY: '',
      MSAL_CLIENT_ID: '',
    },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole('heading', { name: 'MarkNotes' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Add drive' }).click();
    await expect(page.getByRole('button', { name: 'Dropbox', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'OneDrive', exact: true })).toBeEnabled();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('loads the real updater without checking for releases', async () => {
  const userData = newUserData();
  const { app } = await launch(userData);
  try {
    expect(
      await app.evaluate(({ app }) => {
        const mod: typeof import('electron-updater') = process
          .getBuiltinModule('module')
          .createRequire(`${app.getAppPath()}/package.json`)('electron-updater');
        const updater = mod.autoUpdater;
        return {
          check: typeof updater.checkForUpdates,
          install: typeof updater.quitAndInstall,
          download: typeof updater.downloadUpdate,
        };
      }),
    ).toEqual({ check: 'function', install: 'function', download: 'function' });
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

async function createNote(page: Page, name: string) {
  await page.getByTestId('new-note').click();
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('note-title')).toHaveText(name);
}

test('notes, folders, editor and preview persist across restarts', async () => {
  const userData = newUserData();
  let { app, page } = await launch(userData);

  await page.getByRole('button', { name: 'New folder' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Work');
  await page.getByRole('button', { name: 'Create' }).click();
  await page.getByRole('navigation', { name: 'Folders' }).getByText('Work').click();

  await createNote(page, 'Plan');
  const editor = page.getByTestId('editor-field');
  await editor.click();
  await page.keyboard.type('# Hello');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- milk');
  await page.keyboard.press('Enter');
  await page.keyboard.type('eggs');
  await expect(editor).toContainText('- eggs');

  const preview = page.getByTestId('markdown-preview');
  await expect(preview.locator('h1')).toHaveText('Hello');
  await expect(preview.locator('li')).toHaveText(['milk', 'eggs']);

  await page.getByRole('button', { name: 'Bold' }).click();
  await page.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByTestId('format-toolbar')).toBeHidden();

  // Let autosave run, then restart.
  await page.waitForTimeout(800);
  await app.close();
  ({ app, page } = await launch(userData));
  await page.getByRole('navigation', { name: 'Folders' }).getByText('Work').click();
  await page.getByTestId('entry').filter({ hasText: 'Plan' }).click();
  await expect(page.getByTestId('editor-field')).toContainText('# Hello');

  // Rename, move to the root and delete.
  await page.getByTestId('entry').filter({ hasText: 'Plan' }).getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Roadmap');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.getByTestId('note-title')).toHaveText('Roadmap');

  await page
    .getByTestId('entry')
    .filter({ hasText: 'Roadmap' })
    .getByRole('button', { name: 'More' })
    .click();
  await page.getByRole('menuitem', { name: 'Move to…' }).click();
  await page.getByRole('dialog').getByText('All notes').click();
  await expect(page.getByText('No notes here yet')).toBeVisible();
  await page.getByRole('navigation', { name: 'Folders' }).getByText('All notes').click();
  await expect(page.getByTestId('entry').filter({ hasText: 'Roadmap' })).toBeVisible();

  await page.getByTestId('entry').filter({ hasText: 'Work' }).getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(page.getByText('The folder and all its notes will be deleted.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId('entry')).toHaveCount(1);
  await app.close();
});

test('appearance settings apply and persist', async () => {
  const userData = newUserData();
  let { app, page } = await launch(userData);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.getByRole('radio', { name: 'Teal' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByText('Colour: Teal')).toBeVisible();
  await app.close();
  ({ app, page } = await launch(userData));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await app.close();
});

test('syncs with a drive and resolves a conflict', async () => {
  const { app, page } = await launch(newUserData());
  await createNote(page, 'Shared');
  await page.getByTestId('editor-field').click();
  await page.keyboard.type('line one');
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('No drives connected. Notes are only stored on this device.')).toBeVisible();
  await page.getByRole('button', { name: 'Add drive' }).click();
  await page.getByRole('button', { name: 'Dropbox' }).click();
  await expect(page.getByText('Signed in to Dropbox as test@example.com')).toBeVisible();
  await page.getByTestId('folder-picker').getByText('Documents').click();
  await expect(page.getByText('Notes will be synced to /Documents/MarkNotes')).toBeVisible();
  await page.getByRole('button', { name: 'Connect' }).click();

  await expect(page.getByTestId('drive')).toContainText('Folder: /Documents/MarkNotes');
  await expect(page.getByTestId('sync-message')).toContainText('test@example.com: ↑1 ↓0');
  const remote = (action: 'put' | 'read', path: string, text?: string) =>
    page.evaluate(
      async ([a, p, t]) =>
        window.marknotes.testRemote!('dropbox:test', a as 'put' | 'read', p, t ?? undefined),
      [action, path, text ?? null] as const,
    );
  expect(await remote('read', 'Documents/MarkNotes/Shared.md')).toEqual({ ok: true, value: 'line one' });

  // A note created on another device comes down.
  await remote('put', 'Documents/MarkNotes/Remote.md', 'from the drive');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-message')).toContainText('↑0 ↓1');

  // Both sides change the same line: conflict.
  await remote('put', 'Documents/MarkNotes/Shared.md', 'line theirs');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('entry').filter({ hasText: 'Shared' }).click();
  await page.getByTestId('editor-field').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('line mine');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.getByRole('button', { name: /Sync conflicts/ }).click();
  const conflict = page.getByTestId('conflict');
  await expect(conflict).toContainText('Changed on this device and on Dropbox (test@example.com).');
  await conflict.getByRole('button', { name: 'Theirs', exact: true }).click();
  await conflict.getByRole('button', { name: 'Save merge' }).click();
  await expect(page.getByText('No conflicts')).toBeVisible();
  expect(await remote('read', 'Documents/MarkNotes/Shared.md')).toEqual({ ok: true, value: 'line theirs' });

  // Disconnect keeps the notes.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('sync-message')).toHaveText('Disconnected test@example.com');
  await expect(page.getByTestId('drive')).toHaveCount(0);
  await app.close();
});
