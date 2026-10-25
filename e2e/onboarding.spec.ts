import { _electron as electron, expect, test, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function launch(userData: string) {
  const app = await electron.launch({
    args: process.platform === 'linux' ? ['.', '--no-sandbox'] : ['.'],
    env: { ...process.env, MARKNOTES_E2E: '1', MARKNOTES_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  });
  const page = await app.firstWindow();
  await expect(page.locator('[data-onboarding-ready]')).toBeVisible();
  return { app, page };
}

async function next(page: Page, count: number) {
  for (let i = 0; i < count; i++) {
    const title = page.locator('.driver-popover-title');
    const before = await title.innerText();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(title).not.toHaveText(before);
  }
}

async function replay(page: Page) {
  await page.getByRole('button', { name: 'Help', exact: true }).click();
  await page.getByRole('button', { name: 'Start guide' }).click();
  await expect(page.getByTestId('first-access-guide')).toBeVisible();
}

async function storedNotes(page: Page) {
  return page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const request = indexedDB.open('marknotes-enc');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const read = db.transaction('nodes').objectStore('nodes').getAll();
          read.onsuccess = () => {
            db.close();
            resolve(read.result);
          };
          read.onerror = () => {
            db.close();
            reject(read.error);
          };
        };
      }),
  );
}

