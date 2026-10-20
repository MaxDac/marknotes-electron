import {
  InteractionRequiredAuthError,
  type AccountInfo,
  type AuthenticationResult,
  type Configuration,
} from '@azure/msal-node';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  GraphClient,
  OneDriveConnector,
  OneDriveDriveStore,
  OneDriveFolderBrowser,
  type MsalApp,
  type MsalTokenCache,
} from '../src/main/connectors/onedrive';
import type { SecretVault } from '../src/main/connectors/types';
import { RemoteUnavailableError, type DriveAccount } from '../src/shared/types';

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

/** Fake Graph server: routes keyed by "METHOD /path?query", like MockWebServer in the Android test. */
class FakeGraph {
  routes = new Map<string, () => Response>();
  requests: Recorded[] = [];

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const body =
      raw === undefined || raw === null
        ? ''
        : typeof raw === 'string'
          ? raw
          : new TextDecoder().decode(raw as Uint8Array);
    const path = url.pathname + url.search;
    this.requests.push({
      method,
      path,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    const key = `${method} ${path}`;
    return (
      this.routes.get(key)?.() ??
      new Response(JSON.stringify({ error: { message: `not found: ${key}` } }), { status: 404 })
    );
  };

  route(key: string, body: string, code = 200) {
    this.routes.set(key, () => new Response(code === 204 ? null : body, { status: code }));
  }
}

const folder = (id: string, name: string, parent: string) =>
  `{"id":"${id}","name":"${name}","folder":{"childCount":0},"parentReference":{"id":"${parent}"},` +
  `"lastModifiedDateTime":"2024-01-01T00:00:00Z"}`;

const file = (id: string, name: string, parent: string, cTag: string) =>
  `{"id":"${id}","name":"${name}","file":{},"cTag":"${cTag}","eTag":"e-${cTag}",` +
  `"parentReference":{"id":"${parent}"},"lastModifiedDateTime":"2024-01-01T00:00:00Z"}`;

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: Uint8Array | null | undefined) => (b ? new TextDecoder().decode(b) : b);

