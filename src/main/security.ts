/** Main-process checks that keep IPC and permissions limited to the app's own page. */

/** Strips the query and fragment so the page URL can be compared with the loaded app URL. */
const withoutQuery = (url: string) => {
  try {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname);
    // Windows paths (file:///C:/...) are case-insensitive.
    const normalized = u.protocol === 'file:' && /^\/[a-z]:\//i.test(path) ? path.toLowerCase() : path;
    return `${u.protocol}//${u.host}${normalized}`;
  } catch {
    return null;
  }
};

/**
 * Whether `url` is the app page: the bundled `index.html` (`file:`) or, in development, the dev server origin.
 */
export function isAppUrl(url: string, appUrl: string): boolean {
  const expected = withoutQuery(appUrl);
  const actual = withoutQuery(url);
  if (!expected || !actual) return false;
  if (appUrl.startsWith('file:')) return actual === expected;
  return new URL(url).origin === new URL(appUrl).origin;
}

export interface IpcSender {
  /** URL of the frame that sent the message; null when the frame is gone. */
  frameUrl: string | null;
  /** Whether that frame is the top-level frame of the window. */
  isMainFrame: boolean;
}

/** IPC calls are only served to the top-level frame showing the app page. */
export function isTrustedSender(sender: IpcSender, appUrl: string): boolean {
  return sender.isMainFrame && sender.frameUrl !== null && isAppUrl(sender.frameUrl, appUrl);
}
