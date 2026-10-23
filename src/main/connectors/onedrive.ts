import {
  InteractionRequiredAuthError,
  PublicClientApplication,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
  type ICachePlugin,
  type InteractiveRequest,
  type SilentFlowRequest,
} from '@azure/msal-node';
import { MANIFEST_PATH } from '../../shared/manifestPath';
import { isAncestor, join } from '../../shared/paths';
import {
  RemoteChangedError,
  RemoteUnavailableError,
  syncFolder,
  type DriveAccount,
  type RemoteDriveStore,
  type RemoteEntry,
  type RemoteFolder,
} from '../../shared/types';
import type {
  DriveConnector,
  FetchFn,
  OpenExternal,
  RemoteFolderBrowser,
  SecretVault,
  SignedInAccount,
} from './types';

export const GRAPH_URL = 'https://graph.microsoft.com/v1.0';
export const MSAL_AUTHORITY = 'https://login.microsoftonline.com/common';
export const ONEDRIVE_SCOPES = ['Files.ReadWrite', 'User.Read', 'offline_access'];

const HTTP_NOT_FOUND = 404;
const HTTP_CONFLICT = 409;
const HTTP_GONE = 410;
const HTTP_PRECONDITION_FAILED = 412;

type Json = Record<string, unknown>;

export class GraphError extends Error {
  override name = 'GraphError';
  constructor(
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
  }
}

const str = (obj: Json, key: string): string | null => {
  const value = obj[key];
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? `${value}`
      : null;
};

