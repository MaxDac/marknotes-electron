import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { RemoteUnavailableError, type DriveAccount } from '../src/shared/types';
import { PROTON_APP_VERSION } from '../src/main/config';
import { ProtonApiError, ProtonAuthClient } from '../src/main/connectors/proton/authClient';
import { ProtonHttpClient, ProtonSessionHolder } from '../src/main/connectors/proton/httpClient';
import { ProtonConnector } from '../src/main/connectors/proton/index';
import { sessionFromJson, type ProtonSession } from '../src/main/connectors/proton/session';
import {
  concatBytes,
  decodeModulus,
  encodeBase64,
  expandHash,
  fromBigInt,
  hashPassword,
  modPow,
  toBigInt,
} from '../src/main/connectors/proton/srp';
import { MemorySecretVault } from '../src/main/vault';

const MODULUS_BASE64 =
  'W2z5HBi8RvsfYzZTS7qBaUxxPhsfHJFZpu3Kd6s1JafNrCCH9rfvPLrfuqocxWPgWDH2R8neK7PkNvjxto9TStuY5z7jAzWRvFWN9cQhAKkdWgy0JY6ywVn22+HFpF4cYesHrqFIKUPDMSSIlWjBVmEJZ/MusD44ZT29xcPrOqeZvwtCffKtGAIjLYPZIEbZKnDM1Dm3q2K/xS5h+xdhjnndhsrkwm9U9oyA2wxzSXFL+pdfj2fOdRwuR5nW0J2NFrq3kJjkRmpO/Genq1UW+TEknIWAb6VzJJJA244K/H8cnSx2+nSNZO3bbo6Ys228ruV9A8m6DhxmS+bihN3ttQ==';
const SIGNED_MODULUS = [
  '-----BEGIN PGP SIGNED MESSAGE-----',
  'Hash: SHA256',
  '',
  MODULUS_BASE64,
  '-----BEGIN PGP SIGNATURE-----',
  'Version: ProtonMail',
  'Comment: https://protonmail.com',
  '',
  'wl4EARYIABAFAlwB1j0JEDUFhcTpUY8mAAD8CgEAnsFnF4cF0uSHKkXa1GIa',
  'GO86yMV4zDZEZcDSJo0fgr8A/AlupGN9EdHlsrZLmTA1vhIx+rOgxdEff28N',
  'kvNM7qIK',
  '=q6vu',
  '-----END PGP SIGNATURE-----',
].join('\n');
const BASE = 'https://proton.test';
const PASSWORD = 'hunter2-correct';

/** SRP server from the Android SrpTestFixtures. */
class SrpServer {
  readonly serverEphemeral: Uint8Array;
  private readonly n: bigint;
  private readonly v: bigint;
  private readonly b: bigint;

  constructor(modulus: Uint8Array, hashedPassword: Uint8Array) {
    this.n = toBigInt(modulus);
    const k = toBigInt(expandHash(concatBytes(fromBigInt(2n), modulus))) % this.n;
    this.v = modPow(2n, toBigInt(hashedPassword), this.n);
    this.b = toBigInt(randomBytes(256)) % (this.n - 1n);
    this.serverEphemeral = fromBigInt((k * this.v + modPow(2n, this.b, this.n)) % this.n);
  }

  verify(a: Uint8Array, m: Uint8Array): Uint8Array | null {
    const u = toBigInt(expandHash(concatBytes(a, this.serverEphemeral)));
    const s = fromBigInt(modPow((toBigInt(a) * modPow(this.v, u, this.n)) % this.n, this.b, this.n));
    const expected = expandHash(concatBytes(a, this.serverEphemeral, s));
    if (!Buffer.from(expected).equals(Buffer.from(m))) return null;
    return expandHash(concatBytes(a, m, s));
  }
}

interface Recorded {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

class FakeProton {
  readonly requests: Recorded[] = [];
  twoFactorEnabled = 0;
  humanVerification = false;
  passwordMode = 1;
  private readonly salt = encodeBase64(randomBytes(10));
  private srp!: SrpServer;

