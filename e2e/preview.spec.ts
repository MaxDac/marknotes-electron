import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect, test, type Browser } from '@playwright/test';
import { dismissFirstAccessGuide } from './onboarding';

function stopPreview(child: ChildProcess) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    if (child.exitCode !== null) return;
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      encoding: 'utf8',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Cannot stop preview:\n${result.stderr}`);
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
}

// Preview rebuilds the app first, which is slower on the Windows and macOS runners.
test.setTimeout(180_000);

test('npm preview builds and opens a usable app', async () => {
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw new Error('Run the preview smoke test through npm run e2e.');
  const userData = await mkdtemp(join(tmpdir(), 'marknotes-preview-'));
  const child = spawn(
    process.execPath,
    [
      npmCli,
      'run',
      'preview',
      '--',
      '--logLevel',
      'warn',
      ...(process.platform === 'linux' ? ['--noSandbox'] : []),
      '--',
      '--remote-debugging-port=0',
    ],
    {
      env: { ...process.env, MARKNOTES_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let spawnError: Error | undefined;
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdout.on('data', (data: Buffer) => {
    output += data.toString();
  });
  child.stderr.on('data', (data: Buffer) => {
    output += data.toString();
  });
  let browser: Browser | undefined;
  try {
    await expect
      .poll(
        () => {
          if (spawnError) throw spawnError;
          if (child.exitCode !== null) {
            throw new Error(`Preview exited with code ${child.exitCode}:\n${output}`);
          }
          return /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];
        },
        { timeout: 120_000, message: 'Preview must build and start Electron remote debugging' },
      )
      .toBeTruthy();
    const endpoint = /DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1];
    if (!endpoint) throw new Error(`Missing Electron debugging endpoint:\n${output}`);
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    // Reload after attaching so startup exceptions cannot precede the error listener.
    await page.reload();
    await dismissFirstAccessGuide(page);
    await expect(page.getByRole('heading', { name: 'MarkNotes' })).toBeVisible();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Add drive', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Dropbox', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'OneDrive', exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
    expect(output).not.toMatch(/Unable to load preload script|Error:|UnhandledPromiseRejection/);
    await page.close();
    // Closing the last window intentionally leaves macOS applications running.
    if (process.platform !== 'darwin') {
      await expect.poll(() => child.exitCode, { timeout: 10_000 }).toBe(0);
    }
  } catch (error) {
    throw new Error(`npm preview smoke failed:\n${output}`, { cause: error });
  } finally {
    try {
      stopPreview(child);
      await expect
        .poll(() => child.exitCode !== null || child.signalCode !== null || !!spawnError, {
          timeout: 10_000,
          message: 'Preview process must exit during cleanup',
        })
        .toBe(true);
    } finally {
      try {
        await browser?.close();
      } finally {
        await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }
  }
});
