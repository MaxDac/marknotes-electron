import { describe, expect, it } from 'vitest';
import { isAppUrl, isTrustedSender } from '../src/main/security';

const fileApp = 'file:///opt/MarkNotes/resources/app.asar/out/renderer/index.html';

describe('isAppUrl', () => {
  it('accepts the bundled page, ignoring query and fragment', () => {
    expect(isAppUrl(fileApp, fileApp)).toBe(true);
    expect(isAppUrl(`${fileApp}?x=1#note`, fileApp)).toBe(true);
  });

  it('compares decoded paths', () => {
    const app = 'file:///home/me/Mark%20Notes/index.html';
    expect(isAppUrl('file:///home/me/Mark Notes/index.html', app)).toBe(true);
  });

  it('ignores the case of Windows paths', () => {
    expect(
      isAppUrl(
        'file:///c:/Program%20Files/MarkNotes/index.html',
        'file:///C:/Program Files/MarkNotes/index.html',
      ),
    ).toBe(true);
  });

  it('rejects other files and other schemes', () => {
    expect(isAppUrl('file:///tmp/evil.html', fileApp)).toBe(false);
    expect(isAppUrl('https://example.com/index.html', fileApp)).toBe(false);
    expect(isAppUrl('not a url', fileApp)).toBe(false);
  });

  it('matches the dev server by origin', () => {
    const dev = 'http://localhost:5173/';
    expect(isAppUrl('http://localhost:5173/some/route', dev)).toBe(true);
    expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
    expect(isAppUrl('https://localhost:5173/', dev)).toBe(false);
  });
});

describe('isTrustedSender', () => {
  it('requires the main frame of the app page', () => {
    expect(isTrustedSender({ frameUrl: fileApp, isMainFrame: true }, fileApp)).toBe(true);
    expect(isTrustedSender({ frameUrl: fileApp, isMainFrame: false }, fileApp)).toBe(false);
    expect(isTrustedSender({ frameUrl: null, isMainFrame: true }, fileApp)).toBe(false);
    expect(isTrustedSender({ frameUrl: 'https://evil.example/', isMainFrame: true }, fileApp)).toBe(false);
  });
});