  async init(): Promise<this> {
    const modulus = decodeModulus(SIGNED_MODULUS);
    this.srp = new SrpServer(modulus, await hashPassword(4, PASSWORD, this.salt, modulus));
    return this;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const body = typeof init?.body === 'string' ? init.body : '';
    const headers = new Headers(init?.headers);
    const method = init?.method ?? 'GET';
    this.requests.push({ method, path: url.pathname, headers, body });
    switch (url.pathname) {
      case '/auth/v4/sessions':
        return json(200, { Code: 1000, UID: 'unauth', AccessToken: 'ua', RefreshToken: 'ur' });
      case '/core/v4/auth/info':
        if (this.humanVerification) return json(422, { Code: 9001, Error: 'Human verification required' });
        return json(200, {
          Code: 1000,
          Version: 4,
          Modulus: SIGNED_MODULUS,
          ServerEphemeral: encodeBase64(this.srp.serverEphemeral),
          Salt: this.salt,
          SRPSession: 'srp-session',
        });
      case '/core/v4/auth': {
        if (method === 'DELETE') return json(200, { Code: 1000 });
        const req = JSON.parse(body) as { ClientEphemeral: string; ClientProof: string };
        const proof = this.srp.verify(
          Buffer.from(req.ClientEphemeral, 'base64'),
          Buffer.from(req.ClientProof, 'base64'),
        );
        if (!proof) return json(422, { Code: 8002, Error: 'Incorrect login credentials' });
        return json(200, {
          Code: 1000,
          UID: 'uid-1',
          AccessToken: 'at',
          RefreshToken: 'rt',
          UserID: 'user',
          ServerProof: encodeBase64(proof),
          PasswordMode: this.passwordMode,
          '2FA': { Enabled: this.twoFactorEnabled },
        });
      }
      case '/core/v4/auth/2fa':
        return body.includes('123456')
          ? json(200, { Code: 1000, Scopes: ['full'] })
          : json(422, { Code: 8002, Error: 'Incorrect code' });
      case '/auth/v4/refresh':
        return json(200, { Code: 1000, AccessToken: 'at2', RefreshToken: 'rt2' });
      case '/core/v4/keys/salts':
        return json(200, {
          Code: 1000,
          KeySalts: [{ ID: 'key-1', KeySalt: encodeBase64(new Uint8Array(16).fill(3)) }],
        });
      default:
        return json(404, { Code: 404, Error: 'Not found' });
    }
  };

  paths = () => this.requests.map((r) => `${r.method} ${r.path}`);
}

async function expectApiError(promise: Promise<unknown>): Promise<ProtonApiError> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ProtonApiError);
  return error as ProtonApiError;
}

