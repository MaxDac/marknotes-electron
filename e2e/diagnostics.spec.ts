import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures';

test('diagnostics are sanitized, offline, reviewed and explicitly consented before opening GitHub', async ({
  launch,
  userData,
}) => {
  const { app, page } = await launch({ headingTimeout: 15_000 });
  await app.evaluate(({ shell }) => {
    const state = { urls: [] as string[], exports: [] as string[] };
    (globalThis as { diagnosticTest?: typeof state }).diagnosticTest = state;
    shell.openExternal = async (url) => {
      state.urls.push(url);
    };
    shell.showItemInFolder = (path) => {
      state.exports.push(path);
    };
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Clear logs', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('cleared');
  await page.evaluate(async () => {
    const result = await window.marknotes.recordDiagnostic('SAVE_FAILED');
    if (!result.ok) throw new Error(result.error);
    const remote = await window.marknotes.remote('secret private account identifier', { op: 'snapshot' });
    if (remote.ok) throw new Error('Expected a handled drive error');
    setTimeout(() => {
      throw new Error('secret note /private/path account@example.com token=secret');
    }, 0);
  });
  await expect
    .poll(() => readFileSync(join(userData, 'diagnostics', 'errors.jsonl'), 'utf8'))
    .toContain('RENDERER_UNCAUGHT');
  const stored = readFileSync(join(userData, 'diagnostics', 'errors.jsonl'), 'utf8');
  expect(stored).not.toMatch(/secret|private|account@|token/);
  expect(stored).toContain('DRIVE_FAILED');
  await page.getByRole('button', { name: 'Export logs', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Offline export');
  const exported = readFileSync(join(userData, 'diagnostics', 'export.txt'), 'utf8');
  expect(exported).toContain('SAVE_FAILED');
  expect(exported).toContain('RENDERER_UNCAUGHT');
  expect(exported).not.toMatch(/secret|private|account@|token/);
  await page.getByRole('button', { name: 'Report a problem', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review diagnostic report' });
  await expect(dialog).toContainText('before you submit');
  await expect(dialog).toContainText('browser history');
  await expect(dialog.locator('pre')).toContainText('SAVE_FAILED');
  await expect(dialog.locator('pre')).toContainText(/MarkNotes Desktop \S+ \(\w+ \w+\)/);
  const open = dialog.getByRole('button', { name: 'Open GitHub draft' });
  await expect(open).toBeDisabled();
  const transmitted = () =>
    app.evaluate(() => (globalThis as { diagnosticTest?: { urls: string[] } }).diagnosticTest!.urls);
  expect(await transmitted()).toEqual([]);
  const unconsented = await page.evaluate(async () => {
    const draft = await window.marknotes.diagnosticsDraft();
    if (!draft.ok) throw new Error(draft.error);
    return window.marknotes.openDiagnosticsDraft(draft.value, false);
  });
  expect(unconsented.ok).toBe(false);
  const tampered = await page.evaluate(async () => {
    const draft = await window.marknotes.diagnosticsDraft();
    if (!draft.ok) throw new Error(draft.error);
    return window.marknotes.openDiagnosticsDraft(
      { ...draft.value, url: 'https://example.invalid/unreviewed' },
      true,
    );
  });
  expect(tampered.ok).toBe(false);
  expect(await transmitted()).toEqual([]);
  await dialog.getByRole('checkbox').check();
  const reviewed = await dialog.locator('pre').innerText();
  await open.click();
  await expect(dialog).toHaveCount(0);
  const urls = await transmitted();
  expect(urls).toHaveLength(1);
  expect(urls[0].length).toBeLessThanOrEqual(2000);
  expect(new URL(urls[0]).searchParams.get('body')).toBe(reviewed);
  await page.getByRole('button', { name: 'Clear logs', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('cleared');
  expect(readdirSync(join(userData, 'diagnostics'))).toEqual([]);
  await page.evaluate(() => window.marknotes.recordDiagnostic('UI_FAILED'));
  await page.getByRole('button', { name: 'Delete all local data', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'MarkNotes', exact: true })).toBeVisible();
  expect(readdirSync(join(userData, 'diagnostics'))).toEqual([]);
});

test('diagnostics actions that fail are reported without sending anything', async ({ launch }) => {
  const { app, page } = await launch();
  await app.evaluate(({ shell }) => {
    const state = { urls: [] as string[] };
    (globalThis as { diagnosticTest?: typeof state }).diagnosticTest = state;
    shell.showItemInFolder = () => {
      throw new Error('no file manager');
    };
    shell.openExternal = async (url) => {
      state.urls.push(url);
      throw new Error('no browser');
    };
  });
  const failure = 'Could not complete the diagnostics action. No report was sent automatically.';
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Export logs', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: failure })).toBeVisible();

  await page.evaluate(() => window.marknotes.recordDiagnostic('SAVE_FAILED'));
  await page.getByRole('button', { name: 'Report a problem', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review diagnostic report' });
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Open GitHub draft' }).click();
  // The dialog stays open with the error, so the user can retry or cancel.
  await expect(dialog.getByRole('alert')).toHaveText(failure);
  await expect(dialog.getByRole('button', { name: 'Open GitHub draft' })).toBeEnabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
});
