import { RemoteUnavailableError } from '../../../shared/types';
import type { FetchFn, SecretVault } from '../types';
import {
  PROTON_ACCEPT,
  ProtonApiError,
  authorizedHeaders,
  parseProtonResponse,
  type ProtonAuthClient,
} from './authClient';
import type {
  ProtonDriveHTTPClient,
  ProtonDriveHTTPClientBlobRequest,
  ProtonDriveHTTPClientJsonRequest,
} from './sdk';
import { sessionToJson, type ProtonSession } from './session';

export const LOGIN_AGAIN_MESSAGE = 'Proton Drive sign-in expired, reconnect this drive in Settings';
export const SESSION_EXPIRED_MESSAGE = 'Proton session expired, reconnect this drive in Settings';

/**
 * Live access to the stored session of one account. Refreshes tokens on 401 (once for concurrent callers)
 * and persists the rotated tokens in the vault. Ported from the Android ProtonSessionSource/bridge.
 */
export class ProtonSessionHolder {
  private refreshing: Promise<ProtonSession> | null = null;
  private detached = false;

  constructor(
    readonly accountId: string,
    private session: ProtonSession | null,
    private readonly vault: SecretVault,
    private readonly auth: ProtonAuthClient,
  ) {}

  get current(): ProtonSession | null {
    return this.session;
  }

  require(): ProtonSession {
    if (!this.session) throw new RemoteUnavailableError(LOGIN_AGAIN_MESSAGE);
    return this.session;
  }

  /** Refreshes the tokens if they are still `staleAccessToken` (another caller may have refreshed already). */
  async refresh(staleAccessToken: string): Promise<ProtonSession> {
    const session = this.require();
    if (session.accessToken !== staleAccessToken) return session;
    if (!this.refreshing) {
      this.refreshing = this.doRefresh(session).finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  async invalidate(): Promise<void> {
    this.session = null;
    if (!this.detached) await this.vault.delete(this.accountId);
  }

  detach() {
    this.detached = true;
    this.session = null;
  }

  private async doRefresh(session: ProtonSession): Promise<ProtonSession> {
    let fresh: ProtonSession;
    try {
      fresh = await this.auth.refresh(session);
    } catch (e) {
      if (e instanceof ProtonApiError) {
        if ([400, 401, 422].includes(e.httpStatus)) {
          await this.invalidate();
          throw new RemoteUnavailableError(SESSION_EXPIRED_MESSAGE);
        }
        throw new RemoteUnavailableError(e.userMessage);
      }
      throw e;
    }
    if (!this.detached) {
      this.session = fresh;
      await this.vault.set(this.accountId, sessionToJson(fresh));
    }
    return fresh;
  }
}

type RequestInitWithDuplex = RequestInit & { duplex?: 'half' };

/**
 * Sends authenticated requests to the Proton API (JSON helpers for the key endpoints, and the Drive SDK's
 * ProtonDriveHTTPClient). Every request carries x-pm-appversion; requests to the API host also carry the
 * session headers and are retried once after a token refresh on 401.
 */
export class ProtonHttpClient implements ProtonDriveHTTPClient {
  private readonly apiHost: string;

  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchFn,
    private readonly sessions: ProtonSessionHolder,
    private readonly appVersion: string,
  ) {
    this.apiHost = new URL(baseUrl).host;
  }

  fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response> {
    const headers = new Headers(request.headers);
    let body: BodyInit | undefined = request.body as BodyInit | undefined;
    if (request.json !== undefined) {
      body = JSON.stringify(request.json);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
    return this.send(request.url, request.method, headers, body, request.timeoutMs, request.signal);
  }

  fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response> {
    return this.send(
      request.url,
      request.method,
      new Headers(request.headers),
      request.body as BodyInit | undefined,
      request.timeoutMs,
      request.signal,
    );
  }

  /** GET on a Proton API path (e.g. `/core/v4/addresses`), returning the parsed JSON. */
  async getJson(path: string): Promise<Record<string, unknown>> {
    const headers = new Headers({ Accept: PROTON_ACCEPT });
    const response = await this.send(this.baseUrl + path, 'GET', headers, undefined, 60_000);
    return parseProtonResponse(response);
  }

  private async send(
    url: string,
    method: string,
    baseHeaders: Headers,
    body: BodyInit | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const authorized = this.isApiUrl(url);
    const attempt = (session: ProtonSession | null) => {
      const headers = new Headers(baseHeaders);
      headers.set('x-pm-appversion', this.appVersion);
      if (session)
        for (const [name, value] of Object.entries(authorizedHeaders(session))) headers.set(name, value);
      const signals = [signal, timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined].filter(
        (s): s is AbortSignal => s !== undefined,
      );
      const init: RequestInitWithDuplex = {
        method,
        headers,
        body,
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      };
      if (body instanceof ReadableStream) init.duplex = 'half';
      return this.fetchFn(url, init);
    };
    if (!authorized) return attempt(null);
    const session = this.sessions.require();
    const response = await attempt(session);
    if (response.status !== 401 || body instanceof ReadableStream) return response;
    const fresh = await this.sessions.refresh(session.accessToken);
    return attempt(fresh);
  }

  private isApiUrl(url: string): boolean {
    try {
      return new URL(url).host === this.apiHost;
    } catch {
      return false;
    }
  }
}
