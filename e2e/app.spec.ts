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

test('settings link to the other MarkNotes apps in the browser', async () => {
  const userData = newUserData();
  const { app, page } = await launch(userData);
  try {
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      (globalThis as { openedUrls?: string[] }).openedUrls = opened;
      shell.openExternal = async (url: string) => {
        opened.push(url);
      };
    });
    await page.getByRole('button', { name: 'Settings' }).click();
    const links = page.getByTestId('other-apps').getByRole('button');
    await expect(links).toHaveText([
      'MarkNotes for Android (F-Droid)',
      'MarkNotes Pro for Android (GitHub Releases)',
      'MarkNotes Web',
    ]);
    await page.getByRole('button', { name: 'MarkNotes Web' }).click();
    await expect
      .poll(() => app.evaluate(() => (globalThis as { openedUrls?: string[] }).openedUrls))
      .toEqual(['https://marknotes.fly.dev']);
    await expect(page.getByRole('alert')).toHaveCount(0);
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

test('reconnect sync is off by default and its device setting survives restart', async () => {
  const userData = newUserData();
  let { app, page } = await launch(userData);
  try {
    await page.getByRole('button', { name: 'Settings' }).click();
    const toggle = page.getByRole('switch', { name: 'Sync when reconnected' });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect(toggle).toBeChecked();
    // Enabled again once the setting is saved.
    await expect(toggle).toBeEnabled();
    await app.close();
    ({ app, page } = await launch(userData));
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('switch', { name: 'Sync when reconnected' })).toBeChecked();
    await page.getByRole('switch', { name: 'Sync when reconnected' }).uncheck();
    await expect(page.getByRole('switch', { name: 'Sync when reconnected' })).toBeEnabled();
    await app.close();
    ({ app, page } = await launch(userData));
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('switch', { name: 'Sync when reconnected' })).not.toBeChecked();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('foreground reconnect downloads notes only after opt-in and a new network transition', async () => {
  const userData = newUserData();
  const { app, page } = await launch(userData);
  const transition = async () => {
    await page.context().setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
    await page.context().setOffline(false);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  };
  try {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Add drive' }).click();
    await page.getByRole('button', { name: 'Dropbox', exact: true }).click();
    await expect(page.getByText('Signed in to Dropbox as test@example.com')).toBeVisible();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByTestId('sync-message')).toContainText('↑0 ↓0');
    await page.evaluate(() =>
      window.marknotes.testRemote!('dropbox:test', 'put', 'MarkNotes/Reconnected.md', 'from another device'),
    );
    await transition();
    await page.waitForTimeout(2300);
    const entry = page.getByTestId('entry').filter({ hasText: 'Reconnected' });
    await expect(entry).toHaveCount(0);
    await page.getByRole('switch', { name: 'Sync when reconnected' }).check();
    await page.waitForTimeout(2300);
    await expect(entry).toHaveCount(0);
    await transition();
    await expect(page.getByTestId('sync-message')).toContainText('↓1');
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(entry).toBeVisible();
    await entry.click();
    await expect(page.getByTestId('editor-field')).toContainText('from another device');
  } finally {
    await page.context().setOffline(false);
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

for (const provider of ['Dropbox', 'OneDrive', 'Proton Drive']) {
  test(`reconnects ${provider} without a folder chooser or changing the drive configuration`, async () => {
    const userData = newUserData();
    const { app, page } = await launch(userData);
    const signIn = async () => {
      await page.getByRole('button', { name: provider, exact: true }).click();
      if (provider === 'Proton Drive') {
        await expect(
          page.getByText('This is a third-party application not officially supported by Proton.'),
        ).toBeVisible();
        await page.getByLabel('Username or email').fill('test@example.com');
        await page.getByLabel('Password', { exact: true }).fill('secret');
        await page.getByRole('button', { name: 'Log in', exact: true }).click();
      }
    };
    try {
      await page.getByRole('button', { name: 'Settings' }).click();
      await page.getByRole('button', { name: 'Add drive' }).click();
      await signIn();
      if (provider === 'Proton Drive') {
        await page.getByLabel('Folder in My files').fill('Personal notes');
      } else {
        await page.getByTestId('folder-picker').getByText('Documents').click();
        await page.getByLabel('Folder name', { exact: true }).fill('Personal notes');
      }
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
      const before = await page.evaluate(() => window.marknotes.drives());
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Reconnect drive' })).toBeVisible();
      await signIn();
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
      await expect(page.getByTestId('folder-picker')).toHaveCount(0);
      expect(await page.evaluate(() => window.marknotes.drives())).toEqual(before);
      await expect(page.getByTestId('drive')).toContainText('Personal notes');
      await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
    } finally {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    }
  });
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

async function setChordSequences(page: Page, enabled: boolean) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const toggle = page.getByRole('switch', { name: 'Chord sequences' });
  await toggle.setChecked(enabled);
  await page.getByRole('button', { name: 'Back' }).click();
}

test('chord sequence creation is hidden until enabled in the settings', async () => {
  const userData = newUserData();
  let { app, page } = await launch(userData);
  try {
    await expect(page.getByTestId('empty-new-note')).toBeVisible();
    await expect(page.getByTestId('new-chords')).toHaveCount(0);
    await expect(page.getByTestId('empty-new-chords')).toHaveCount(0);
    await expect(page.getByTestId('pane-new-chords')).toHaveCount(0);

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('switch', { name: 'Chord sequences' })).not.toBeChecked();
    await page.getByRole('switch', { name: 'Chord sequences' }).check();
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.getByTestId('new-chords')).toBeVisible();
    await expect(page.getByTestId('empty-new-chords')).toBeVisible();

    await app.close();
    ({ app, page } = await launch(userData));
    await expect(page.getByTestId('new-chords')).toBeVisible();
    await setChordSequences(page, false);
    await expect(page.getByTestId('new-chords')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('opening a chord sequence while the setting is off asks to enable it', async () => {
  const userData = newUserData();
  const { app, page } = await launch(userData);
  try {
    await createNote(page, 'Plain');
    await setChordSequences(page, true);
    await page.getByTestId('new-chords').click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Songs');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('chord-editor')).toBeVisible();
    await setChordSequences(page, false);
    await page.getByTestId('entry').filter({ hasText: 'Plain' }).click();
    await expect(page.getByTestId('note-title')).toHaveText('Plain');

    // Cancel: the note is not opened and the app stays where it was.
    const songs = page.getByTestId('entry').filter({ hasText: 'Songs' });
    await songs.click();
    const prompt = page.getByRole('dialog', { name: 'Enable chord sequences?' });
    await expect(prompt).toContainText('Songs');
    await prompt.getByRole('button', { name: 'Cancel' }).click();
    await expect(prompt).toBeHidden();
    await expect(page.getByTestId('note-title')).toHaveText('Plain');
    await expect(page.getByTestId('new-chords')).toHaveCount(0);

    // Enable: the setting turns on and the note opens in the chord editor.
    await songs.click();
    await prompt.getByRole('button', { name: 'Enable' }).click();
    await expect(page.getByTestId('chord-editor')).toBeVisible();
    await expect(page.getByTestId('new-chords')).toBeVisible();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('switch', { name: 'Chord sequences' })).toBeChecked();
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('empty states offer to create a note or a chord sequence', async () => {
  const userData = newUserData();
  const { app, page } = await launch(userData);
  try {
    await setChordSequences(page, true);
    await expect(page.getByText('No notes here yet')).toBeVisible();
    await expect(page.getByTestId('empty-new-note')).toBeVisible();
    await expect(page.getByTestId('pane-new-note')).toBeVisible();
    await expect(page.getByTestId('pane-new-chords')).toBeVisible();

    await page.getByTestId('empty-new-chords').click();
    await expect(page.getByRole('dialog')).toContainText('New chord sequence');
    await page.getByRole('textbox', { name: 'Name' }).fill('Riffs');
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.getByTestId('chord-editor')).toBeVisible();
    await expect(page.getByTestId('entry').filter({ hasText: 'Riffs' })).toContainText('🎸');
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('bass fret 12 marker is rendered after the fret without changing guitar or other frets', async () => {
  const userData = newUserData();
  const { app, page } = await launch(userData);
  try {
    await setChordSequences(page, true);
    await page.getByTestId('new-chords').click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Fret markers');
    await page.getByRole('button', { name: 'Create' }).click();
    const fretboard = page.getByTestId('fretboard');
    await expect(fretboard).toBeVisible();

    const borders = () =>
      fretboard.locator('.string-row button.fret').evaluateAll((cells) =>
        cells.map((cell) => {
          const style = getComputedStyle(cell);
          return {
            label: cell.getAttribute('aria-label'),
            left: style.borderLeftWidth,
            right: style.borderRightWidth,
            rightStyle: style.borderRightStyle,
            rightColour: style.borderRightColor,
          };
        }),
      );
    const guitarBorders = await borders();
    expect(guitarBorders).toHaveLength(6 * 24);
    for (const border of guitarBorders) {
      expect(border).toMatchObject({ left: '0px', right: '1px', rightStyle: 'solid' });
    }
    await expect(fretboard.locator('.red-line-fret')).toHaveCount(0);

    await page.getByRole('button', { name: 'Bass', exact: true }).click();
    const header = fretboard.locator('.fret-header .red-line-fret');
    await expect(header).toHaveText('12');
    const red = await header.evaluate((cell) => getComputedStyle(cell).color);
    const bassBorders = await borders();
    expect(bassBorders).toHaveLength(4 * 16);
    expect(bassBorders.filter((border) => border.label?.endsWith(' fret 12'))).toHaveLength(4);
    for (const border of bassBorders) {
      if (border.label?.endsWith(' fret 12')) {
        expect(border).toMatchObject({
          left: '0px',
          right: '3px',
          rightStyle: 'solid',
          rightColour: red,
        });
      } else {
        expect(border).toMatchObject({ left: '0px', right: '1px', rightStyle: 'solid' });
        expect(border.rightColour).not.toBe(red);
      }
    }

    await page.getByRole('button', { name: 'Guitar', exact: true }).click();
    await expect(fretboard.locator('.red-line-fret')).toHaveCount(0);
    expect(await borders()).toEqual(guitarBorders);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('chord sequences open in the chord editor and fall back to text on parse errors', async () => {
  const userData = newUserData();
  let { app, page } = await launch(userData);

  await setChordSequences(page, true);
  await page.getByTestId('new-chords').click();
  await page.getByRole('textbox', { name: 'Name' }).fill('Songs');
  await page.getByRole('button', { name: 'Create' }).click();
  const chordEditor = page.getByTestId('chord-editor');
  await expect(chordEditor).toBeVisible();
  await expect(page.getByTestId('entry').filter({ hasText: 'Songs' })).toContainText('🎸');

  // Too few strings first, then a C major shape.
  await page.getByTestId('chord-name').fill('C');
  await page.getByTestId('save-chord').click();
  await expect(page.getByTestId('chord-errors')).toContainText('Select at least three non-muted strings.');
  await page.getByRole('button', { name: 'A2 fret 3', exact: true }).click();
  await page.getByRole('combobox', { name: 'Finger for A2' }).selectOption('3');
  await page.getByRole('button', { name: 'D3 fret 2', exact: true }).click();
  await page.getByRole('combobox', { name: 'Finger for D3' }).selectOption('2');
  await page.getByRole('button', { name: 'Open G3' }).click();
  await page.getByRole('button', { name: 'B3 fret 1', exact: true }).click();
  await page.getByRole('button', { name: 'Open E4' }).click();
  await page.getByTestId('save-chord').click();
  await expect(page.getByTestId('chord-card')).toHaveCount(1);
  await expect(page.getByTestId('chord-card')).toContainText('1 C');

  // Duplicates get the next sequence number.
  await page.getByTestId('chord-card').getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByTestId('chord-card')).toHaveCount(2);
  await expect(page.getByTestId('chord-card').nth(1)).toContainText('2 C');

  await page.getByTestId('view-as-text').click();
  const editor = page.getByTestId('editor-field');
  await expect(editor).toContainText('## C (guitar)');
  await expect(editor).toContainText('frets: x 3/3 2/2 0 1/1 0');

  // A line before the first heading breaks parsing: the text editor stays with an error banner.
  await editor.click();
  await page.keyboard.press('Control+Home');
  await page.keyboard.type('oops');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chord-parse-error')).toContainText('Line 1: Expected a chord heading.');
  await expect(page.getByTestId('open-chord-editor')).toBeDisabled();

  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('chord-parse-error')).toBeHidden();
  await page.getByTestId('open-chord-editor').click();
  await expect(page.getByTestId('chord-card')).toHaveCount(2);

  await page.waitForTimeout(800);
  await app.close();
  ({ app, page } = await launch(userData));
  await page.getByTestId('entry').filter({ hasText: 'Songs' }).click();
  await expect(page.getByTestId('chord-card')).toHaveCount(2);
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

test('@ links to other notes and inserts images', async () => {
  const userData = newUserData();
  const { app, page } = await launch(userData);
  try {
    await createNote(page, 'Target');
    await page.getByTestId('editor-field').click();
    await page.keyboard.type('target body');
    await page.waitForTimeout(800);

    await createNote(page, 'Source');
    await page.getByTestId('editor-field').click();
    await page.keyboard.type('see @targ');
    const popup = page.getByTestId('mention-popup');
    await expect(popup).toBeVisible();
    const option = popup.getByTestId('mention-option').filter({ hasText: 'Target' });
    await expect(option).toHaveCount(1);
    const id = (await option.getByTestId('note-id').textContent())!.trim();
    expect(id).toMatch(/^[0-9a-hjkmnp-tv-z]{8}$/);
    await page.keyboard.press('Enter');
    await expect(popup).toBeHidden();
    await expect(page.getByTestId('editor-field')).toContainText(`see [Target](marknotes:${id})`);
    // The front-matter header stays hidden from the editor.
    await expect(page.getByTestId('editor-field')).not.toContainText('id:');

    // A tiny 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    await page
      .getByTestId('image-input')
      .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
    await expect(page.getByTestId('editor-field')).toContainText(
      /!\[dot\]\(attachments\/[0-9a-f]{64}\.png\)/,
    );
    const preview = page.getByTestId('markdown-preview');
    await expect(preview.locator('img')).toHaveAttribute('src', /^blob:/);

    await preview.getByRole('link', { name: 'Target' }).click();
    await expect(page.getByTestId('note-title')).toHaveText('Target');
    await expect(page.getByTestId('editor-field')).toContainText('target body');
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});

test('syncs with a drive and merges a conflicted copy back', async () => {
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
  const uploaded = await remote('read', 'Documents/MarkNotes/Shared.md');
  // New notes carry their id in a front-matter header that the editor hides.
  const header = /^---\nid: [0-9a-hjkmnp-tv-z]{8}\n---\n/.exec(
    uploaded.ok ? String(uploaded.value) : '',
  )?.[0];
  expect(header).toBeTruthy();
  expect(uploaded).toEqual({ ok: true, value: `${header}line one` });

  // A note created on another device comes down.
  await remote('put', 'Documents/MarkNotes/Remote.md', 'from the drive');
  await page.getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByTestId('sync-message')).toContainText('↑0 ↓1');

  // Both sides change the same line: the newest version (this device's) is kept, the drive's becomes a copy.
  await remote('put', 'Documents/MarkNotes/Shared.md', `${header}line theirs`);
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('entry').filter({ hasText: 'Shared' }).click();
  await page.getByTestId('editor-field').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('line mine');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.getByRole('button', { name: /Sync conflicts/ }).click();
  const conflict = page.getByTestId('conflict');
  await expect(conflict).toContainText(
    'Changed on this device and on Dropbox (test@example.com). The newest version (from this device) was kept; ' +
      'the version from Dropbox (test@example.com) was saved as Shared (conflicted copy).md.',
  );
  expect(await remote('read', 'Documents/MarkNotes/Shared.md')).toEqual({
    ok: true,
    value: `${header}line mine`,
  });
  const copy = await remote('read', 'Documents/MarkNotes/Shared (conflicted copy).md');
  expect(copy.ok && String(copy.value).endsWith('\n---\nline theirs')).toBe(true);
  expect(copy.ok && String(copy.value).startsWith(header!)).toBe(false);

  // Merge the copy back, taking its version of the line.
  await conflict.getByRole('button', { name: 'Merge copy back' }).click();
  await expect(conflict).toContainText('Kept version');
  await expect(conflict).toContainText('Conflicted copy');
  await conflict.getByRole('button', { name: 'Copy', exact: true }).click();
  await conflict.getByRole('button', { name: 'Save merge' }).click();
  await expect(page.getByText('No conflicts')).toBeVisible();
  await expect
    .poll(() => remote('read', 'Documents/MarkNotes/Shared.md'))
    .toEqual({ ok: true, value: `${header}line theirs` });
  await expect
    .poll(() => remote('read', 'Documents/MarkNotes/Shared (conflicted copy).md'))
    .toEqual({ ok: true, value: null });

  // Disconnect keeps the notes.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('sync-message')).toHaveText('Disconnected test@example.com');
  await expect(page.getByTestId('drive')).toHaveCount(0);
  await app.close();
});
