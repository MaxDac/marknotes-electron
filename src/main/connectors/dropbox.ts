import { MANIFEST_PATH } from '../../shared/manifestPath';
import {
  RemoteChangedError,
  RemoteUnavailableError,
  syncFolder,
  type DriveAccount,
  type RemoteDriveStore,
  type RemoteEntry,
  type RemoteFolder,
} from '../../shared/types';
import { pkce, randomState, startLoopbackRedirect } from './loopback';
import type {
  DriveConnector,
  FetchFn,
  OpenExternal,
  RemoteFolderBrowser,
  SecretVault,
  SignedInAccount,
} from './types';

export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_API_URL = 'https://api.dropboxapi.com';
export const DROPBOX_CONTENT_URL = 'https://content.dropboxapi.com';
export const DROPBOX_REDIRECT_PATH = '/oauth/dropbox';
export const DROPBOX_SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
  'files.content.write',
];

const SIGN_IN_AGAIN = 'Sign in to Dropbox again';

/** Tagged union value as returned by the Dropbox API (`{".tag": "...", ...}`). */
interface Tagged {
  '.tag': string;
  [key: string]: unknown;
}

/** Error returned by a Dropbox endpoint. `error` is the structured route error (HTTP 409). */
export class DropboxError extends Error {
  override name = 'DropboxError';
  constructor(
    readonly status: number,
    message: string,
    readonly error?: Tagged,
  ) {
    super(message);
  }

  /** True when the route error matches the nested tags, e.g. is('path', 'not_found'). */
  is(...tags: string[]): boolean {
    let value: unknown = this.error;
    for (const tag of tags) {
      if (!value || typeof value !== 'object' || (value as Tagged)['.tag'] !== tag) return false;
      value = (value as Record<string, unknown>)[tag];
    }
    return true;
  }
}

/** Supplies the access token of the signed-in account. */
export interface DropboxTokens {
  accessToken(): Promise<string>;
  /** Gets a new access token after the current one was rejected. */
  refresh(): Promise<string>;
}

/** Dropbox-API-Arg must be ASCII: non-ASCII characters are escaped as \uXXXX. */
const headerSafeJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );

/** Minimal client for the Dropbox HTTP API v2. Retries once with a refreshed token on 401. */
export class DropboxClient {
  constructor(
    private readonly tokens: DropboxTokens,
    private readonly fetchFn: FetchFn = fetch,
    private readonly apiUrl = DROPBOX_API_URL,
    private readonly contentUrl = DROPBOX_CONTENT_URL,
  ) {}

  /** Calls an RPC endpoint (e.g. "files/list_folder") with a JSON argument. */
  async rpc<T>(endpoint: string, arg?: unknown): Promise<T> {
    const response = await this.send(`${this.apiUrl}/2/${endpoint}`, {
      headers: { 'Content-Type': 'application/json' },
      body: arg === undefined ? 'null' : JSON.stringify(arg),
    });
    const text = await response.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** Calls a content-download endpoint and returns the content. */
  async download(endpoint: string, arg: unknown): Promise<Uint8Array> {
    const response = await this.send(`${this.contentUrl}/2/${endpoint}`, {
      headers: { 'Dropbox-API-Arg': headerSafeJson(arg) },
    });
    return new Uint8Array(await response.arrayBuffer());
  }

  /** Calls a content-upload endpoint and returns its JSON result. */
  async upload<T>(endpoint: string, arg: unknown, bytes: Uint8Array): Promise<T> {
    const response = await this.send(`${this.contentUrl}/2/${endpoint}`, {
      headers: { 'Dropbox-API-Arg': headerSafeJson(arg), 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });
    return (await response.json()) as T;
  }

  private async send(url: string, init: { headers: Record<string, string>; body?: string | Uint8Array }) {
    let token = await this.tokens.accessToken();
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: { ...init.headers, Authorization: `Bearer ${token}` },
        body: init.body as BodyInit | undefined,
      });
      if (response.ok) return response;
      if (response.status === 401) {
        await response.body?.cancel();
        if (attempt > 0) throw new RemoteUnavailableError('Dropbox session expired, sign in again');
        token = await this.tokens.refresh();
        continue;
      }
      throw await DropboxClient.error(response);
    }
  }

  private static async error(response: Response): Promise<DropboxError> {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error_summary?: string; error?: Tagged };
      const summary = json.error_summary ?? text;
      return new DropboxError(response.status, `Dropbox error ${response.status}: ${summary}`, json.error);
    } catch {
      return new DropboxError(response.status, `Dropbox error ${response.status}${text ? `: ${text}` : ''}`);
    }
  }
}

