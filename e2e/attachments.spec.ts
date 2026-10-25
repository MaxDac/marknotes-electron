import { expect, test } from './fixtures';
import { PNG, addDrive, createNote, editorText, remoteList } from './helpers';

const ATTACHMENT = /attachments\/[0-9a-f]{64}\.png/;

test('a replaced image is cleaned up on this device and deleted from the drive on the next sync', async ({
  launch,
}) => {
  const { page } = await launch();
  await page.getByRole('button', { name: 'Settings' }).click();
  await addDrive(page, 'Dropbox');
  await page.getByRole('button', { name: 'Back' }).click();
  await createNote(page, 'Pictures');
  await page
    .getByTestId('image-input')
    .setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: PNG.dot });
  await expect.poll(() => editorText(page)).toMatch(ATTACHMENT);
  const first = ATTACHMENT.exec(await editorText(page))![0];
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Clean unused images' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('clean-message')).toHaveText('No unused images');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByTestId('sync-message')).toContainText('↑2');
  expect(await remoteList(page, 'dropbox:test')).toContain(`MarkNotes/${first}`);

  // Replace the image with another one.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('entry').filter({ hasText: 'Pictures' }).click();
  await page.getByTestId('editor-field').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('Backspace');
  await page
    .getByTestId('image-input')
    .setInputFiles({ name: 'red.png', mimeType: 'image/png', buffer: PNG.red });
  await expect.poll(() => editorText(page)).toMatch(ATTACHMENT);
  const second = ATTACHMENT.exec(await editorText(page))![0];
  expect(second).not.toBe(first);
  await expect(page.getByTestId('markdown-preview').locator('img')).toHaveAttribute('src', /^blob:/);
  await page.waitForTimeout(800);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Clean unused images' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('clean-message')).toHaveText('Deleted 1 unused image');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
  await expect.poll(() => remoteList(page, 'dropbox:test')).toContain(`MarkNotes/${second}`);
  expect(await remoteList(page, 'dropbox:test')).not.toContain(`MarkNotes/${first}`);
});