/** Port of OneDriveDriveStoreTest.kt. */
describe('OneDriveDriveStore', () => {
  let server: FakeGraph;
  let store: OneDriveDriveStore;
  let base: string;

  beforeEach(() => {
    server = new FakeGraph();
    base = 'http://graph.test/v1.0';
    const graph = new GraphClient(server.fetch, async () => 'token', base);
    store = new OneDriveDriveStore(graph, 'Documents/MarkNotes');

    server.route('GET /v1.0/me/drive/root:/Documents/MarkNotes', folder('root', 'MarkNotes', 'x'));
    server.route(
      'GET /v1.0/me/drive/root/delta?token=latest',
      `{"value":[],"@odata.deltaLink":"${base}/delta1"}`,
    );
    server.route(
      'GET /v1.0/me/drive/items/root/children',
      `{"value":[${folder('f1', 'Work', 'root')},${file('n1', 'Todo.md', 'root', 'c1')}]}`,
    );
    server.route('GET /v1.0/me/drive/items/f1/children', `{"value":[${file('n2', 'Plan.md', 'f1', 'c2')}]}`);
  });

  it('full traversal builds relative paths', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    expect(new Set(entries.keys())).toEqual(new Set(['Work', 'Todo.md', 'Work/Plan.md']));
    expect(entries.get('Work/Plan.md')!.version).toBe('c2');
    expect(entries.get('Work/Plan.md')!.modifiedMillis).toBe(Date.parse('2024-01-01T00:00:00Z'));
    expect(entries.get('Work')!.isFolder).toBe(true);
    expect(server.requests[0].headers.authorization).toBe('Bearer token');
  });

  it('delta applies adds, renames and deletes', async () => {
    await store.snapshot();
    // Child listed before its renamed parent; a deleted note; an item outside the synced folder.
    server.route(
      'GET /v1.0/delta1',
      '{"value":[' +
        file('n3', 'New.md', 'f1', 'c3') +
        ',' +
        folder('f1', 'Projects', 'root') +
        ',' +
        '{"id":"n1","deleted":{},"parentReference":{"id":"root"}},' +
        file('other', 'Elsewhere.md', 'unrelated', 'c9') +
        `],"@odata.deltaLink":"${base}/delta2"}`,
    );
    const paths = new Set((await store.snapshot()).map((e) => e.path));
    expect(paths).toEqual(new Set(['Projects', 'Projects/Plan.md', 'Projects/New.md']));

    server.route('GET /v1.0/delta2', `{"value":[],"@odata.deltaLink":"${base}/delta3"}`);
    expect(new Set((await store.snapshot()).map((e) => e.path))).toEqual(paths);
  });

  it('expired delta token triggers full resync', async () => {
    await store.snapshot();
    server.route('GET /v1.0/delta1', '{"error":{"message":"resync"}}', 410);
    expect((await store.snapshot()).length).toBe(3);
  });

  it('uploads use conflict behavior and If-Match', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    // New files are addressed relative to the synced folder.
    server.route(
      'PUT /v1.0/me/drive/items/root:/Work/My%20Note.md:/content?@microsoft.graph.conflictBehavior=fail',
      file('n4', 'My Note.md', 'f1', 'c4'),
    );
    const created = await store.uploadNew('Work/My Note.md', bytes('hi'));
    expect(created.version).toBe('c4');
    expect(created.path).toBe('Work/My Note.md');

    server.route('PUT /v1.0/me/drive/items/n2/content', file('n2', 'Plan.md', 'f1', 'c5'));
    const updated = await store.uploadRevision(entries.get('Work/Plan.md')!, bytes('new'));
    expect(updated.version).toBe('c5');
    const put = server.requests.at(-1)!;
    expect(put.headers['if-match']).toBe('e-c2');
    expect(put.body).toBe('new');
  });

  it('manifest is missing until written', async () => {
    expect(await store.readManifest()).toBeNull();
    server.route(
      'PUT /v1.0/me/drive/items/root:/.marknotes/manifest.json:/content',
      file('m', 'manifest.json', 'x', 'c'),
    );
    await store.writeManifest(bytes('{}'));
    server.route('GET /v1.0/me/drive/items/root:/.marknotes/manifest.json:/content', '{}');
    expect(text(await store.readManifest())).toBe('{}');
  });

  it('missing sync folder is created', async () => {
    server.routes.delete('GET /v1.0/me/drive/root:/Documents/MarkNotes');
    server.route('GET /v1.0/me/drive/root', folder('top', 'root', ''));
    server.route('GET /v1.0/me/drive/root:/Documents', folder('docs', 'Documents', 'top'));
    server.route('POST /v1.0/me/drive/items/docs/children', folder('root', 'MarkNotes', 'docs'), 201);
    expect((await store.snapshot()).length).toBe(3);
    const posts = server.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toContain('"name":"MarkNotes"');
  });

  it('creates nested folders, reusing known ones and resolving conflicts', async () => {
    await store.snapshot();
    server.route('POST /v1.0/me/drive/items/f1/children', '{"error":{"message":"exists"}}', 409);
    server.route('GET /v1.0/me/drive/items/root:/Work/Ideas:', folder('f2', 'Ideas', 'f1'));
    const ideas = await store.createFolder('Work/Ideas');
    expect(ideas).toMatchObject({ path: 'Work/Ideas', id: 'f2', isFolder: true, version: '' });
    expect(server.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    await expect(store.createFolder('')).rejects.toThrow(/synced folder itself/);
  });

  it('delete ignores missing items and forgets the subtree', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    server.route('DELETE /v1.0/me/drive/items/f1', '', 204);
    await store.delete(entries.get('Work')!);
    server.route('GET /v1.0/delta1', `{"value":[],"@odata.deltaLink":"${base}/delta2"}`);
    expect((await store.snapshot()).map((e) => e.path)).toEqual(['Todo.md']);
    // 404: already gone.
    await store.delete(entries.get('Todo.md')!);
    server.route('DELETE /v1.0/me/drive/items/n1', '{"error":{"message":"locked"}}', 423);
    await expect(store.delete(entries.get('Todo.md')!)).rejects.toThrow('OneDrive error 423: locked');
  });

  it('downloads content by item id', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    server.route('GET /v1.0/me/drive/items/n2/content', '# Plan');
    expect(text(await store.download(entries.get('Work/Plan.md')!))).toBe('# Plan');
  });

  it('401 is reported as RemoteUnavailableError', async () => {
    server.route('GET /v1.0/me/drive/root:/Documents/MarkNotes', '{}', 401);
    await expect(store.snapshot()).rejects.toBeInstanceOf(RemoteUnavailableError);
  });
});

