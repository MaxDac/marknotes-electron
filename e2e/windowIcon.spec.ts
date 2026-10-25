import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

async function expectWindowsIcon(app: ElectronApplication, iconPath: string) {
  const handle = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getNativeWindowHandle().readBigUInt64LE().toString(),
  );
  const { stdout } = await exec('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Drawing
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WindowIcon {
  [DllImport("user32.dll")]
  public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
  [DllImport("user32.dll")]
  public static extern bool DestroyIcon(IntPtr icon);
}
'@
      foreach ($kind in @(0, 1)) {
        $handle = [WindowIcon]::SendMessage([IntPtr][long]${handle}, 0x7f, [IntPtr]$kind, [IntPtr]::Zero)
        if ($handle -eq [IntPtr]::Zero) { throw "Missing native window icon ($kind)" }
        $actualIcon = [System.Drawing.Icon]::FromHandle($handle)
        # Use the same native ICO decoding and DPI-dependent sizing as Electron.
        $expectedHandle = [WindowIcon]::LoadImage([IntPtr]::Zero, '${iconPath.replaceAll("'", "''")}', 1, $actualIcon.Width, $actualIcon.Height, 0x10)
        if ($expectedHandle -eq [IntPtr]::Zero) { throw "Could not load MarkNotes ICO" }
        $expectedIcon = [System.Drawing.Icon]::FromHandle($expectedHandle)
        $actual = $actualIcon.ToBitmap()
        $expected = $expectedIcon.ToBitmap()
        try {
          for ($y = 0; $y -lt $actual.Height; $y++) {
            for ($x = 0; $x -lt $actual.Width; $x++) {
              if ($actual.GetPixel($x, $y).ToArgb() -ne $expected.GetPixel($x, $y).ToArgb()) {
                throw "Native window icon ($kind) does not match MarkNotes at ($x, $y)"
              }
            }
          }
        } finally {
          $actual.Dispose()
          $expected.Dispose()
          $actualIcon.Dispose()
          $expectedIcon.Dispose()
          [void][WindowIcon]::DestroyIcon($expectedHandle)
        }
      }
      'MarkNotes window icons match'
    `,
  ]);
  expect(stdout.trim()).toBe('MarkNotes window icons match');
}

test('Windows app windows use the bundled MarkNotes icon, including after recreation', async () => {
  test.skip(process.platform !== 'win32', 'Native Windows window icons');
  const assets = join(process.cwd(), 'out', 'main', 'assets');
  const icons = readdirSync(assets).filter((name) => name.endsWith('.ico'));
  expect(icons).toHaveLength(1);
  const iconPath = join(assets, icons[0]);
  expect(readFileSync(iconPath)).toEqual(readFileSync(join(process.cwd(), 'build', 'icon.ico')));

  const userData = mkdtempSync(join(tmpdir(), 'marknotes-window-icon-'));
  const app = await electron.launch({
    args: ['.'],
    env: { ...process.env, MARKNOTES_E2E: '1', MARKNOTES_USER_DATA: userData, ELECTRON_RENDERER_URL: '' },
  });
  try {
    await app.firstWindow();
    await expectWindowsIcon(app, iconPath);
    await app.evaluate(({ app, BrowserWindow }) => {
      app.removeAllListeners('window-all-closed');
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
      app.emit('activate');
    });
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(true);
    await expectWindowsIcon(app, iconPath);
  } finally {
    await app.close();
    rmSync(userData, { recursive: true, force: true });
  }
});