describe('ProtonAuthClient', () => {
  let server: FakeProton;
  let client: ProtonAuthClient;

  beforeEach(async () => {
    server = await new FakeProton().init();
    client = new ProtonAuthClient(BASE, server.fetch);
  });

  it('logs in without two-factor and sends the app version and Accept headers everywhere', async () => {
    const result = await client.login('alice', PASSWORD);
    expect(result.kind).toBe('success');
    expect(result.session).toMatchObject({
      uid: 'uid-1',
      accessToken: 'at',
      refreshToken: 'rt',
      userId: 'user',
    });
    expect(server.requests.length).toBeGreaterThanOrEqual(3);
    for (const r of server.requests) {
      expect(r.headers.get('x-pm-appversion')).toBe('external-drive-marknotes@0.1.0-alpha');
      expect(r.headers.get('accept')).toBe('application/vnd.protonmail.v1+json');
    }
    expect(PROTON_APP_VERSION).toBe('external-drive-marknotes@0.1.0-alpha');
  });

  it('uses the unauthenticated session for auth/info', async () => {
    await client.login('alice', PASSWORD);
    const info = server.requests.find((r) => r.path === '/core/v4/auth/info')!;
    expect(info.headers.get('x-pm-uid')).toBe('unauth');
    expect(info.headers.get('authorization')).toBe('Bearer ua');
  });

  it('logs in with TOTP', async () => {
    server.twoFactorEnabled = 1;
    const result = await client.login('alice', PASSWORD);
    expect(result.kind).toBe('twoFactorRequired');
    const session = await client.submitTwoFactor(result.session, '123456');
    expect(session.uid).toBe('uid-1');
    const twoFa = server.requests.find((r) => r.path === '/core/v4/auth/2fa')!;
    expect(twoFa.headers.get('x-pm-uid')).toBe('uid-1');
  });

  it('reports an invalid TOTP code', async () => {
    server.twoFactorEnabled = 1;
    const result = await client.login('alice', PASSWORD);
    const error = await expectApiError(client.submitTwoFactor(result.session, '000000'));
    expect(error.userMessage).toMatch(/two-factor code/);
  });

  it('reports a wrong password', async () => {
    const error = await expectApiError(client.login('alice', 'nope'));
    expect(error.code).toBe(8002);
    expect(error.userMessage).toBe('Incorrect username or password.');
  });

  it('reports human verification', async () => {
    server.humanVerification = true;
    const error = await expectApiError(client.login('alice', PASSWORD));
    expect(error.isHumanVerificationRequired).toBe(true);
    expect(error.userMessage).toContain('captcha');
  });

  it('rejects two-password mode and logs out', async () => {
    server.passwordMode = 2;
    const error = await expectApiError(client.login('alice', PASSWORD));
    expect(error.userMessage).toMatch(/separate mailbox password/);
    expect(server.paths()).toContain('DELETE /core/v4/auth');
  });

  it('rejects FIDO2-only two-factor and logs out', async () => {
    server.twoFactorEnabled = 2;
    const error = await expectApiError(client.login('alice', PASSWORD));
    expect(error.userMessage).toMatch(/TOTP/);
    expect(server.paths()).toContain('DELETE /core/v4/auth');
  });

  it('refresh rotates the tokens', async () => {
    const session: ProtonSession = {
      uid: 'uid-1',
      accessToken: 'at',
      refreshToken: 'rt',
      username: 'alice',
      userId: 'user',
      keyPassphrases: {},
    };
    const refreshed = await client.refresh(session);
    expect(refreshed.accessToken).toBe('at2');
    expect(refreshed.refreshToken).toBe('rt2');
    const req = server.requests.at(-1)!;
    expect(JSON.parse(req.body)).toMatchObject({
      UID: 'uid-1',
      RefreshToken: 'rt',
      GrantType: 'refresh_token',
    });
  });

  it('derives key passphrases from the key salts', async () => {
    const { session } = await client.login('alice', PASSWORD);
    const passphrases = await client.fetchKeyPassphrases(session, PASSWORD);
    expect(Object.keys(passphrases)).toEqual(['key-1']);
    expect(passphrases['key-1']).toHaveLength(31);
  });
});

describe('ProtonConnector', () => {
  let server: FakeProton;
  let vault: MemorySecretVault;
  let connector: ProtonConnector;

  beforeEach(async () => {
    server = await new FakeProton().init();
    vault = new MemorySecretVault();
    connector = new ProtonConnector({ vault, fetch: server.fetch, baseUrl: BASE });
  });

  it('stores the session without the plain password', async () => {
    const result = await connector.login('alice', PASSWORD);
    expect(result).toEqual({
      kind: 'signedIn',
      account: { id: 'proton:user', provider: 'proton', label: 'alice' },
    });
    const raw = (await vault.get('proton:user'))!;
    expect(raw).not.toContain(PASSWORD);
    const session = sessionFromJson(raw)!;
    expect(session).toMatchObject({ uid: 'uid-1', accessToken: 'at', refreshToken: 'rt', username: 'alice' });
    expect(Object.keys(session.keyPassphrases)).toEqual(['key-1']);
  });

  it('completes a two-factor login and lets the user retry an invalid code', async () => {
    server.twoFactorEnabled = 1;
    const result = await connector.login('alice', PASSWORD);
    if (result.kind !== 'twoFactor') throw new Error('expected two-factor');
    await expect(connector.submitTwoFactor(result.pendingId, '111111')).rejects.toBeInstanceOf(
      ProtonApiError,
    );
    expect(await vault.get('proton:user')).toBeNull();
    const account = await connector.submitTwoFactor(result.pendingId, '123456');
    expect(account.id).toBe('proton:user');
    expect(await vault.get('proton:user')).not.toBeNull();
    await expect(connector.submitTwoFactor(result.pendingId, '123456')).rejects.toBeInstanceOf(
      ProtonApiError,
    );
  });

  it('cancelLogin logs the pending session out', async () => {
    server.twoFactorEnabled = 1;
    const result = await connector.login('alice', PASSWORD);
    if (result.kind !== 'twoFactor') throw new Error('expected two-factor');
    await connector.cancelLogin(result.pendingId);
    expect(server.paths()).toContain('DELETE /core/v4/auth');
    await expect(connector.submitTwoFactor(result.pendingId, '123456')).rejects.toBeInstanceOf(
      ProtonApiError,
    );
  });

  it('signOut revokes the session and deletes the vault entry', async () => {
    await connector.login('alice', PASSWORD);
    await connector.signOut('proton:user');
    const del = server.requests.find((r) => r.method === 'DELETE')!;
    expect(del.headers.get('x-pm-uid')).toBe('uid-1');
    expect(del.headers.get('authorization')).toBe('Bearer at');
    expect(await vault.get('proton:user')).toBeNull();
  });

  it('has no interactive sign-in nor folder browser', async () => {
    await expect(connector.signIn()).rejects.toThrow(/login/);
    expect(await connector.folderBrowser()).toBeNull();
    expect(connector.unavailableReason()).toBeNull();
    expect(connector.provider).toBe('proton');
  });

  it('store() needs a signed-in account', async () => {
    const account: DriveAccount = {
      id: 'proton:nobody',
      provider: 'proton',
      label: 'x',
      remoteFolder: '',
      createRootFolder: true,
      rootFolderName: 'MarkNotes',
    };
    await expect(connector.store(account)).rejects.toBeInstanceOf(RemoteUnavailableError);
  });
});

