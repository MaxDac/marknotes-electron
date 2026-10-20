import { PROTON_APP_VERSION } from '../../config';
import type { FetchFn } from '../types';
import type { ProtonSession } from './session';
import {
  constantTimeEquals,
  decodeBase64,
  decodeModulus,
  encodeBase64,
  generateProofs,
  hashPassword,
  mailboxPassword,
} from './srp';

export const PROTON_DEFAULT_BASE_URL = 'https://drive-api.proton.me';
export const PROTON_ACCEPT = 'application/vnd.protonmail.v1+json';

export const HUMAN_VERIFICATION_REQUIRED = 9001;
export const WRONG_PASSWORD = 8002;
const TOTP = 1;
const SUCCESS_CODES = new Set([0, 1000, 1001]);

export class ProtonApiError extends Error {
  override name = 'ProtonApiError';
  readonly code: number;
  readonly httpStatus: number;
  private readonly userMessageOverride?: string;

  constructor(code: number, message: string, httpStatus = 0, userMessage?: string) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.userMessageOverride = userMessage;
  }

  get isHumanVerificationRequired(): boolean {
    return this.code === HUMAN_VERIFICATION_REQUIRED;
  }

  /** A message that can be shown to the user as is. */
  get userMessage(): string {
    if (this.userMessageOverride) return this.userMessageOverride;
    switch (this.code) {
      case HUMAN_VERIFICATION_REQUIRED:
        return (
          'Proton is asking for human verification (captcha), which this app does not support. ' +
          'Sign in once at proton.me from this network, wait a while and try again.'
        );
      case WRONG_PASSWORD:
        return 'Incorrect username or password.';
      default:
        return this.message || 'Unknown error';
    }
  }
}

export const INVALID_TWO_FACTOR_MESSAGE =
  'Incorrect two-factor code. Check your authenticator app and try again.';

export type AuthLoginResult =
  { kind: 'success'; session: ProtonSession } | { kind: 'twoFactorRequired'; session: ProtonSession };

type Json = Record<string, unknown>;

function stringOrNull(obj: Json, key: string): string | null {
  const v = obj[key];
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return null;
}

function string(obj: Json, key: string): string {
  const v = stringOrNull(obj, key);
  if (v === null) throw new ProtonApiError(0, `Missing "${key}" in server response`);
  return v;
}

