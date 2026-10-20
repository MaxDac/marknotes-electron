import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface LoopbackRedirect {
  /** e.g. http://127.0.0.1:53124/oauth/dropbox */
  redirectUri: string;
  /** Resolves with the query parameters of the first request to the redirect path. */
  result: Promise<URLSearchParams>;
  close(): void;
}

const PAGE = (message: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>MarkNotes</title></head>` +
  `<body style="font-family:system-ui;padding:2rem"><h2>MarkNotes</h2><p>${message}</p></body></html>`;

/**
 * Starts an HTTP server on a random loopback port to receive an OAuth redirect (RFC 8252).
 * The server closes after the first matching request, on abort or after the timeout.
 */
export async function startLoopbackRedirect(
  path: string,
  options: { signal?: AbortSignal; timeoutMs?: number; host?: string } = {},
): Promise<LoopbackRedirect> {
  const host = options.host ?? '127.0.0.1';
  let settle: { resolve: (p: URLSearchParams) => void; reject: (e: Error) => void } | undefined;
  const result = new Promise<URLSearchParams>((resolve, reject) => (settle = { resolve, reject }));
  result.catch(() => undefined);
  const timers: { timeout?: NodeJS.Timeout } = {};
  const close = () => {
    if (timers.timeout) clearTimeout(timers.timeout);
    server.close();
    server.closeAllConnections?.();
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== path) {
      res.writeHead(404).end();
      return;
    }
    const failed = url.searchParams.has('error');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(
      PAGE(
        failed
          ? 'Sign-in was cancelled or failed. You can close this window.'
          : 'Signed in. You can close this window and return to MarkNotes.',
      ),
    );
    settle?.resolve(url.searchParams);
    close();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  timers.timeout = setTimeout(
    () => {
      settle?.reject(new Error('Sign-in timed out'));
      close();
    },
    options.timeoutMs ?? 5 * 60_000,
  );
  options.signal?.addEventListener('abort', () => {
    settle?.reject(new DOMException('Sign-in cancelled', 'AbortError'));
    close();
  });
  return { redirectUri: `http://${host}:${port}${path}`, result, close };
}

/** PKCE (RFC 7636) S256 verifier and challenge. */
export async function pkce(): Promise<{ verifier: string; challenge: string }> {
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString('base64url');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: Buffer.from(digest).toString('base64url') };
}

export const randomState = () =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