/** Metadata of a file, folder or deleted entry. */
interface Metadata {
  '.tag'?: 'file' | 'folder' | 'deleted';
  name: string;
  id?: string;
  path_lower?: string;
  path_display?: string;
  rev?: string;
  server_modified?: string;
  /** Modification time set by the uploading client: the note's local edit time. */
  client_modified?: string;
}

interface ListFolderResult {
  entries: Metadata[];
  cursor: string;
  has_more: boolean;
}

/** Dropbox paths are "" for the root and "/a/b" otherwise. */
const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '');
export const dropboxPath = (path: string) => {
  const trimmed = trimSlashes(path);
  return trimmed === '' ? '' : `/${trimmed}`;
};

export class DropboxFolderBrowser implements RemoteFolderBrowser {
  constructor(private readonly client: DropboxClient) {}

  async listFolders(path: string): Promise<RemoteFolder[]> {
    const folders: RemoteFolder[] = [];
    let result = await this.client.rpc<ListFolderResult>('files/list_folder', { path: dropboxPath(path) });
    for (;;) {
      for (const it of result.entries) {
        if (it['.tag'] !== 'folder') continue;
        folders.push({ path: trimSlashes(it.path_display ?? it.path_lower ?? ''), name: it.name });
      }
      if (!result.has_more) break;
      result = await this.client.rpc<ListFolderResult>('files/list_folder/continue', {
        cursor: result.cursor,
      });
    }
    return folders.sort((a, b) => compare(a.name.toLowerCase(), b.name.toLowerCase()));
  }
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Mirrors the sync folder of a Dropbox account. The first snapshot lists the folder recursively; later
 * ones only fetch the changes since the saved cursor.
 */
export class DropboxDriveStore implements RemoteDriveStore {
  readonly supportsCaseOnlyRename = false;
  readonly timestampResolutionMillis = 1000;
  private readonly root: string;
  private readonly rootLower: string;
  private cursor: string | null = null;

  /** Entries keyed by lower-case relative path, since Dropbox paths are case-insensitive. */
  private readonly entries = new Map<string, RemoteEntry>();

  constructor(
    private readonly client: DropboxClient,
    syncFolder: string,
  ) {
    this.root = dropboxPath(syncFolder);
    this.rootLower = this.root.toLowerCase();
  }

  private absolute(path: string) {
    return `${this.root}/${trimSlashes(path)}`;
  }

  async snapshot(): Promise<RemoteEntry[]> {
    const saved = this.cursor;
    if (saved === null) {
      await this.fullListing();
    } else {
      let changes: ListFolderResult | null = null;
      try {
        changes = await this.client.rpc<ListFolderResult>('files/list_folder/continue', { cursor: saved });
      } catch (e) {
        if (!(e instanceof DropboxError && e.is('reset'))) throw e;
      }
      if (changes) await this.applyChanges(changes);
      else await this.fullListing();
    }
    return [...this.entries.values()];
  }

  private async fullListing() {
    this.entries.clear();
    this.cursor = null;
    const list = () =>
      this.client.rpc<ListFolderResult>('files/list_folder', { path: this.root, recursive: true });
    let first: ListFolderResult;
    try {
      first = await list();
    } catch (e) {
      if (!(e instanceof DropboxError && e.is('path', 'not_found')) || this.root === '') throw e;
      await this.client.rpc('files/create_folder_v2', { path: this.root, autorename: false });
      first = await list();
    }
    await this.applyChanges(first);
  }

  private async applyChanges(first: ListFolderResult) {
    let result = first;
    for (;;) {
      result.entries.forEach((m) => this.apply(m));
      this.cursor = result.cursor;
      if (!result.has_more) break;
      result = await this.client.rpc<ListFolderResult>('files/list_folder/continue', {
        cursor: result.cursor,
      });
    }
  }

