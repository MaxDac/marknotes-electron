import type { Page } from '@playwright/test';
import type { TestFault } from '../src/preload/api';
import { expect } from './fixtures';

/** A 1x1 PNG; `red` is a different image, so it gets a different attachment name. */
export const PNG = {
  dot: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
  red: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
    'base64',
  ),
};

export async function createNote(page: Page, name: string, body?: string) {
  await page.getByTestId('new-note').click();
  await page.getByRole('textbox', { name: 'Name' }).fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByTestId('note-title')).toHaveText(name);
  if (body === undefined) return;
  await page.getByTestId('editor-field').click();
  await page.keyboard.type(body);
  // Past the editor's save delay.
  await page.waitForTimeout(800);
}

/** The editor's text: CodeMirror renders one element per line (`innerText` adds a newline for an empty last line). */
export async function editorText(page: Page) {
  // The placeholder widget lives inside the empty line; it is not document text.
  return page
    .getByTestId('editor-field')
    .locator('.cm-line')
    .evaluateAll((lines) =>
      lines
        .map((line) => {
          const copy = line.cloneNode(true) as HTMLElement;
          copy.querySelectorAll('.cm-placeholder').forEach((p) => p.remove());
          return copy.textContent ?? '';
        })
        .join('\n'),
    );
}

export type Provider = 'Dropbox' | 'OneDrive' | 'Proton Drive';

/** Adds a fake drive from the Settings page with its default folder; the first sync runs on connect. */
export async function addDrive(page: Page, provider: Provider, folder = 'Notes') {
  await page.getByRole('button', { name: 'Add drive' }).click();
  await page.getByRole('button', { name: provider, exact: true }).click();
  if (provider === 'Proton Drive') {
    await expect(
      page.getByText('This is a third-party application not officially supported by Proton.'),
    ).toBeVisible();
    await page.getByLabel('Username or email').fill('test@example.com');
    await page.getByLabel('Password', { exact: true }).fill('secret');
    await page.getByRole('button', { name: 'Log in', exact: true }).click();
    await page.getByLabel('Folder in My files').fill(folder);
  } else {
    await expect(page.getByText(`Signed in to ${provider} as test@example.com`)).toBeVisible();
  }
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
}

export function remotePut(page: Page, driveId: string, path: string, text: string) {
  return page.evaluate(([id, p, t]) => window.marknotes.testRemote!(id, 'put', p, t), [
    driveId,
    path,
    text,
  ] as const);
}

export async function remoteList(page: Page, driveId: string): Promise<string[]> {
  const result = await page.evaluate((id) => window.marknotes.testRemote!(id, 'list'), driveId);
  if (!result.ok) throw new Error(result.error);
  return result.value as string[];
}

export async function setFault(page: Page, driveId: string, fault: TestFault | null) {
  const result = await page.evaluate(([id, f]) => window.marknotes.testFault!(id, f), [
    driveId,
    fault,
  ] as const);
  if (!result.ok) throw new Error(result.error);
}

/** Toggles the renderer offline and back online, which is what triggers a reconnect sync. */
export async function networkTransition(page: Page) {
  await page.context().setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await page.context().setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
}
