import { randomUUID } from 'node:crypto';
import {
  RemoteUnavailableError,
  syncFolder,
  type DriveAccount,
  type RemoteDriveStore,
} from '../../../shared/types';
import { PROTON_APP_VERSION } from '../../config';
import type { DriveConnector, FetchFn, RemoteFolderBrowser, SecretVault, SignedInAccount } from '../types';
import { ProtonAccount } from './account';
import { PROTON_DEFAULT_BASE_URL, ProtonApiError, ProtonAuthClient } from './authClient';
import { ProtonDriveStore } from './driveStore';
import { LOGIN_AGAIN_MESSAGE, ProtonHttpClient, ProtonSessionHolder } from './httpClient';
import { OpenPGPCryptoAdapter } from './openpgpCrypto';
import { accountIdFor, sessionFromJson, sessionToJson, type ProtonSession } from './session';
import { ProtonSrpModule } from './srpModule';

export { ProtonApiError, INVALID_TWO_FACTOR_MESSAGE } from './authClient';
export { LOGIN_AGAIN_MESSAGE, SESSION_EXPIRED_MESSAGE } from './httpClient';
export type { ProtonSession } from './session';

export type ProtonLoginResult =
  { kind: 'signedIn'; account: SignedInAccount } | { kind: 'twoFactor'; pendingId: string };

export interface ProtonConnectorDeps {
  vault: SecretVault;
  fetch?: FetchFn;
  /** API base URL, https://drive-api.proton.me by default. */
  baseUrl?: string;
}

interface PendingLogin {
  session: ProtonSession;
  password: string;
}

interface CachedStore {
  key: string;
  store: RemoteDriveStore;
}

/**
 * Proton Drive, through the official Drive SDK. Sign-in goes through the in-app login form (SRP + TOTP):
 * `signIn()` is not supported, use `login()` and `submitTwoFactor()`. The session (tokens + key
 * passphrases, never the password) is stored in the vault under `proton:<UserID>`.
 */
export class ProtonConnector implements DriveConnector {
  readonly provider = 'proton' as const;
  private readonly auth: ProtonAuthClient;
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly vault: SecretVault;
  private readonly pending = new Map<string, PendingLogin>();
  private readonly stores = new Map<string, CachedStore>();
  private readonly holders = new Map<string, ProtonSessionHolder>();

  constructor(deps: ProtonConnectorDeps) {
    this.vault = deps.vault;
    this.baseUrl = (deps.baseUrl ?? PROTON_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchFn = deps.fetch ?? ((input, init) => fetch(input, init));
    this.auth = new ProtonAuthClient(this.baseUrl, this.fetchFn, PROTON_APP_VERSION);
  }

  unavailableReason(): null {
    return null;
  }

  /** Logs in with SRP. Resolves `twoFactor` when a TOTP code must be sent with submitTwoFactor(). */
  async login(username: string, password: string): Promise<ProtonLoginResult> {
    const result = await this.auth.login(username.trim(), password);
    if (result.kind === 'twoFactorRequired') {
      const pendingId = randomUUID();
      this.pending.set(pendingId, { session: result.session, password });
      return { kind: 'twoFactor', pendingId };
    }
    return { kind: 'signedIn', account: await this.complete(result.session, password) };
  }

  /** Sends the TOTP code. An invalid code throws and keeps the login pending so the user can retry. */
  async submitTwoFactor(pendingId: string, code: string): Promise<SignedInAccount> {
    const pending = this.pending.get(pendingId);
    if (!pending) throw new ProtonApiError(0, 'The login expired, please log in again.');
    const session = await this.auth.submitTwoFactor(pending.session, code);
    this.pending.delete(pendingId);
    return this.complete(session, pending.password);
  }

  async cancelLogin(pendingId: string): Promise<void> {
    const pending = this.pending.get(pendingId);
    this.pending.delete(pendingId);
    if (pending) await this.auth.logoutQuietly(pending.session);
  }

  signIn(): Promise<SignedInAccount | null> {
    return Promise.reject(new Error('Proton Drive uses the login form: call login() instead of signIn().'));
  }

  /** Like Android, the folder to sync is typed rather than browsed. */
  async folderBrowser(): Promise<RemoteFolderBrowser | null> {
    return null;
  }

  async store(account: DriveAccount): Promise<RemoteDriveStore> {
    const holder = await this.holder(account.id);
    const folder = syncFolder(account);
    const key = `${holder.require().uid}|${folder}`;
    const cached = this.stores.get(account.id);
    if (cached?.key === key) return cached.store;

    await import('./polyfill');
    const { MemoryCache, ProtonDriveClient } = await import('./sdk');
    const http = new ProtonHttpClient(this.baseUrl, this.fetchFn, holder, PROTON_APP_VERSION);
    const crypto = new OpenPGPCryptoAdapter();
    const client = new ProtonDriveClient({
      httpClient: http,
      entitiesCache: new MemoryCache(),
      cryptoCache: new MemoryCache(),
      account: new ProtonAccount(http, () => holder.current, crypto),
      openPGPCryptoModule: crypto,
      srpModule: new ProtonSrpModule(),
      config: { baseUrl: new URL(this.baseUrl).host },
    });
    const store = new ProtonDriveStore(client, folder);
    this.stores.set(account.id, { key, store });
    return store;
  }

  async signOut(accountId: string): Promise<void> {
    const session =
      this.holders.get(accountId)?.current ?? sessionFromJson((await this.vault.get(accountId)) ?? '');
    this.holders.delete(accountId);
    this.stores.delete(accountId);
    if (session) await this.auth.logoutQuietly(session);
    await this.vault.delete(accountId);
  }

  private async complete(session: ProtonSession, password: string): Promise<SignedInAccount> {
    let keyPassphrases: Record<string, string> = {};
    try {
      keyPassphrases = await this.auth.fetchKeyPassphrases(session, password);
    } catch {
      // Non-fatal, as on Android: syncing then asks to sign in again.
    }
    const saved: ProtonSession = { ...session, keyPassphrases };
    const id = accountIdFor(saved);
    await this.vault.set(id, sessionToJson(saved));
    this.holders.delete(id);
    this.stores.delete(id);
    return { id, provider: this.provider, label: saved.username };
  }

  private async holder(accountId: string): Promise<ProtonSessionHolder> {
    const existing = this.holders.get(accountId);
    if (existing?.current) return existing;
    const raw = await this.vault.get(accountId);
    const session = raw ? sessionFromJson(raw) : null;
    if (!session) throw new RemoteUnavailableError(LOGIN_AGAIN_MESSAGE);
    const holder = new ProtonSessionHolder(accountId, session, this.vault, this.auth);
    this.holders.set(accountId, holder);
    return holder;
  }
}
