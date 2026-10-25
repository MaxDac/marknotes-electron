import { describe, expect, it, vi } from 'vitest';
import { OTHER_APPS, openOtherApp } from '../src/renderer/src/ui/otherApps';

describe('other MarkNotes apps', () => {
  it('lists the other three apps with fixed labels and URLs', () => {
    expect(OTHER_APPS).toEqual([
      {
        label: 'MarkNotes for Android (F-Droid)',
        url: 'https://f-droid.org/packages/io.github.maxdac.marknotes.libre/',
      },
      {
        label: 'MarkNotes Plus for Android (GitHub Releases)',
        url: 'https://github.com/MaxDac/MarkNotes/releases',
      },
      { label: 'MarkNotes Web', url: 'https://marknotes.fly.dev' },
    ]);
  });

  it('never links to the desktop app itself, latest releases or tracking parameters', () => {
    for (const app of OTHER_APPS) {
      expect(app.url).not.toContain('marknotes-electron');
      expect(app.url).not.toContain('/releases/latest');
      expect(app.url).not.toContain('?');
      expect(app.url).toMatch(/^https:\/\//);
    }
  });

  it('opens the exact URL and reports no error on success', async () => {
    const open = vi.fn().mockResolvedValue({ ok: true, value: undefined });
    await expect(openOtherApp(open, OTHER_APPS[2])).resolves.toBeNull();
    expect(open).toHaveBeenCalledWith('https://marknotes.fly.dev');
  });

  it('returns a visible error when the link cannot be opened', async () => {
    const failed = vi.fn().mockResolvedValue({ ok: false, error: 'no browser' });
    await expect(openOtherApp(failed, OTHER_APPS[0])).resolves.toBe(
      'Could not open MarkNotes for Android (F-Droid): no browser',
    );
    const thrown = vi.fn().mockRejectedValue(new Error('ipc down'));
    await expect(openOtherApp(thrown, OTHER_APPS[1])).resolves.toBe(
      'Could not open MarkNotes Plus for Android (GitHub Releases): ipc down',
    );
  });
});