  private apply(metadata: Metadata) {
    const lower = metadata.path_lower;
    if (lower === undefined) return;
    if (lower !== this.rootLower && !lower.startsWith(`${this.rootLower}/`)) return;
    const key = trimSlashes(lower.substring(this.rootLower.length));
    if (key === '' || key.split('/').some((it) => it.startsWith('.'))) return;
    if (metadata['.tag'] === 'deleted') {
      this.removeTree(key);
    } else {
      const entry = this.toEntry(metadata);
      if (entry) this.entries.set(key, entry);
    }
  }

  private removeTree(key: string) {
    for (const k of [...this.entries.keys()]) {
      if (k === key || k.startsWith(`${key}/`)) this.entries.delete(k);
    }
  }

  private toEntry(metadata: Metadata, tag = metadata['.tag']): RemoteEntry | null {
    const display = metadata.path_display;
    if (display === undefined) return null;
    // Only the case of the path may differ between path_display and path_lower.
    const relative = trimSlashes(display.substring(this.root.length));
    switch (tag) {
      case 'file':
        return {
          path: relative,
          id: metadata.id ?? '',
          isFolder: false,
          version: metadata.rev ?? '',
          modifiedMillis: parseTime(metadata.client_modified ?? metadata.server_modified),
        };
      case 'folder':
        return { path: relative, id: metadata.id ?? '', isFolder: true, version: '', modifiedMillis: 0 };
      default:
        return null;
    }
  }

  /** Caches an entry returned by an upload or a folder creation, which carry no ".tag". */
  private remember(metadata: Metadata, tag: 'file' | 'folder'): RemoteEntry {
    const entry = this.toEntry(metadata, metadata['.tag'] ?? tag);
    if (!entry) throw new Error(`Unexpected Dropbox metadata for ${metadata.path_display}`);
    this.entries.set(entry.path.toLowerCase(), entry);
    return entry;
  }

  download(entry: RemoteEntry): Promise<Uint8Array> {
    return this.client.download('files/download', { path: entry.id });
  }

  uploadNew(path: string, bytes: Uint8Array, modifiedMillis?: number): Promise<RemoteEntry> {
    return this.upload(path, bytes, 'add', modifiedMillis);
  }

  uploadRevision(entry: RemoteEntry, bytes: Uint8Array, modifiedMillis?: number): Promise<RemoteEntry> {
    return this.upload(entry.path, bytes, { '.tag': 'update', update: entry.version }, modifiedMillis);
  }

  private async upload(
    path: string,
    bytes: Uint8Array,
    mode: string | Tagged,
    modifiedMillis?: number,
  ): Promise<RemoteEntry> {
    const metadata = await this.client.upload<Metadata>(
      'files/upload',
      {
        path: this.absolute(path),
        mode,
        autorename: false,
        ...(mode === 'add' ? { strict_conflict: true } : {}),
        ...(modifiedMillis !== undefined ? { client_modified: dropboxTime(modifiedMillis) } : {}),
      },
      bytes,
    );
    return this.remember(metadata, 'file');
  }

  async createFolder(path: string): Promise<RemoteEntry> {
    const result = await this.client.rpc<{ metadata: Metadata }>('files/create_folder_v2', {
      path: this.absolute(path),
      autorename: false,
    });
    return this.remember(result.metadata, 'folder');
  }

  /** Files are deleted by id and only at the planned revision (`parent_rev`). */
  async delete(entry: RemoteEntry): Promise<void> {
    if (entry.isFolder) throw new Error('Dropbox does not support atomic empty-only folder deletion');
    const conditional = !entry.isFolder && entry.version !== '';
    const path = this.absolute(entry.path);
    try {
      await this.client.rpc('files/delete_v2', conditional ? { path, parent_rev: entry.version } : { path });
    } catch (e) {
      if (!(e instanceof DropboxError && e.is('path_lookup', 'not_found'))) throw e;
      if (conditional && (await this.currentRev(path)) !== null) throw new RemoteChangedError(entry.path);
    }
    this.removeTree(entry.path.toLowerCase());
  }