describe('ProtonHttpClient', () => {
  const session: ProtonSession = {
    uid: 'uid-1',
    accessToken: 'old',
    refreshToken: 'rt',
    username: 'alice',
    userId: 'user',
    keyPassphrases: { k: 'p' },
  };

  function setup(refreshStatus = 200) {
    const seen: { url: string; headers: Headers }[] = [];
    const fetchFn = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, headers });
      if (url.endsWith('/auth/v4/refresh')) {
        return refreshStatus === 200
          ? json(200, { Code: 1000, AccessToken: 'new', RefreshToken: 'rt2' })
          : json(refreshStatus, { Code: 10013, Error: 'Invalid refresh token' });
      }
      if (url.startsWith('https://storage.test')) return new Response('blob');
      return headers.get('authorization') === 'Bearer new'
        ? json(200, { Code: 1000, Value: 42 })
        : json(401, { Code: 401, Error: 'Unauthorized' });
    };
    const vault = new MemorySecretVault();
    const auth = new ProtonAuthClient(BASE, fetchFn);
    const holder = new ProtonSessionHolder('proton:user', { ...session }, vault, auth);
    const http = new ProtonHttpClient(BASE, fetchFn, holder, PROTON_APP_VERSION);
    return { seen, vault, holder, http };
  }

  it('refreshes on 401, retries and persists the new tokens', async () => {
    const { seen, vault, http } = setup();
    const response = await http.fetchJson({
      url: `${BASE}/drive/volumes`,
      method: 'GET',
      headers: new Headers(),
      timeoutMs: 1000,
    });
    expect(response.status).toBe(200);
    expect(seen.map((s) => new URL(s.url).pathname)).toEqual([
      '/drive/volumes',
      '/auth/v4/refresh',
      '/drive/volumes',
    ]);
    expect(seen.every((s) => s.headers.get('x-pm-appversion') === PROTON_APP_VERSION)).toBe(true);
    expect(seen[0].headers.get('x-pm-uid')).toBe('uid-1');
    expect(sessionFromJson((await vault.get('proton:user'))!)).toMatchObject({
      accessToken: 'new',
      refreshToken: 'rt2',
      keyPassphrases: { k: 'p' },
    });
  });

  it('does not send session headers to other hosts', async () => {
    const { seen, http } = setup();
    await http.fetchBlob({
      url: 'https://storage.test/block',
      method: 'GET',
      headers: new Headers(),
      timeoutMs: 1000,
    });
    expect(seen[0].headers.get('authorization')).toBeNull();
    expect(seen[0].headers.get('x-pm-appversion')).toBe(PROTON_APP_VERSION);
  });

  it('forgets the session when the refresh token is rejected', async () => {
    const { vault, holder, http } = setup(422);
    await vault.set('proton:user', 'x');
    await expect(http.getJson('/core/v4/users')).rejects.toBeInstanceOf(RemoteUnavailableError);
    expect(holder.current).toBeNull();
    expect(await vault.get('proton:user')).toBeNull();
  });
});
