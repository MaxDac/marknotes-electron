import { expect, type Page } from '@playwright/test';

/** Exercise the real first-run UI instead of a production onboarding bypass. */
export async function dismissFirstAccessGuide(page: Page) {
  const workspace = page.locator('[data-onboarding-ready]');
  await expect(workspace.or(page.getByRole('heading', { name: 'MarkNotes is locked' }))).toBeVisible();
  if (!(await workspace.count())) return;
  if ((await workspace.getAttribute('data-onboarding-ready')) === 'pending') {
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(workspace).toHaveAttribute('data-onboarding-ready', 'handled');
    await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
  }
}