const obj = (o: Json, key: string): Json | null => {
  const value = o[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
};

const trimSlashes = (s: string) => s.replace(/^\/+|\/+$/g, '');

/** Minimal Microsoft Graph client for the signed-in user's OneDrive. */
export class GraphClient {
  constructor(
    private readonly fetchFn: FetchFn,
    private readonly accessToken: () => Promise<string>,
    readonly baseUrl: string = GRAPH_URL,
  ) {}

  /** Same encoding as Java's URLEncoder (spaces as %20), segment by segment. */
  static encodePath(path: string): string {
    return path
      .split('/')
      .filter((it) => it !== '')
      .map((it) =>
        encodeURIComponent(it).replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
      )
      .join('/');
  }

  /** URL of the item at `path` (relative to the drive root), followed by `suffix` (e.g. "/children"). */
  pathUrl(path: string, suffix = ''): string {
    const clean = trimSlashes(path);
    if (clean === '') return `${this.baseUrl}/me/drive/root${suffix}`;
    if (suffix === '') return `${this.baseUrl}/me/drive/root:/${GraphClient.encodePath(clean)}`;
    return `${this.baseUrl}/me/drive/root:/${GraphClient.encodePath(clean)}:${suffix}`;
  }

  /** URL of `relativePath` below the item `parentId`, followed by `suffix`. */
  childPathUrl(parentId: string, relativePath: string, suffix = ''): string {
    return `${this.baseUrl}/me/drive/items/${parentId}:/${GraphClient.encodePath(relativePath)}:${suffix}`;
  }

  itemUrl(id: string, suffix = ''): string {
    return `${this.baseUrl}/me/drive/items/${id}${suffix}`;
  }

  async getJson(url: string): Promise<Json> {
    return GraphClient.json(await this.send('GET', url));
  }

  async send(
    method: string,
    url: string,
    body?: { bytes: Uint8Array | string; contentType: string },
    headers: Record<string, string> = {},
  ): Promise<Uint8Array> {
    const token = await this.accessToken();
    const requestHeaders: Record<string, string> = { Authorization: `Bearer ${token}` };
    let requestBody: Uint8Array | string | undefined = body?.bytes;
    if (body) requestHeaders['Content-Type'] = body.contentType;
    else if (method === 'POST' || method === 'PUT') requestBody = new Uint8Array(0);
    Object.assign(requestHeaders, headers);
    const response = await this.fetchFn(url, {
      method,
      headers: requestHeaders,
      body: requestBody as BodyInit | undefined,
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!response.ok) {
      if (response.status === 401) {
        throw new RemoteUnavailableError('OneDrive session expired, please sign in again');
      }
      throw new GraphError(response.status, GraphClient.errorMessage(response.status, bytes));
    }
    return bytes;
  }

  async putContent(url: string, bytes: Uint8Array, headers: Record<string, string> = {}): Promise<Json> {
    return GraphClient.json(
      await this.send('PUT', url, { bytes, contentType: 'application/octet-stream' }, headers),
    );
  }

  async postJson(url: string, body: Json): Promise<Json> {
    return this.sendJson('POST', url, body);
  }

  async sendJson(method: string, url: string, body: Json): Promise<Json> {
    return GraphClient.json(
      await this.send(method, url, { bytes: JSON.stringify(body), contentType: 'application/json' }),
    );
  }

  /** Follows "@odata.nextLink" pages and returns every item of a collection. */
  async collection(url: string): Promise<Json[]> {
    const items: Json[] = [];
    let next: string | null = url;
    while (next !== null) {
      const page = await this.getJson(next);
      const value = page.value;
      if (Array.isArray(value)) items.push(...(value as Json[]));
      next = str(page, '@odata.nextLink');
    }
    return items;
  }

  private static json(bytes: Uint8Array): Json {
    return bytes.length === 0 ? {} : (JSON.parse(new TextDecoder().decode(bytes)) as Json);
  }

  private static errorMessage(code: number, bytes: Uint8Array): string {
    let detail: string | null;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Json | null;
      const error = parsed && typeof parsed === 'object' ? obj(parsed, 'error') : null;
      detail = error ? str(error, 'message') : null;
    } catch {
      detail = null;
    }
    return `OneDrive error ${code}` + (detail ? `: ${detail}` : '');
  }
}

/** Lists OneDrive folders for the folder picker. */
export class OneDriveFolderBrowser implements RemoteFolderBrowser {
  constructor(private readonly graph: GraphClient) {}

  async listFolders(path: string): Promise<RemoteFolder[]> {
    const items = await this.graph.collection(this.graph.pathUrl(path, '/children'));
    return items
      .filter((it) => obj(it, 'folder') !== null)
      .flatMap((item) => {
        const name = str(item, 'name');
        return name === null ? [] : [{ path: join(trimSlashes(path), name), name }];
      })
      .sort((a, b) => {
        const x = a.name.toLowerCase();
        const y = b.name.toLowerCase();
        return x < y ? -1 : x > y ? 1 : 0;
      });
  }
}

interface Cached {
  entry: RemoteEntry;
  eTag: string;
}

/**
 * RemoteDriveStore over Microsoft Graph, scoped to the sync folder (relative to the OneDrive root).
 *
 * The folder tree is traversed once; afterwards it is kept up to date with the drive's delta feed.
 * The content tag (cTag) is used as the file version; uploads of new revisions send the eTag in
 * If-Match so a concurrent remote change is never overwritten.
 */
export class OneDriveDriveStore implements RemoteDriveStore {
  private readonly folder: string;
  private rootId: string | null = null;
  private readonly byId = new Map<string, Cached>();
  private deltaLink: string | null = null;

  constructor(
    private readonly graph: GraphClient,
    syncFolder: string,
  ) {
    this.folder = trimSlashes(syncFolder);
  }

  async snapshot(): Promise<RemoteEntry[]> {
    const root = await this.ensureRoot();
    const link = this.deltaLink;
    if (link === null) {
      await this.fullTraversal(root);
    } else {
      try {
        await this.applyDelta(link);
      } catch (e) {
        // 410 Gone: the delta token expired, start over.
        if (!(e instanceof GraphError && e.httpStatus === HTTP_GONE)) {
          // The cache may be partly updated: traverse again next time.
          this.deltaLink = null;
          throw e;
        }
        await this.fullTraversal(root);
      }
    }
    return [...this.byId.values()].map((it) => it.entry);
  }

  download(entry: RemoteEntry): Promise<Uint8Array> {
    return this.graph.send('GET', this.graph.itemUrl(entry.id, '/content'));
  }

  async uploadNew(path: string, bytes: Uint8Array, modifiedMillis?: number): Promise<RemoteEntry> {
    const url =
      this.graph.childPathUrl(await this.ensureRoot(), path, '/content') +
      '?@microsoft.graph.conflictBehavior=fail';
    return this.remember(
      await this.withModified(await this.graph.putContent(url, bytes), modifiedMillis),
      path,
    );
  }

  async uploadRevision(entry: RemoteEntry, bytes: Uint8Array, modifiedMillis?: number): Promise<RemoteEntry> {
    const eTag = this.byId.get(entry.id)?.eTag;
    const headers: Record<string, string> = eTag ? { 'If-Match': eTag } : {};
    const item = await this.graph.putContent(this.graph.itemUrl(entry.id, '/content'), bytes, headers);
    return this.remember(await this.withModified(item, modifiedMillis), entry.path);
  }

  /** Stores the local edit time as `fileSystemInfo.lastModifiedDateTime`, which snapshots read back. */
  private async withModified(item: Json, modifiedMillis: number | undefined): Promise<Json> {
    const id = str(item, 'id');
    if (!modifiedMillis || id === null) return item;
    return this.graph.sendJson('PATCH', this.graph.itemUrl(id), {
      fileSystemInfo: { lastModifiedDateTime: new Date(modifiedMillis).toISOString() },
    });
  }

  async createFolder(path: string): Promise<RemoteEntry> {
    let parentId = await this.ensureRoot();
    let current = '';
    let result: RemoteEntry | null = null;
    for (const segment of path.split('/').filter((it) => it !== '')) {
      current = join(current, segment);
      const known = [...this.byId.values()].find(
        (it) => it.entry.isFolder && it.entry.path === current,
      )?.entry;
      const entry = known ?? (await this.createChildFolder(parentId, segment, current));
      parentId = entry.id;
      result = entry;
    }
    if (result === null) throw new Error('Cannot create the synced folder itself');
    return result;
  }

  /** Files are only deleted while their eTag is the snapshot's (If-Match); 412 means it changed meanwhile. */
  async delete(entry: RemoteEntry): Promise<void> {
    const eTag = entry.isFolder ? undefined : this.byId.get(entry.id)?.eTag;
    try {
      await this.graph.send(
        'DELETE',
        this.graph.itemUrl(entry.id),
        undefined,
        eTag ? { 'If-Match': eTag } : {},
      );
    } catch (e) {
      if (e instanceof GraphError && e.httpStatus === HTTP_PRECONDITION_FAILED) {
        throw new RemoteChangedError(entry.path);
      }
      if (!(e instanceof GraphError && e.httpStatus === HTTP_NOT_FOUND)) throw e;
    }
    this.removeTree(entry.id);
  }

  async readManifest(): Promise<Uint8Array | null> {
    try {
      return await this.graph.send(
        'GET',
        this.graph.childPathUrl(await this.ensureRoot(), MANIFEST_PATH, '/content'),
      );
    } catch (e) {
      if (e instanceof GraphError && e.httpStatus === HTTP_NOT_FOUND) return null;
      throw e;
    }
  }

  async writeManifest(bytes: Uint8Array): Promise<void> {
    await this.graph.putContent(
      this.graph.childPathUrl(await this.ensureRoot(), MANIFEST_PATH, '/content'),
      bytes,
    );
  }

  private newFolderBody(name: string): Json {
    return { name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' };
  }

  private async createChildFolder(parentId: string, name: string, path: string): Promise<RemoteEntry> {
    let item: Json;
    try {
      item = await this.graph.postJson(this.graph.itemUrl(parentId, '/children'), this.newFolderBody(name));
    } catch (e) {
      if (!(e instanceof GraphError && e.httpStatus === HTTP_CONFLICT)) throw e;
      item = await this.graph.getJson(this.graph.childPathUrl(await this.ensureRoot(), path));
    }
    return this.remember(item, path);
  }

  /** Returns the id of the synced folder, creating it (and its parents) when missing. */
  private async ensureRoot(): Promise<string> {
    if (this.rootId !== null) return this.rootId;
    let item: Json;
    try {
      item = await this.graph.getJson(this.graph.pathUrl(this.folder));
    } catch (e) {
      if (!(e instanceof GraphError && e.httpStatus === HTTP_NOT_FOUND) || this.folder === '') throw e;
      item = await this.createRootFolders();
    }
    const id = str(item, 'id');
    if (id === null) throw new Error('OneDrive returned a folder without id');
    this.rootId = id;
    return id;
  }

  private async createRootFolders(): Promise<Json> {
    let parentPath = '';
    let parent = await this.graph.getJson(this.graph.pathUrl(''));
    for (const segment of this.folder.split('/')) {
      const path = join(parentPath, segment);
      try {
        parent = await this.graph.getJson(this.graph.pathUrl(path));
      } catch (notFound) {
        if (!(notFound instanceof GraphError && notFound.httpStatus === HTTP_NOT_FOUND)) throw notFound;
        const parentId = str(parent, 'id');
        if (parentId === null) throw new Error('OneDrive returned a folder without id', { cause: notFound });
        parent = await this.graph.postJson(
          this.graph.itemUrl(parentId, '/children'),
          this.newFolderBody(segment),
        );
      }
      parentPath = path;
    }
    return parent;
  }

  /**
   * Lists the whole synced folder. The delta link is taken first (changes made during the traversal are replayed by
   * the next delta) but only kept once the traversal succeeded: a snapshot is complete or it fails.
   */
  private async fullTraversal(root: string) {
    this.byId.clear();
    this.deltaLink = null;
    try {
      const latest = await this.graph.getJson(this.graph.pathUrl('', '/delta') + '?token=latest');
      const link = str(latest, '@odata.deltaLink');
      await this.traverse(root, '');
      this.deltaLink = link;
    } catch (e) {
      this.byId.clear();
      throw e;
    }
  }

  private async traverse(folderId: string, path: string) {
    for (const item of await this.graph.collection(this.graph.itemUrl(folderId, '/children'))) {
      const name = str(item, 'name');
      if (name === null) continue;
      const childPath = join(path, name);
      const entry = this.remember(item, childPath);
      if (entry.isFolder) await this.traverse(entry.id, childPath);
    }
  }

  private async applyDelta(link: string) {
    let next: string | null = link;
    let deferred: Json[] = [];
    while (next !== null) {
      const page = await this.graph.getJson(next);
      if (Array.isArray(page.value)) {
        for (const item of page.value as Json[]) {
          if (!(await this.applyDeltaItem(item))) deferred.push(item);
        }
      }
      next = str(page, '@odata.nextLink');
      const delta = str(page, '@odata.deltaLink');
      if (delta !== null) this.deltaLink = delta;
    }
    // Items listed before their parent folder: retry until nothing more can be placed.
    let progress = true;
    while (deferred.length > 0 && progress) {
      const remaining: Json[] = [];
      for (const item of deferred) {
        if (!(await this.applyDeltaItem(item))) remaining.push(item);
      }
      progress = remaining.length < deferred.length;
      deferred = remaining;
    }
  }

  /** Applies one changed item. Returns false when its parent folder is not known (yet). */
  private async applyDeltaItem(item: Json): Promise<boolean> {
    const id = str(item, 'id');
    const name = str(item, 'name');
    if (id === null || id === this.rootId) return true;
    if (obj(item, 'deleted') !== null || obj(item, '@removed') !== null || name === null) {
      this.removeTree(id);
      return true;
    }
    const parentRef = obj(item, 'parentReference');
    const parentId = parentRef ? str(parentRef, 'id') : null;
    const parentCached = parentId !== null ? this.byId.get(parentId)?.entry : undefined;
    const parentEntry = parentCached?.isFolder ? parentCached : null;
    if (parentId !== this.rootId && parentEntry === null) {
      // Outside the synced folder, or moved out of it.
      if (!this.byId.has(id)) return false;
      this.removeTree(id);
      return true;
    }
    await this.placeItem(id, item, join(parentEntry?.path ?? '', name));
    return true;
  }

  private async placeItem(id: string, item: Json, path: string) {
    const existing = this.byId.get(id);
    if (existing && existing.entry.isFolder && existing.entry.path !== path) {
      this.renameTree(existing.entry.path, path);
    }
    const entry = this.remember(item, path);
    if (entry.isFolder && !existing) await this.traverse(entry.id, path);
  }

  private remember(item: Json, path: string): RemoteEntry {
    const id = str(item, 'id');
    if (id === null) throw new Error('OneDrive returned an item without id');
    const isFolder = obj(item, 'folder') !== null;
    const entry: RemoteEntry = {
      path,
      id,
      isFolder,
      version: isFolder ? '' : (str(item, 'cTag') ?? str(item, 'eTag') ?? ''),
      modifiedMillis: parseTime(
        str(obj(item, 'fileSystemInfo') ?? {}, 'lastModifiedDateTime') ?? str(item, 'lastModifiedDateTime'),
      ),
    };
    this.byId.set(id, { entry, eTag: str(item, 'eTag') ?? '' });
    return entry;
  }

  private removeTree(id: string) {
    const removed = this.byId.get(id);
    if (!removed) return;
    this.byId.delete(id);
    if (removed.entry.isFolder) {
      for (const [key, cached] of [...this.byId]) {
        if (isAncestor(removed.entry.path, cached.entry.path)) this.byId.delete(key);
      }
    }
  }

  private renameTree(oldPath: string, newPath: string) {
    for (const [id, cached] of [...this.byId]) {
      if (isAncestor(oldPath, cached.entry.path)) {
        const moved = newPath + cached.entry.path.substring(oldPath.length);
        this.byId.set(id, { entry: { ...cached.entry, path: moved }, eTag: cached.eTag });
      }
    }
  }
}

function parseTime(value: string | null): number {
  const time = value ? Date.parse(value) : NaN;
  return Number.isNaN(time) ? 0 : time;
}

/** The parts of MSAL's token cache used by the connector. */
export interface MsalTokenCache {
  serialize(): string;
  getAccountByHomeId(homeAccountId: string): Promise<AccountInfo | null>;
  removeAccount(account: AccountInfo): Promise<void>;
}

/** The parts of MSAL's PublicClientApplication used by the connector. */
export interface MsalApp {
  acquireTokenInteractive(request: InteractiveRequest): Promise<AuthenticationResult>;
  acquireTokenSilent(request: SilentFlowRequest): Promise<AuthenticationResult>;
  getTokenCache(): MsalTokenCache;
}

/** What is stored in the vault for a OneDrive account: the MSAL account and its own token cache. */
export interface OneDriveCredential {
  homeAccountId: string;
  /** Serialized MSAL token cache holding only this account. */
  cache: string;
}

export interface OneDriveConnectorDeps {
  clientId: string;
  vault: SecretVault;
  openExternal: OpenExternal;
  fetch?: FetchFn;
  /** Creates the MSAL application; tests inject a fake. */
  msalFactory?: (config: Configuration) => MsalApp;
}

/** Binds an MSAL application to the vault entry of one drive account (unset while signing in). */
interface Binding {
  accountId: string | null;
  homeAccountId: string;
}

const SUCCESS_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>MarkNotes</title></head>' +
  '<body style="font-family:system-ui;padding:2rem"><h2>MarkNotes</h2>' +
  '<p>Signed in. You can close this window and return to MarkNotes.</p></body></html>';
const ERROR_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>MarkNotes</title></head>' +
  '<body style="font-family:system-ui;padding:2rem"><h2>MarkNotes</h2>' +
  '<p>Sign-in was cancelled or failed. You can close this window.</p></body></html>';

const EXPIRED = 'OneDrive sign-in expired, remove and add the drive again';
const SIGN_IN_AGAIN = 'Sign in to OneDrive again';

/**
 * OneDrive (personal and work/school accounts) through Microsoft Graph. Tokens are managed by MSAL
 * Node; each drive account has its own MSAL application whose token cache is persisted in the vault
 * under the account id, so signing out of one drive never affects another.
 */
export class OneDriveConnector implements DriveConnector {
  readonly provider = 'onedrive' as const;

  private readonly fetchFn: FetchFn;
  private readonly apps = new Map<string, MsalApp>();
  private readonly stores = new Map<string, { folder: string; store: OneDriveDriveStore }>();

  constructor(private readonly deps: OneDriveConnectorDeps) {
    this.fetchFn = deps.fetch ?? ((...args) => fetch(...args));
  }

  unavailableReason(): string | null {
    return this.deps.clientId
      ? null
      : 'No Microsoft app registration in this build. See the README to set MSAL_CLIENT_ID.';
  }

  async signIn(signal?: AbortSignal): Promise<SignedInAccount | null> {
    const unavailable = this.unavailableReason();
    if (unavailable) throw new Error(unavailable);
    if (signal?.aborted) return null;
    const binding: Binding = { accountId: null, homeAccountId: '' };
    const app = this.createApp(binding);
    const interactive = app.acquireTokenInteractive({
      scopes: ONEDRIVE_SCOPES,
      openBrowser: this.deps.openExternal,
      successTemplate: SUCCESS_PAGE,
      errorTemplate: ERROR_PAGE,
      prompt: 'select_account',
    });
    let result: AuthenticationResult | null;
    try {
      result = await (signal ? raceAbort(interactive, signal) : interactive);
    } catch (e) {
      const code = (e as { errorCode?: string } | null)?.errorCode;
      if (code === 'access_denied' || code === 'user_cancelled') return null;
      throw e;
    }
    if (!result) return null;
    const account = result.account;
    if (!account) throw new Error('OneDrive sign-in returned no account');
    const id = `onedrive-${crypto.randomUUID()}`;
    binding.accountId = id;
    binding.homeAccountId = account.homeAccountId;
    await this.save(binding, app.getTokenCache().serialize());
    this.apps.set(id, app);
    return { id, provider: this.provider, label: account.username || account.name || 'OneDrive' };
  }

  async folderBrowser(accountId: string): Promise<RemoteFolderBrowser> {
    return new OneDriveFolderBrowser(await this.graph(accountId));
  }

  async store(account: DriveAccount): Promise<RemoteDriveStore> {
    const folder = syncFolder(account);
    const cached = this.stores.get(account.id);
    if (cached && cached.folder === folder) return cached.store;
    const store = new OneDriveDriveStore(await this.graph(account.id), folder);
    this.stores.set(account.id, { folder, store });
    return store;
  }

  async signOut(accountId: string): Promise<void> {
    this.stores.delete(accountId);
    const credential = await this.load(accountId);
    const app = this.apps.get(accountId);
    this.apps.delete(accountId);
    await this.deps.vault.delete(accountId);
    if (!credential || !app) return;
    try {
      const cache = app.getTokenCache();
      const account = await cache.getAccountByHomeId(credential.homeAccountId);
      if (account) await cache.removeAccount(account);
    } catch {
      // The account is forgotten locally regardless.
    }
  }

  private async graph(accountId: string): Promise<GraphClient> {
    if (!(await this.load(accountId))) throw new RemoteUnavailableError(SIGN_IN_AGAIN);
    return new GraphClient(this.fetchFn, () => this.accessToken(accountId));
  }

  private async accessToken(accountId: string): Promise<string> {
    const credential = await this.load(accountId);
    if (!credential) throw new RemoteUnavailableError(SIGN_IN_AGAIN);
    const app = this.appFor(accountId, credential.homeAccountId);
    const account = await app.getTokenCache().getAccountByHomeId(credential.homeAccountId);
    if (!account) throw new RemoteUnavailableError(SIGN_IN_AGAIN);
    try {
      return (await app.acquireTokenSilent({ account, scopes: ONEDRIVE_SCOPES })).accessToken;
    } catch (e) {
      if (e instanceof InteractionRequiredAuthError) throw new RemoteUnavailableError(EXPIRED);
      throw e;
    }
  }

  private appFor(accountId: string, homeAccountId: string): MsalApp {
    let app = this.apps.get(accountId);
    if (!app) {
      app = this.createApp({ accountId, homeAccountId });
      this.apps.set(accountId, app);
    }
    return app;
  }

  private createApp(binding: Binding): MsalApp {
    const cachePlugin: ICachePlugin = {
      beforeCacheAccess: async (context) => {
        if (binding.accountId === null) return;
        const credential = await this.load(binding.accountId);
        if (credential?.cache) context.tokenCache.deserialize(credential.cache);
      },
      afterCacheAccess: async (context) => {
        if (binding.accountId === null || !context.cacheHasChanged) return;
        // Don't resurrect the entry of an account that was signed out meanwhile.
        if (!(await this.deps.vault.get(binding.accountId))) return;
        await this.save(binding, context.tokenCache.serialize());
      },
    };
    const config: Configuration = {
      auth: { clientId: this.deps.clientId, authority: MSAL_AUTHORITY },
      cache: { cachePlugin },
    };
    return this.deps.msalFactory ? this.deps.msalFactory(config) : new PublicClientApplication(config);
  }

  private async save(binding: Binding, cache: string) {
    if (binding.accountId === null) return;
    const credential: OneDriveCredential = { homeAccountId: binding.homeAccountId, cache };
    await this.deps.vault.set(binding.accountId, JSON.stringify(credential));
  }

  private async load(accountId: string): Promise<OneDriveCredential | null> {
    const stored = await this.deps.vault.get(accountId);
    if (!stored) return null;
    try {
      const credential = JSON.parse(stored) as OneDriveCredential;
      return credential.homeAccountId ? credential : null;
    } catch {
      return null;
    }
  }
}

/** Resolves null when `signal` aborts first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  return new Promise<T | null>((resolve, reject) => {
    const onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