describe('OneDriveFolderBrowser', () => {
  it('lists sub-folders across pages, sorted by name', async () => {
    const server = new FakeGraph();
    const base = 'http://graph.test/v1.0';
    server.route(
      'GET /v1.0/me/drive/root:/My%20Docs:/children',
      `{"value":[${folder('a', 'zeta', 'p')},${file('b', 'x.md', 'p', 'c')}],"@odata.nextLink":"${base}/page2"}`,
    );
    server.route('GET /v1.0/page2', `{"value":[${folder('c', 'Alpha', 'p')}]}`);
    server.route('GET /v1.0/me/drive/root/children', `{"value":[${folder('d', 'My Docs', 'r')}]}`);
    const browser = new OneDriveFolderBrowser(new GraphClient(server.fetch, async () => 't', base));
    expect(await browser.listFolders('/My Docs/')).toEqual([
      { path: 'My Docs/Alpha', name: 'Alpha' },
      { path: 'My Docs/zeta', name: 'zeta' },
    ]);
    expect(await browser.listFolders('')).toEqual([{ path: 'My Docs', name: 'My Docs' }]);
  });
});

class MemoryVault implements SecretVault {
  items = new Map<string, string>();
  async get(key: string) {
    return this.items.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.items.set(key, value);
  }
  async delete(key: string) {
    this.items.delete(key);
  }
}

const msAccount = (homeAccountId: string, username: string) =>
  ({
    homeAccountId,
    username,
    environment: 'login.windows.net',
    tenantId: 't',
    localAccountId: 'l',
  }) as AccountInfo;

/** Fake MSAL application whose token cache round-trips through the configured cache plugin. */
class FakeMsal implements MsalApp {
  accounts = new Map<string, AccountInfo>();
  interactive: ((openBrowser: (url: string) => Promise<void>) => Promise<AuthenticationResult>) | null = null;
  silentError: Error | null = null;
  silentRequests: { account: AccountInfo; scopes: string[] }[] = [];
  interactiveRequests: Record<string, unknown>[] = [];

  constructor(readonly config: Configuration) {}

  private async access<T>(change: boolean, fn: () => Promise<T>): Promise<T> {
    const plugin = this.config.cache!.cachePlugin!;
    const context = {
      cacheHasChanged: change,
      tokenCache: {
        serialize: () => this.serialize(),
        deserialize: (cache: string) => {
          this.accounts = new Map((JSON.parse(cache) as AccountInfo[]).map((a) => [a.homeAccountId, a]));
        },
      },
    } as unknown as Parameters<typeof plugin.beforeCacheAccess>[0];
    await plugin.beforeCacheAccess(context);
    const result = await fn();
    await plugin.afterCacheAccess(context);
    return result;
  }

  private serialize() {
    return JSON.stringify([...this.accounts.values()]);
  }

  async acquireTokenInteractive(request: Parameters<MsalApp['acquireTokenInteractive']>[0]) {
    this.interactiveRequests.push(request as unknown as Record<string, unknown>);
    return this.access(true, async () => {
      const result = await this.interactive!(request.openBrowser);
      if (result.account) this.accounts.set(result.account.homeAccountId, result.account);
      return result;
    });
  }

  async acquireTokenSilent(request: Parameters<MsalApp['acquireTokenSilent']>[0]) {
    this.silentRequests.push(request);
    return this.access(true, async () => {
      if (this.silentError) throw this.silentError;
      if (!this.accounts.has(request.account.homeAccountId))
        throw new InteractionRequiredAuthError('no_tokens_found', 'No tokens');
      return { accessToken: `at-${request.account.homeAccountId}` } as AuthenticationResult;
    });
  }

  getTokenCache(): MsalTokenCache {
    return {
      serialize: () => this.serialize(),
      getAccountByHomeId: (id) => this.access(false, async () => this.accounts.get(id) ?? null),
      removeAccount: (account) =>
        this.access(true, async () => void this.accounts.delete(account.homeAccountId)),
    };
  }
}

