import {
  _electron as electron,
  expect,
  test as base,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dismissFirstAccessGuide } from './onboarding';

export interface LaunchOptions {
  /** Profile directory (MARKNOTES_USER_DATA); the test's own temporary profile when missing. */
  userData?: string;
  /** Extra environment variables, e.g. `MARKNOTES_E2E: '0'` to use the real connectors. */
  env?: Record<string, string>;
  /**
   * `workspace` (default) dismisses the first access guide and waits for the heading; `onboarding` only waits until
   * the first access guide decided whether to show, leaving it open.
   */
  ready?: 'workspace' | 'onboarding';
  /** The heading to wait for with `ready: 'workspace'`. */
  heading?: string | RegExp;
  headingTimeout?: number;
}

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
}

/**
 * A fixed scale factor keeps pixel assertions independent of the display scaling of the machine. Ubuntu 24.04 runners
 * block the Chromium sandbox (AppArmor userns restrictions).
 */
export const electronArgs = () => [
  '.',
  '--force-device-scale-factor=1',
  ...(process.platform === 'linux' ? ['--no-sandbox'] : []),
];

export const newUserData = (prefix = 'marknotes-e2e-') => mkdtempSync(join(tmpdir(), prefix));

/** Windows can keep files of a just-closed Electron profile busy for a moment. */
export const removeUserData = (userData: string) =>
  rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

/** Launches the built app (`out/`) with the fake drives, on a separate profile. */
export async function launchApp(userData: string, options: Omit<LaunchOptions, 'userData'> = {}) {
  const app = await electron.launch({
    args: electronArgs(),
    env: {
      ...process.env,
      MARKNOTES_E2E: '1',
      MARKNOTES_USER_DATA: userData,
      ELECTRON_RENDERER_URL: '',
      ...options.env,
    },
  });
  try {
    const page = await app.firstWindow();
    if (options.ready === 'onboarding') {
      await expect(page.locator('[data-onboarding-ready]')).toBeVisible({ timeout: 20_000 });
    } else {
      await dismissFirstAccessGuide(page);
      await expect(page.getByRole('heading', { name: options.heading ?? 'MarkNotes' })).toBeVisible({
        timeout: options.headingTimeout,
      });
    }
    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

export const test = base.extend<{
  /** A temporary profile, deleted after the test. */
  userData: string;
  /** Launches the app on the test profile (or `options.userData`); every app still open is closed after the test. */
  launch: (options?: LaunchOptions) => Promise<LaunchedApp>;
}>({
  // eslint-disable-next-line no-empty-pattern
  userData: async ({}, use) => {
    const userData = newUserData();
    await use(userData);
    removeUserData(userData);
  },
  launch: async ({ userData }, use) => {
    const open = new Set<ElectronApplication>();
    await use(async ({ userData: profile = userData, ...options } = {}) => {
      const launched = await launchApp(profile, options);
      open.add(launched.app);
      launched.app.on('close', () => open.delete(launched.app));
      return launched;
    });
    for (const app of open) await app.close().catch(() => undefined);
  },
});

export { expect };
