import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { dismissFirstAccessGuide } from './onboarding';

async function createNote(page: Page, name: string, text: string) {
  await page.getByTestId('new-note').click();
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('note-title')).toHaveText(name);
  await page.getByTestId('editor-field').click();
  await page.keyboard.insertText(text);
}

test('remote images are only loaded on request', async ({ launch }) => {
  const { page } = await launch();
  await createNote(
    page,
    'Images',
    '![web](https://example.invalid/pixel.png)\n\n![lan](//example.invalid/pixel.png)\n',
  );
  const images = page.getByTestId('markdown-preview').locator('img');
  await expect(images).toHaveCount(2);
  await expect(images.nth(0)).toHaveAttribute('src', '');
  await expect(images.nth(0)).toHaveAttribute('data-remote-src', 'https://example.invalid/pixel.png');
  await expect(images.nth(1)).toHaveAttribute('src', '');

  await page.getByRole('button', { name: 'Load remote images' }).click();
  await expect(images.nth(0)).toHaveAttribute('src', 'https://example.invalid/pixel.png');
  await expect(images.nth(1)).toHaveAttribute('src', '');
  await expect(page.getByTestId('remote-images')).toHaveCount(0);
});

test('delete all local data removes the notes on this device', async ({ launch }) => {
  const { page } = await launch();
  await createNote(page, 'Secret', 'private');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Delete all local data' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('heading', { name: 'MarkNotes' })).toBeVisible();
  await expect(page.getByText('No notes here yet')).toBeVisible();
  await expect(page.getByTestId('entry')).toHaveCount(0);
});

test('the app lock asks for the passphrase after locking and on restart', async ({ launch }) => {
  const first = await launch();
  const { app } = first;
  let { page } = first;
  await createNote(page, 'Locked', 'hidden text');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Turn on app lock' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New passphrase', { exact: true }).fill('correct horse');
  await dialog.getByLabel('Repeat the new passphrase').fill('correct horse');
  await dialog.getByRole('button', { name: 'Turn on' }).click();
  await page.getByRole('button', { name: 'Lock now' }).click();

  const locked = page.getByRole('heading', { name: 'MarkNotes is locked' });
  await expect(locked).toBeVisible();
  await page.getByLabel('Passphrase').fill('wrong passphrase');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('alert')).toHaveText('Wrong passphrase');
  await page.getByLabel('Passphrase').fill('correct horse');
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByRole('heading', { name: 'MarkNotes', exact: true })).toBeVisible();
  await expect(page.getByTestId('entry').filter({ hasText: 'Locked' })).toBeVisible();

  await app.close();
  ({ page } = await launch());
  await expect(page.getByRole('heading', { name: 'MarkNotes is locked' })).toBeVisible();
  // Forgotten passphrase: the local data is deleted and the app lock removed.
  await page.getByRole('button', { name: 'Delete all local data' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: 'Skip', exact: true })).toBeVisible();
  await dismissFirstAccessGuide(page);
  await expect(page.getByRole('heading', { name: 'MarkNotes', exact: true })).toBeVisible();
  await expect(page.getByText('No notes here yet')).toBeVisible();
});