describe('OneDriveConnector', () => {
  let vault: MemoryVault;
  let server: FakeGraph;
  let apps: FakeMsal[];
  let opened: string[];

  const connector = (setup?: (app: FakeMsal) => void) =>
    new OneDriveConnector({
      clientId: 'client-id',
      vault,
      fetch: server.fetch,
      openExternal: async (url) => void opened.push(url),
      msalFactory: (config) => {
        const app = new FakeMsal(config);
        setup?.(app);
        apps.push(app);
        return app;
      },
    });

  const account = (id: string): DriveAccount => ({
    id,
    provider: 'onedrive',
    label: 'me',
    remoteFolder: '',
    createRootFolder: true,
    rootFolderName: 'MarkNotes',
  });

  const signedIn = (app: FakeMsal) => {
    app.interactive = async (openBrowser) => {
      await openBrowser('https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1');
      return { account: msAccount('h1', 'me@outlook.com'), accessToken: 'at' } as AuthenticationResult;
    };
  };

  beforeEach(() => {
    vault = new MemoryVault();
    server = new FakeGraph();
    apps = [];
    opened = [];
  });

  it('is unavailable without a client id', () => {
    const c = new OneDriveConnector({ clientId: '', vault, openExternal: async () => {} });
    expect(c.unavailableReason()).toMatch(/No Microsoft app registration in this build/);
    expect(connector().unavailableReason()).toBeNull();
  });

  it('signs in interactively and stores the account with its token cache', async () => {
    const result = await connector(signedIn).signIn();
    expect(result).toMatchObject({ provider: 'onedrive', label: 'me@outlook.com' });
    expect(result!.id).toMatch(/^onedrive-/);
    expect(opened).toEqual(['https://login.microsoftonline.com/common/oauth2/v2.0/authorize?x=1']);

    const app = apps[0];
    expect(app.config.auth).toMatchObject({
      clientId: 'client-id',
      authority: 'https://login.microsoftonline.com/common',
    });
    expect(app.interactiveRequests[0].scopes).toEqual(['Files.ReadWrite', 'User.Read', 'offline_access']);
    expect(app.interactiveRequests[0].redirectUri).toBeUndefined();
    expect(app.interactiveRequests[0].successTemplate).toContain('MarkNotes');

    const stored = JSON.parse(vault.items.get(result!.id)!) as { homeAccountId: string; cache: string };
    expect(stored.homeAccountId).toBe('h1');
    expect(JSON.parse(stored.cache)).toEqual([msAccount('h1', 'me@outlook.com')]);
  });

  it('restores the token cache from the vault to call Graph', async () => {
    const { id } = (await connector(signedIn).signIn())!;
    // A new connector, as after restarting the app.
    const restarted = connector();
    server.route('GET /v1.0/me/drive/root:/MarkNotes', folder('root', 'MarkNotes', 'x'));
    server.route('GET /v1.0/me/drive/root/delta?token=latest', '{"value":[]}');
    server.route('GET /v1.0/me/drive/items/root/children', `{"value":[${file('n1', 'A.md', 'root', 'c1')}]}`);
    const store = await restarted.store(account(id));
    expect(await restarted.store(account(id))).toBe(store);
    expect((await store.snapshot()).map((e) => e.path)).toEqual(['A.md']);
    expect(server.requests[0].headers.authorization).toBe('Bearer at-h1');
    const app = apps.at(-1)!;
    expect(app.silentRequests[0].account.homeAccountId).toBe('h1');
    expect(app.silentRequests[0].scopes).toEqual(['Files.ReadWrite', 'User.Read', 'offline_access']);
    expect(server.requests.every((r) => r.path.startsWith('/v1.0/'))).toBe(true);
  });

  it('lists folders of the drive', async () => {
    const c = connector(signedIn);
    const { id } = (await c.signIn())!;
    server.route('GET /v1.0/me/drive/root/children', `{"value":[${folder('d', 'Docs', 'r')}]}`);
    const browser = await c.folderBrowser(id);
    expect(await browser.listFolders('')).toEqual([{ path: 'Docs', name: 'Docs' }]);
  });

  it('reports expired sign-ins and unknown accounts as RemoteUnavailableError', async () => {
    const c = connector(signedIn);
    const { id } = (await c.signIn())!;
    apps[0].silentError = new InteractionRequiredAuthError('invalid_grant', 'Expired');
    const store = await c.store(account(id));
    await expect(store.snapshot()).rejects.toThrow(RemoteUnavailableError);
    await expect(store.snapshot()).rejects.toThrow(/expired/);

    await expect(c.store(account('onedrive-unknown'))).rejects.toBeInstanceOf(RemoteUnavailableError);
    await expect(c.folderBrowser('onedrive-unknown')).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('resolves null when the user cancels', async () => {
    const denied = connector((app) => {
      app.interactive = async () => {
        throw Object.assign(new Error('denied'), { errorCode: 'access_denied' });
      };
    });
    expect(await denied.signIn()).toBeNull();

    const controller = new AbortController();
    const pending = connector((app) => {
      app.interactive = () => new Promise(() => controller.abort());
    });
    expect(await pending.signIn(controller.signal)).toBeNull();
    expect(vault.items.size).toBe(0);

    const failing = connector((app) => {
      app.interactive = async () => {
        throw new Error('network down');
      };
    });
    await expect(failing.signIn()).rejects.toThrow('network down');
  });

  it('signOut removes the account from the cache and the vault', async () => {
    const c = connector(signedIn);
    const { id } = (await c.signIn())!;
    await c.signOut(id);
    expect(vault.items.has(id)).toBe(false);
    expect(apps[0].accounts.size).toBe(0);
    await expect(c.store(account(id))).rejects.toBeInstanceOf(RemoteUnavailableError);
    // Signing out an unknown account is a no-op.
    await c.signOut('onedrive-unknown');
  });
});