  /** The current revision of the file at `path`, null when it no longer exists. */
  private async currentRev(path: string): Promise<string | null> {
    try {
      const metadata = await this.client.rpc<Metadata>('files/get_metadata', { path });
      return metadata['.tag'] === 'deleted' ? null : (metadata.rev ?? '');
    } catch (e) {
      if (e instanceof DropboxError && e.is('path', 'not_found')) return null;
      throw e;
    }
  }

  async readManifest(): Promise<Uint8Array | null> {
    try {
      return await this.client.download('files/download', { path: this.absolute(MANIFEST_PATH) });
    } catch (e) {
      if (!(e instanceof DropboxError && e.is('path', 'not_found'))) throw e;
      return null;
    }
  }

  async rename(_entry: RemoteEntry, _toPath: string): Promise<void> {
    throw new Error(
      'Dropbox case-only moves require a recoverable intermediate rename and are not supported',
    );
  }

  async writeManifest(bytes: Uint8Array): Promise<void> {
    await this.client.upload(
      'files/upload',
      { path: this.absolute(MANIFEST_PATH), mode: 'overwrite', mute: true },
      bytes,
    );
  }
}

function parseTime(value: string | undefined): number {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? 0 : time;
}

/** Dropbox timestamps are "%Y-%m-%dT%H:%M:%SZ", without milliseconds. */
export const dropboxTime = (millis: number) => new Date(millis).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** What is stored in the vault for a Dropbox account. */
export interface DropboxCredential {
  refreshToken: string;
  accessToken: string;
  /** Epoch millis after which accessToken is expired. */
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
}

/** Access tokens of one account, refreshed with the stored refresh token and saved back to the vault. */
class DropboxSession implements DropboxTokens {
  private refreshing: Promise<string> | null = null;
  closed = false;

  constructor(
    private readonly accountId: string | null,
    private credential: DropboxCredential,
    private readonly appKey: string,
    private readonly vault: SecretVault,
    private readonly fetchFn: FetchFn,
  ) {}

  async accessToken(): Promise<string> {
    if (this.credential.accessToken && this.credential.expiresAt - 60_000 > Date.now()) {
      return this.credential.accessToken;
    }
    return this.refresh();
  }

