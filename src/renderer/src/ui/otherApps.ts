import type { Result } from '../../../preload/api';

export interface OtherApp {
  label: string;
  url: string;
}

/** The other MarkNotes apps, shown in Settings → About. This app (Desktop) is not listed. */
export const OTHER_APPS: readonly OtherApp[] = [
  {
    label: 'MarkNotes for Android (F-Droid)',
    url: 'https://f-droid.org/packages/io.github.maxdac.marknotes.libre/',
  },
  {
    label: 'MarkNotes Plus for Android (GitHub Releases)',
    url: 'https://github.com/MaxDac/MarkNotes/releases',
  },
  { label: 'MarkNotes Web', url: 'https://marknotes.fly.dev' },
];

/** Opens an app link in the browser; resolves to an error message, or null when it opened. */
export async function openOtherApp(
  open: (url: string) => Promise<Result<void>>,
  app: OtherApp,
): Promise<string | null> {
  try {
    const result = await open(app.url);
    return result.ok ? null : `Could not open ${app.label}: ${result.error}`;
  } catch (e) {
    return `Could not open ${app.label}: ${e instanceof Error ? e.message : String(e)}`;
  }
}
