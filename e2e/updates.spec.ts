import { expect, test } from './fixtures';

test('a downloaded update is offered, reports install errors and can be postponed', async ({ launch }) => {
  const { app, page } = await launch();
  const banner = page.getByTestId('update-banner');
  await expect(banner).toHaveCount(0);

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].webContents.send('update:changed', {
      state: 'downloaded',
      version: '99.0.0',
    });
  });
  await expect(banner).toContainText('MarkNotes 99.0.0 is ready to install.');
  // Updates are disabled in tests, so the main process refuses to install.
  await banner.getByRole('button', { name: 'Restart to update' }).click();
  await expect(banner).toContainText('No update is ready to install');
  expect(app.windows()).toHaveLength(1);

  await banner.getByRole('button', { name: 'Later' }).click();
  await expect(banner).toHaveCount(0);
});
