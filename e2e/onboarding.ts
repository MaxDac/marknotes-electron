import { expect, type Page } from '@playwright/test';

/**
 * Exercise the real first-run UI instead of a production onboarding bypass. A cold start (decrypting the local
 * database) can take longer than the default expect timeout on a loaded machine or a CI runner.
 */
export async function dismissFirstAccessGuide(page: Page, startupTimeout = 20_000) {
  const workspace = page.locator('[data-onboarding-ready]');
  await expect(workspace.or(page.getByRole('heading', { name: 'MarkNotes is locked' }))).toBeVisible({
    timeout: startupTimeout,
  });
  if (!(await workspace.count())) return;
  if ((await workspace.getAttribute('data-onboarding-ready')) === 'pending') {
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(workspace).toHaveAttribute('data-onboarding-ready', 'handled');
    await expect(page.getByTestId('first-access-guide')).toHaveCount(0);
  }
}
