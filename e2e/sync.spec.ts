import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { addDrive, createNote, networkTransition, remoteList, remotePut, setFault } from './helpers';

const RETRYABLE = 'The drive is temporarily unavailable';
const PERMANENT = 'The drive rejected the request';

async function openSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
}

async function syncNow(page: Page) {
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
}

test('a failing drive is reported and the next sync recovers', async ({ launch }) => {
  const { page } = await launch();
  await openSettings(page);
  await addDrive(page, 'Dropbox');
  const message = page.getByTestId('sync-message');
  await expect(message).toHaveText('test@example.com: ↑0 ↓0');

  await remotePut(page, 'dropbox:test', 'MarkNotes/Remote.md', 'from the drive');
  await setFault(page, 'dropbox:test', { kind: 'permanent', op: 'snapshot' });
  await syncNow(page);
  await expect(message).toContainText(`test@example.com: Sync failed: ${PERMANENT}`);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('entry').filter({ hasText: 'Remote' })).toHaveCount(0);

  await setFault(page, 'dropbox:test', null);
  await openSettings(page);
  await syncNow(page);
  await expect(message).toHaveText('test@example.com: ↑0 ↓1');
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('entry').filter({ hasText: 'Remote' })).toBeVisible();
});

test('a failed upload is reported while the other changes sync, and is retried on the next sync', async ({
  launch,
}) => {
  const { page } = await launch();
  await openSettings(page);
  await addDrive(page, 'Dropbox');
  await page.getByRole('button', { name: 'Back' }).click();
  await createNote(page, 'First', 'one');
  await createNote(page, 'Second', 'two');

  await openSettings(page);
  await setFault(page, 'dropbox:test', { kind: 'permanent', op: 'uploadNew', times: 1 });
  await syncNow(page);
  const message = page.getByTestId('sync-message');
  await expect(message).toContainText('test@example.com: ↑1');
  const notes = (paths: string[]) => paths.filter((p) => /^MarkNotes\/(First|Second)\.md$/.test(p));
  expect(notes(await remoteList(page, 'dropbox:test'))).toHaveLength(1);

  await syncNow(page);
  await expect(message).toHaveText('test@example.com: ↑1 ↓0');
  expect(notes(await remoteList(page, 'dropbox:test'))).toEqual([
    'MarkNotes/First.md',
    'MarkNotes/Second.md',
  ]);
});

test('a reconnect sync retries a temporarily unavailable drive', async ({ launch }) => {
  const { page } = await launch();
  await openSettings(page);
  await addDrive(page, 'Dropbox');
  await page.getByRole('switch', { name: 'Sync when reconnected' }).check();
  await expect(page.getByRole('switch', { name: 'Sync when reconnected' })).toBeEnabled();
  await remotePut(page, 'dropbox:test', 'MarkNotes/Reconnected.md', 'from another device');
  await setFault(page, 'dropbox:test', { kind: 'retryable', op: 'snapshot', times: 1 });

  await networkTransition(page);
  const message = page.getByTestId('sync-message');
  // The first attempt runs 2 s after the transition and fails; the retry 5 s later succeeds.
  await expect(message).toContainText(`Sync failed: ${RETRYABLE}`, { timeout: 10_000 });
  await expect(message).toHaveText('test@example.com: ↑0 ↓1', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('entry').filter({ hasText: 'Reconnected' })).toBeVisible();
});

test('a reconnect sync does not retry a permanent failure', async ({ launch }) => {
  const { page } = await launch();
  await openSettings(page);
  await addDrive(page, 'Dropbox');
  await page.getByRole('switch', { name: 'Sync when reconnected' }).check();
  await expect(page.getByRole('switch', { name: 'Sync when reconnected' })).toBeEnabled();
  await remotePut(page, 'dropbox:test', 'MarkNotes/Reconnected.md', 'from another device');
  await setFault(page, 'dropbox:test', { kind: 'permanent', op: 'snapshot', times: 1 });

  await networkTransition(page);
  const message = page.getByTestId('sync-message');
  await expect(message).toContainText(`Sync failed: ${PERMANENT}`, { timeout: 10_000 });
  // Past the first retry delay: nothing else ran, so the note is still missing.
  await page.waitForTimeout(6_500);
  await expect(message).toContainText(`Sync failed: ${PERMANENT}`);

  await syncNow(page);
  await expect(message).toHaveText('test@example.com: ↑0 ↓1');
});

test('drives sync in order and one failing drive does not stop the others', async ({ launch }) => {
  const { page } = await launch();
  await openSettings(page);
  await addDrive(page, 'Dropbox');
  await addDrive(page, 'OneDrive');
  const drives = page.getByTestId('drive');
  await expect(drives).toHaveCount(2);
  await expect(drives.nth(0)).toContainText('Dropbox');
  await expect(drives.nth(1)).toContainText('OneDrive');
  await page.getByRole('button', { name: 'Back' }).click();
  await createNote(page, 'Everywhere', 'body');
  await openSettings(page);

  const message = page.getByTestId('sync-message');
  await setFault(page, 'dropbox:test', { kind: 'permanent', op: 'snapshot' });
  await syncNow(page);
  await expect(message).toHaveText(
    [`test@example.com: Sync failed: ${PERMANENT}`, 'test@example.com: ↑1 ↓0'].join('\n'),
  );
  expect(await remoteList(page, 'onedrive:test')).toContain('MarkNotes/Everywhere.md');
  expect(await remoteList(page, 'dropbox:test')).not.toContain('MarkNotes/Everywhere.md');

  await setFault(page, 'dropbox:test', null);
  await setFault(page, 'onedrive:test', { kind: 'retryable', op: 'snapshot' });
  await syncNow(page);
  await expect(message).toHaveText(
    ['test@example.com: ↑1 ↓0', `test@example.com: Sync failed: ${RETRYABLE}`].join('\n'),
  );
  expect(await remoteList(page, 'dropbox:test')).toContain('MarkNotes/Everywhere.md');

  await setFault(page, 'onedrive:test', null);
  await syncNow(page);
  await expect(message).toHaveText(['test@example.com: ↑0 ↓0', 'test@example.com: ↑0 ↓0'].join('\n'));
});

test('a Proton Drive session connects, syncs, disconnects and reconnects to the same notes', async ({
  launch,
}) => {
  const { page } = await launch();
  await createNote(page, 'Lifecycle', 'kept on Proton');
  await openSettings(page);
  await addDrive(page, 'Proton Drive', 'Personal notes');
  const message = page.getByTestId('sync-message');
  await expect(message).toHaveText('test@example.com: ↑1 ↓0');
  await expect(page.getByTestId('drive')).toContainText('Personal notes');
  const uploaded = await remoteList(page, 'proton:test');
  expect(uploaded.filter((p) => p.endsWith('Lifecycle.md'))).toHaveLength(1);

  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disconnect' }).click();
  await expect(message).toHaveText('Disconnected test@example.com');
  await expect(page.getByTestId('drive')).toHaveCount(0);

  // The same account and folder: the existing remote note matches the local one, so nothing is duplicated.
  await addDrive(page, 'Proton Drive', 'Personal notes');
  await expect(message).toHaveText('test@example.com: ↑0 ↓0');
  expect(await remoteList(page, 'proton:test')).toEqual(uploaded);
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByTestId('entry').filter({ hasText: 'Lifecycle' })).toHaveCount(1);
  await expect(page.getByTestId('entry').filter({ hasText: 'conflicted copy' })).toHaveCount(0);
});