for (const dismissal of ['Skip', 'Close guide', 'Escape'] as const) {
  test(`${dismissal} handles the automatic guide once and survives restart and local wipe`, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'marknotes-guide-'));
    let { app, page } = await launch(profile);
    try {
      await expect(page.getByRole('dialog', { name: 'First access guide' })).toBeVisible();
      if (dismissal === 'Escape') await page.keyboard.press('Escape');
      else await page.getByRole('button', { name: dismissal, exact: true }).click();
      await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
      await expect(page.locator('.driver-popover')).toHaveCount(0);
      await page.getByTestId('new-note').click();
      await expect(page.getByRole('dialog', { name: 'New note', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Cancel', exact: true }).click();
      await expect(page.getByTestId('entry')).toHaveCount(0);
      await app.close();
      ({ app, page } = await launch(profile));
      await expect(page.locator('[data-onboarding-ready]')).toHaveAttribute(
        'data-onboarding-ready',
        'handled',
      );
      await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(page.locator('[data-onboarding-ready]')).toHaveAttribute(
        'data-onboarding-ready',
        'handled',
      );
      await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
      await replay(page);
      await page.getByRole('button', { name: 'Skip', exact: true }).click();
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
}

test('offline demo is temporary, renderer-only, supports formatting and Finish', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'marknotes-guide-demo-'));
  const { app, page } = await launch(profile);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.context().setOffline(true);
    const before = await storedNotes(page);
    await next(page, 4);
    const demo = page.getByRole('region', { name: 'Temporary practice note' });
    const source = demo.getByRole('textbox', { name: 'Practice Markdown' });
    await source.fill('demo only');
    await source.selectText();
    await demo.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(source).toHaveValue('**demo only**');
    await demo.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(demo.locator('strong')).toHaveText('demo only');
    await demo.getByRole('button', { name: 'Edit', exact: true }).click();
    await source.fill('');
    await expect(demo.getByRole('heading', { name: 'Demo - changes are not saved' })).toBeVisible();
    await source.fill('![web](https://example.com/pixel.png)\n[not real](marknotes:abc)\n@nothing');
    await demo.getByRole('button', { name: 'Split', exact: true }).click();
    await expect(demo.locator('img')).toHaveAttribute('src', '');
    await expect(page.getByTestId('mention-popup')).toHaveCount(0);
    await page.waitForTimeout(750);
    await next(page, 2);
    await page.getByRole('button', { name: 'Finish', exact: true }).click();
    await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
    await expect(page.getByTestId('entry')).toHaveCount(0);
    expect(await storedNotes(page)).toEqual(before);
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What is Markdown?' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Tasks (read-only in preview)' })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('failed preference writes remain visible and can be retried', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'marknotes-guide-storage-'));
  const { app, page } = await launch(profile);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      (globalThis as { restoreGuideWrite?: () => void }).restoreGuideWrite = () => {
        IDBObjectStore.prototype.put = original;
      };
      IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
        if (this.name === 'settings') throw new DOMException('Disk full', 'QuotaExceededError');
        return key === undefined ? original.call(this, value) : original.call(this, value, key);
      };
    });
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Could not save guide preference');
    await expect(page.locator('[data-onboarding-ready]')).toHaveAttribute('data-onboarding-ready', 'pending');
    await page.evaluate(() => (globalThis as { restoreGuideWrite?: () => void }).restoreGuideWrite?.());
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
    await expect(page.locator('[data-onboarding-ready]')).toHaveAttribute('data-onboarding-ready', 'handled');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Help and demo preserve a real editor draft, selection, undo, mode and folder', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'marknotes-guide-workspace-'));
  const { app, page } = await launch(profile);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.getByRole('button', { name: 'New folder', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Work');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await page.locator('.tree-row').filter({ hasText: 'Work' }).click();
    await page.getByTestId('new-note').click();
    await page.getByRole('textbox', { name: 'Name' }).fill('Real note');
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    const editor = page.getByTestId('editor-field');
    await editor.click();
    await page.keyboard.insertText('real draft');
    await page.keyboard.press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(editor).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe('real draft');
    await replay(page);
    await next(page, 4);
    await page.getByRole('textbox', { name: 'Practice Markdown' }).fill('not the real note');
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(editor).toHaveText('real draft');
    await expect(editor).toBeFocused();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(editor.locator('.cm-placeholder')).toBeVisible();
    await expect(editor).not.toContainText('real draft');
    await expect(page.locator('.tree-row.current')).toContainText('Work');
    await expect(page.getByTestId('entry')).toHaveCount(1);
    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await replay(page);
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveClass('selected');
    await expect(page.locator('.driver-popover')).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('lock interruption does not handle the guide and a full reset clears it', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'marknotes-guide-lock-'));
  const { app, page } = await launch(profile);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
    await page.evaluate(async () => {
      const enabled = await window.marknotes.enableLock('correct horse');
      if (!enabled.ok) throw new Error(enabled.error);
      await window.marknotes.lockNow();
    });
    await expect(page.getByRole('heading', { name: 'MarkNotes is locked' })).toBeVisible();
    await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
    await expect(page.locator('.driver-popover')).toHaveCount(0);
    await page.getByLabel('Passphrase', { exact: true }).fill('correct horse');
    await page.getByRole('button', { name: 'Unlock', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await page.evaluate(() => window.marknotes.lockNow());
    await expect(page.getByRole('heading', { name: 'MarkNotes is locked' })).toBeVisible();
    await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

for (const width of [1200, 960]) {
  test(`reparented popovers stay beside their highlighted targets at ${width}px`, async () => {
    const profile = mkdtempSync(join(tmpdir(), 'marknotes-guide-position-'));
    const { app, page } = await launch(profile);
    try {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800),
        width,
      );
      const targets = ['new-note', 'folders', 'import', 'demo', 'settings', 'help'];
      for (const target of targets) {
        await next(page, 1);
        await expect
          .poll(() =>
            page.locator('.marknotes-guide').evaluate((popover, anchor) => {
              const element = document.querySelector(`[data-tour="${anchor}"]`);
              if (!element || !(popover instanceof HTMLElement)) return false;
              const a = element.getBoundingClientRect();
              const p = popover.getBoundingClientRect();
              const horizontal = p.left <= a.right && p.right >= a.left;
              const vertical = p.top <= a.bottom && p.bottom >= a.top;
              const beside =
                (horizontal && Math.min(Math.abs(p.bottom - a.top), Math.abs(p.top - a.bottom)) <= 32) ||
                (vertical && Math.min(Math.abs(p.right - a.left), Math.abs(p.left - a.right)) <= 32);
              return {
                anchor,
                fixed: getComputedStyle(popover).position === 'fixed',
                beside,
                target: a.toJSON(),
                popover: p.toJSON(),
              };
            }, target),
          )
          .toMatchObject({ fixed: true, beside: true });
      }
      await page.getByRole('button', { name: 'Finish', exact: true }).click();
      await expect(page.locator('.driver-popover')).toHaveCount(0);
    } finally {
      await app.close();
      rmSync(profile, { recursive: true, force: true });
    }
  });
}

test('keyboard focus stays in guide/demo with reduced motion in a tiny window', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'marknotes-guide-small-'));
  const { app, page } = await launch(profile);
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(480, 400));
    for (let step = 0; step < 7; step++) {
      await expect(page.getByRole('dialog', { name: 'First access guide' })).toBeVisible();
      await expect
        .poll(async () => {
          const box = await page.locator('.marknotes-guide').boundingBox();
          const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
          return (
            !!box &&
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= size.width + 1 &&
            box.y + box.height <= size.height + 1
          );
        })
        .toBe(true);
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press('Tab');
        expect(
          await page.evaluate(() => !!document.activeElement?.closest('.marknotes-guide, .guide-demo')),
        ).toBe(true);
      }
      const reduced = await page
        .locator('.marknotes-guide')
        .evaluate((element) => getComputedStyle(element).animationName);
      expect(reduced).toBe('none');
      const button = page.getByRole('button', { name: step === 6 ? 'Finish' : 'Next', exact: true });
      await button.click();
    }
    await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Enter advances rather than dismissing, and Tab reaches every guide control', async () => {
  const profile = mkdtempSync(join(tmpdir(), 'marknotes-guide-keys-'));
  const { app, page } = await launch(profile);
  try {
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Your folders and notes' })).toBeVisible();
    await expect(page.locator('[data-onboarding-ready]')).toHaveAttribute('data-onboarding-ready', 'pending');
    await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeFocused();
    for (const name of ['Close guide', 'Skip', 'Back', 'Next']) {
      await page.keyboard.press('Tab');
      await expect(page.getByRole('button', { name, exact: true })).toBeFocused();
    }
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