  refresh(): Promise<string> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = null));
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const response = await this.fetchFn(`${DROPBOX_API_URL}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: this.credential.refreshToken,
        client_id: this.appKey,
      }).toString(),
    });
    if (response.status === 400 || response.status === 401) {
      await response.body?.cancel();
      throw new RemoteUnavailableError(SIGN_IN_AGAIN);
    }
    if (!response.ok) throw new Error(`Dropbox token refresh failed: HTTP ${response.status}`);
    const token = (await response.json()) as TokenResponse;
    this.credential = {
      refreshToken: token.refresh_token ?? this.credential.refreshToken,
      accessToken: token.access_token,
      expiresAt: Date.now() + (token.expires_in ?? 14_400) * 1000,
    };
    if (this.accountId && !this.closed) await this.vault.set(this.accountId, JSON.stringify(this.credential));
    return token.access_token;
  }
}

export interface DropboxConnectorDeps {
  appKey: string;
  vault: SecretVault;
  openExternal: OpenExternal;
  fetch?: FetchFn;
}

/**
 * Dropbox through its HTTP API. Sign-in uses OAuth with PKCE in the system browser and a loopback
 * redirect; the refresh token is stored in the vault under the account id.
 */
export class DropboxConnector implements DriveConnector {
  readonly provider = 'dropbox' as const;

  private readonly fetchFn: FetchFn;
  private readonly sessions = new Map<string, { session: DropboxSession; client: DropboxClient }>();
  private readonly stores = new Map<string, { folder: string; store: DropboxDriveStore }>();

  constructor(private readonly deps: DropboxConnectorDeps) {
    this.fetchFn = deps.fetch ?? ((...args) => fetch(...args));
  }

  unavailableReason(): string | null {
    return this.deps.appKey
      ? null
      : 'No Dropbox app key in this build. See the README to set DROPBOX_APP_KEY.';
  }

  async signIn(signal?: AbortSignal): Promise<SignedInAccount | null> {
    const unavailable = this.unavailableReason();
    if (unavailable) throw new Error(unavailable);
    if (signal?.aborted) return null;
    const redirect = await startLoopbackRedirect(DROPBOX_REDIRECT_PATH, { signal });
    try {
      const { verifier, challenge } = await pkce();
      const state = randomState();
      const url = new URL(DROPBOX_AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: this.deps.appKey,
        response_type: 'code',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        redirect_uri: redirect.redirectUri,
        token_access_type: 'offline',
        scope: DROPBOX_SCOPES.join(' '),
        state,
      }).toString();
      await this.deps.openExternal(url.toString());

      let params: URLSearchParams;
      try {
        params = await redirect.result;
      } catch (e) {
        if ((e as { name?: string } | null)?.name === 'AbortError') return null;
        throw e;
      }
      const code = params.get('code');
      if (params.has('error') || !code) return null;
      if (params.get('state') !== state) throw new Error('Dropbox sign-in failed: unexpected state');

      const credential = await this.exchangeCode(code, verifier, redirect.redirectUri);
      const client = new DropboxClient(
        new DropboxSession(null, credential, this.deps.appKey, this.deps.vault, this.fetchFn),
        this.fetchFn,
      );
      const account = await client.rpc<{ email?: string; name?: { display_name?: string } }>(
        'users/get_current_account',
      );
      const label = account.email?.trim() || account.name?.display_name || 'Dropbox';
      const id = `dropbox-${crypto.randomUUID()}`;
      await this.deps.vault.set(id, JSON.stringify(credential));
      return { id, provider: this.provider, label };
    } finally {
      redirect.close();
    }
  }

  private async exchangeCode(
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<DropboxCredential> {
    const response = await this.fetchFn(`${DROPBOX_API_URL}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: this.deps.appKey,
        redirect_uri: redirectUri,
      }).toString(),
    });
    if (!response.ok) {
      throw new Error(`Dropbox sign-in failed: HTTP ${response.status} ${await response.text()}`);
    }
    const token = (await response.json()) as TokenResponse;
    if (!token.refresh_token) throw new Error('Dropbox sign-in failed: no refresh token');
    return {
      refreshToken: token.refresh_token,
      accessToken: token.access_token,
      expiresAt: Date.now() + (token.expires_in ?? 14_400) * 1000,
    };
  }

  async folderBrowser(accountId: string): Promise<RemoteFolderBrowser> {
    return new DropboxFolderBrowser(await this.client(accountId));
  }

  async store(account: DriveAccount): Promise<RemoteDriveStore> {
    const folder = syncFolder(account);
    const cached = this.stores.get(account.id);
    if (cached && cached.folder === folder) return cached.store;
    const store = new DropboxDriveStore(await this.client(account.id), folder);
    this.stores.set(account.id, { folder, store });
    return store;
  }

  async signOut(accountId: string): Promise<void> {
    this.stores.delete(accountId);
    try {
      const client = await this.client(accountId);
      await client.rpc('auth/token/revoke');
    } catch {
      // The credentials are forgotten regardless.
    }
    const session = this.sessions.get(accountId);
    if (session) session.session.closed = true;
    this.sessions.delete(accountId);
    await this.deps.vault.delete(accountId);
  }

  private async client(accountId: string): Promise<DropboxClient> {
    const cached = this.sessions.get(accountId);
    if (cached) return cached.client;
    const stored = await this.deps.vault.get(accountId);
    if (!stored) throw new RemoteUnavailableError(SIGN_IN_AGAIN);
    let credential: DropboxCredential;
    try {
      credential = JSON.parse(stored) as DropboxCredential;
    } catch {
      throw new RemoteUnavailableError(SIGN_IN_AGAIN);
    }
    if (!credential.refreshToken) throw new RemoteUnavailableError(SIGN_IN_AGAIN);
    const session = new DropboxSession(
      accountId,
      credential,
      this.deps.appKey,
      this.deps.vault,
      this.fetchFn,
    );
    const client = new DropboxClient(session, this.fetchFn);
    this.sessions.set(accountId, { session, client });
    return client;
  }
}