function intOrNull(obj: Json, key: string): number | null {
  const v = obj[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

function int(obj: Json, key: string): number {
  const v = intOrNull(obj, key);
  if (v === null) throw new ProtonApiError(0, `Missing "${key}" in server response`);
  return v;
}

export function authorizedHeaders(
  session: Pick<ProtonSession, 'uid' | 'accessToken'>,
): Record<string, string> {
  return { 'x-pm-uid': session.uid, Authorization: `Bearer ${session.accessToken}` };
}

/** Parses a Proton API response, throwing ProtonApiError on HTTP errors or non-success codes. */
export async function parseProtonResponse(response: Response): Promise<Json> {
  const text = await response.text();
  let json: Json | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Json;
  } catch {
    json = null;
  }
  const code = (json && intOrNull(json, 'Code')) ?? 0;
  if (!response.ok || json === null || !SUCCESS_CODES.has(code)) {
    const message = (json && stringOrNull(json, 'Error')) ?? `HTTP ${response.status}`;
    throw new ProtonApiError(code, message, response.status);
  }
  return json;
}

/**
 * Minimal client for Proton's authentication API: SRP login, TOTP second factor, token refresh, logout
 * and key salts. Every request carries the x-pm-appversion header. Ported from the Android app.
 */
export class ProtonAuthClient {
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly baseUrl: string = PROTON_DEFAULT_BASE_URL,
    fetchFn?: FetchFn,
    private readonly appVersion: string = PROTON_APP_VERSION,
  ) {
    this.fetchFn = fetchFn ?? ((input, init) => fetch(input, init));
  }

  async login(username: string, password: string): Promise<AuthLoginResult> {
    let unauthSession: ProtonSession | null = null;
    try {
      unauthSession = await this.createUnauthSession();
    } catch (e) {
      if (!(e instanceof ProtonApiError)) throw e;
    }
    const info = await this.post('/core/v4/auth/info', { Username: username }, unauthSession);
    const version = int(info, 'Version');
    if (version !== 3 && version !== 4) {
      throw new ProtonApiError(
        0,
        `This account uses a legacy password scheme (version ${version}). ` +
          'Sign in once at proton.me to upgrade it, then try again.',
      );
    }
    const modulus = decodeModulus(string(info, 'Modulus'));
    const serverEphemeral = decodeBase64(string(info, 'ServerEphemeral'));
    const hashedPassword = await hashPassword(version, password, string(info, 'Salt'), modulus);
    const proofs = generateProofs(modulus, serverEphemeral, hashedPassword);
    const auth = await this.post(
      '/core/v4/auth',
      {
        Username: username,
        ClientEphemeral: encodeBase64(proofs.clientEphemeral),
        ClientProof: encodeBase64(proofs.clientProof),
        SRPSession: string(info, 'SRPSession'),
      },
      unauthSession,
    );
    if (!constantTimeEquals(decodeBase64(string(auth, 'ServerProof')), proofs.expectedServerProof)) {
      throw new ProtonApiError(0, 'Server proof verification failed');
    }
    const session: ProtonSession = {
      uid: string(auth, 'UID'),
      accessToken: string(auth, 'AccessToken'),
      refreshToken: string(auth, 'RefreshToken'),
      username,
      userId: stringOrNull(auth, 'UserID') ?? '',
      keyPassphrases: {},
    };
    if (intOrNull(auth, 'PasswordMode') === 2) {
      await this.logoutQuietly(session);
      throw new ProtonApiError(0, 'Accounts with a separate mailbox password are not supported yet.');
    }
    const twoFactor = twoFactorFlags(auth);
    if ((twoFactor & TOTP) !== 0) return { kind: 'twoFactorRequired', session };
    if (twoFactor !== 0) {
      await this.logoutQuietly(session);
      throw new ProtonApiError(0, 'Only authenticator-app (TOTP) two-factor authentication is supported.');
    }
    return { kind: 'success', session };
  }

  async submitTwoFactor(session: ProtonSession, code: string): Promise<ProtonSession> {
    try {
      await this.post('/core/v4/auth/2fa', { TwoFactorCode: code.trim() }, session);
    } catch (e) {
      if (e instanceof ProtonApiError && e.code !== HUMAN_VERIFICATION_REQUIRED && e.httpStatus === 422) {
        throw new ProtonApiError(e.code, e.message, e.httpStatus, INVALID_TWO_FACTOR_MESSAGE);
      }
      throw e;
    }
    return session;
  }

  /** Computes the key passphrases from the login password and the user's key salts. */
  async fetchKeyPassphrases(session: ProtonSession, password: string): Promise<Record<string, string>> {
    const response = await this.get('/core/v4/keys/salts', session);
    const salts = Array.isArray(response.KeySalts) ? (response.KeySalts as unknown[]) : [];
    const out: Record<string, string> = {};
    for (const element of salts) {
      if (!element || typeof element !== 'object') continue;
      const id = stringOrNull(element as Json, 'ID');
      const salt = stringOrNull(element as Json, 'KeySalt');
      if (!id || !salt) continue;
      out[id] = await mailboxPassword(password, salt);
    }
    return out;
  }

  async refresh(session: ProtonSession): Promise<ProtonSession> {
    const response = await this.send('/auth/v4/refresh', {
      method: 'POST',
      headers: { 'x-pm-uid': session.uid, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        UID: session.uid,
        RefreshToken: session.refreshToken,
        ResponseType: 'token',
        GrantType: 'refresh_token',
        RedirectURI: 'http://protonmail.ch',
      }),
    });
    return {
      ...session,
      accessToken: string(response, 'AccessToken'),
      refreshToken: string(response, 'RefreshToken'),
    };
  }

  async logout(session: ProtonSession): Promise<void> {
    await this.send('/core/v4/auth', { method: 'DELETE', headers: authorizedHeaders(session) });
  }

  async logoutQuietly(session: ProtonSession): Promise<void> {
    try {
      await this.logout(session);
    } catch {
      // Best effort: the session expires on its own.
    }
  }

  /** Authorized GET returning the parsed JSON body. */
  get(path: string, session: ProtonSession): Promise<Json> {
    return this.send(path, { method: 'GET', headers: authorizedHeaders(session) });
  }

  private async createUnauthSession(): Promise<ProtonSession> {
    const response = await this.send('/auth/v4/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    return {
      uid: string(response, 'UID'),
      accessToken: string(response, 'AccessToken'),
      refreshToken: stringOrNull(response, 'RefreshToken') ?? '',
      username: '',
      userId: '',
      keyPassphrases: {},
    };
  }

  private post(path: string, body: Json, session: ProtonSession | null): Promise<Json> {
    return this.send(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(session ? authorizedHeaders(session) : {}) },
      body: JSON.stringify(body),
    });
  }

  private async send(
    path: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<Json> {
    const response = await this.fetchFn(this.baseUrl + path, {
      method: init.method,
      headers: { ...init.headers, 'x-pm-appversion': this.appVersion, Accept: PROTON_ACCEPT },
      body: init.body,
    });
    return parseProtonResponse(response);
  }
}

function twoFactorFlags(auth: Json): number {
  const nested = auth['2FA'];
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const enabled = intOrNull(nested as Json, 'Enabled');
    if (enabled !== null) return enabled;
  }
  return intOrNull(auth, 'TwoFactor') ?? 0;
}
