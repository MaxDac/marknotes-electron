import { beforeEach, describe, expect, it } from 'vitest';
import {
  DropboxClient,
  DropboxConnector,
  DropboxDriveStore,
  DropboxFolderBrowser,
  type DropboxTokens,
} from '../src/main/connectors/dropbox';
import type { SecretVault } from '../src/main/connectors/types';
import { RemoteChangedError, RemoteUnavailableError, type DriveAccount } from '../src/shared/types';

interface Recorded {
  url: string;
  endpoint: string;
  headers: Record<string, string>;
  arg: unknown;
  body: string;
}

type Handler = (req: Recorded) => Response | Promise<Response>;

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const routeError = (error: unknown, summary = 'error/..') => json({ error_summary: summary, error }, 409);

/** Fake Dropbox HTTP API: routes by endpoint ("files/list_folder", "oauth2/token", ...). */
class FakeDropbox {
  routes = new Map<string, Handler>();
  requests: Recorded[] = [];

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const raw = init?.body;
    const body =
      raw === undefined || raw === null
        ? ''
        : typeof raw === 'string'
          ? raw
          : new TextDecoder().decode(raw as Uint8Array);
    const endpoint = url.pathname.replace(/^\/(2\/)?/, '');
    let arg: unknown = undefined;
    if (headers['dropbox-api-arg']) arg = JSON.parse(headers['dropbox-api-arg']);
    else if (headers['content-type'] === 'application/json') arg = JSON.parse(body);
    const req: Recorded = { url: url.toString(), endpoint, headers, arg, body };
    this.requests.push(req);
    const handler = this.routes.get(endpoint);
    if (!handler) return new Response(`no route for ${endpoint}`, { status: 400 });
    return handler(req);
  };

  on(endpoint: string, handler: Handler) {
    this.routes.set(endpoint, handler);
  }

  calls(endpoint: string) {
    return this.requests.filter((r) => r.endpoint === endpoint);
  }
}

const file = (pathDisplay: string, rev: string, id = `id:${pathDisplay}`) => ({
  '.tag': 'file',
  name: pathDisplay.substring(pathDisplay.lastIndexOf('/') + 1),
  id,
  path_lower: pathDisplay.toLowerCase(),
  path_display: pathDisplay,
  rev,
  server_modified: '2024-01-01T00:00:00Z',
});
const folder = (pathDisplay: string, id = `id:${pathDisplay}`) => ({
  '.tag': 'folder',
  name: pathDisplay.substring(pathDisplay.lastIndexOf('/') + 1),
  id,
  path_lower: pathDisplay.toLowerCase(),
  path_display: pathDisplay,
});
const deleted = (pathDisplay: string) => ({
  '.tag': 'deleted',
  name: pathDisplay.substring(pathDisplay.lastIndexOf('/') + 1),
  path_lower: pathDisplay.toLowerCase(),
  path_display: pathDisplay,
});
const untagged = (m: Record<string, unknown>) => {
  const { ['.tag']: _tag, ...rest } = m;
  return rest;
};

const staticTokens = (): DropboxTokens & { refreshed: number } => {
  const tokens = {
    refreshed: 0,
    token: 'a1',
    accessToken: async () => tokens.token,
    refresh: async () => {
      tokens.refreshed++;
      tokens.token = `a${tokens.refreshed + 1}`;
      return tokens.token;
    },
  };
  return tokens;
};

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

const text = (bytes: Uint8Array | null) => (bytes === null ? null : new TextDecoder().decode(bytes));
const bytes = (s: string) => new TextEncoder().encode(s);

describe('DropboxDriveStore', () => {
  let api: FakeDropbox;
  let store: DropboxDriveStore;

  beforeEach(() => {
    api = new FakeDropbox();
    store = new DropboxDriveStore(new DropboxClient(staticTokens(), api.fetch), 'Documents/MarkNotes');
    api.on('files/list_folder', () =>
      json({
        entries: [
          folder('/Documents/MarkNotes'),
          folder('/Documents/MarkNotes/Work'),
          file('/Documents/MarkNotes/Todo.md', 'r1'),
          file('/Documents/MarkNotes/Work/Plan.md', 'r2'),
        ],
        cursor: 'c1',
        has_more: true,
      }),
    );
    api.on('files/list_folder/continue', (req) => {
      const { cursor } = req.arg as { cursor: string };
      if (cursor === 'c1') {
        return json({
          entries: [
            folder('/Documents/MarkNotes/.marknotes'),
            file('/Documents/MarkNotes/.marknotes/manifest.json', 'rm'),
            file('/Documents/MarkNotes/.hidden.md', 'rh'),
            file('/Documents/Other.md', 'ro'),
          ],
          cursor: 'c2',
          has_more: false,
        });
      }
      return json({ entries: [], cursor, has_more: false });
    });
  });

  it('lists the sync folder recursively, following the cursor and skipping dot paths', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    expect([...entries.keys()].sort()).toEqual(['Todo.md', 'Work', 'Work/Plan.md']);
    expect(entries.get('Work/Plan.md')).toEqual({
      path: 'Work/Plan.md',
      id: 'id:/Documents/MarkNotes/Work/Plan.md',
      isFolder: false,
      version: 'r2',
      modifiedMillis: Date.parse('2024-01-01T00:00:00Z'),
    });
    expect(entries.get('Work')?.isFolder).toBe(true);
    expect(api.calls('files/list_folder')[0].arg).toEqual({ path: '/Documents/MarkNotes', recursive: true });
    expect(api.calls('files/list_folder/continue').map((r) => r.arg)).toEqual([{ cursor: 'c1' }]);
    expect(api.requests[0].headers.authorization).toBe('Bearer a1');
  });

  it('applies changes from the saved cursor, keeping the display case of paths', async () => {
    await store.snapshot();
    api.on('files/list_folder/continue', (req) => {
      expect(req.arg).toEqual({ cursor: 'c2' });
      return json({
        entries: [
          deleted('/Documents/MarkNotes/Work'),
          file('/DOCUMENTS/marknotes/New Note.md', 'r3'),
          folder('/Documents/MarkNotes/Ideas'),
        ],
        cursor: 'c3',
        has_more: false,
      });
    });
    const entries = await store.snapshot();
    expect(entries.map((e) => e.path).sort()).toEqual(['Ideas', 'New Note.md', 'Todo.md']);
    expect(api.calls('files/list_folder')).toHaveLength(1);

    api.on('files/list_folder/continue', (req) => {
      expect(req.arg).toEqual({ cursor: 'c3' });
      return json({ entries: [], cursor: 'c4', has_more: false });
    });
    expect((await store.snapshot()).length).toBe(3);
  });

  it('starts over with a full listing when the cursor is reset', async () => {
    await store.snapshot();
    api.on('files/list_folder/continue', (req) => {
      const { cursor } = req.arg as { cursor: string };
      if (cursor === 'c2') return routeError({ '.tag': 'reset' }, 'reset/');
      return json({ entries: [], cursor: 'c9', has_more: false });
    });
    const entries = await store.snapshot();
    expect(entries.map((e) => e.path).sort()).toEqual(['Todo.md', 'Work', 'Work/Plan.md']);
    expect(api.calls('files/list_folder')).toHaveLength(2);
  });

  it('creates the sync folder when it is missing', async () => {
    let created = false;
    api.on('files/list_folder', () =>
      created
        ? json({ entries: [folder('/Documents/MarkNotes')], cursor: 'x', has_more: false })
        : routeError({ '.tag': 'path', path: { '.tag': 'not_found' } }),
    );
    api.on('files/create_folder_v2', (req) => {
      created = true;
      expect(req.arg).toEqual({ path: '/Documents/MarkNotes', autorename: false });
      return json({ metadata: untagged(folder('/Documents/MarkNotes')) });
    });
    expect(await store.snapshot()).toEqual([]);
    expect(created).toBe(true);
  });

  it('uploads new files with mode add and revisions with mode update', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    api.on('files/upload', (req) => {
      const arg = req.arg as { path: string };
      return json(untagged(file(arg.path, arg.path.endsWith('Plan.md') ? 'r5' : 'r4')));
    });

    const created = await store.uploadNew('Work/Città.md', bytes('hi'));
    expect(created.path).toBe('Work/Città.md');
    expect(created.version).toBe('r4');
    expect(created.isFolder).toBe(false);
    let upload = api.calls('files/upload').at(-1)!;
    expect(upload.arg).toEqual({
      path: '/Documents/MarkNotes/Work/Città.md',
      mode: 'add',
      autorename: false,
      strict_conflict: true,
    });
    // The argument header must be ASCII.
    expect(upload.headers['dropbox-api-arg']).toContain('Citt\\u00e0.md');
    expect(upload.headers['content-type']).toBe('application/octet-stream');
    expect(upload.body).toBe('hi');
    expect(upload.url).toBe('https://content.dropboxapi.com/2/files/upload');

    const updated = await store.uploadRevision(entries.get('Work/Plan.md')!, bytes('new'));
    expect(updated.version).toBe('r5');
    upload = api.calls('files/upload').at(-1)!;
    expect(upload.arg).toEqual({
      path: '/Documents/MarkNotes/Work/Plan.md',
      mode: { '.tag': 'update', update: 'r2' },
      autorename: false,
    });
    expect(upload.body).toBe('new');

    const paths = (await store.snapshot()).map((e) => e.path).sort();
    expect(paths).toEqual(['Todo.md', 'Work', 'Work/Città.md', 'Work/Plan.md']);
  });

  it('downloads by id', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    api.on('files/download', () => new Response('content'));
    expect(text(await store.download(entries.get('Todo.md')!))).toBe('content');
    expect(api.calls('files/download')[0].arg).toEqual({ path: 'id:/Documents/MarkNotes/Todo.md' });
  });

  it('creates folders without adopting an occupied target', async () => {
    api.on('files/create_folder_v2', (req) =>
      json({ metadata: untagged(folder((req.arg as { path: string }).path, 'id:new')) }),
    );
    const created = await store.createFolder('Ideas');
    expect(created).toEqual({ path: 'Ideas', id: 'id:new', isFolder: true, version: '', modifiedMillis: 0 });

    api.on('files/create_folder_v2', () =>
      routeError({ '.tag': 'path', path: { '.tag': 'conflict', conflict: { '.tag': 'folder' } } }),
    );
    api.on('files/get_metadata', () => json(folder('/Documents/MarkNotes/Work', 'id:work')));
    await expect(store.createFolder('Work')).rejects.toThrow(/Dropbox error 409/);
    expect(api.calls('files/get_metadata')).toHaveLength(0);
  });

  it('refuses recursive folder deletion and retains the cached subtree', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    await expect(store.delete(entries.get('Work')!)).rejects.toThrow(/atomic empty-only/);
    expect(api.calls('files/delete_v2')).toHaveLength(0);
    expect((await store.snapshot()).map((e) => e.path).sort()).toEqual(['Todo.md', 'Work', 'Work/Plan.md']);
  });

  it('deletes files and ignores entries already gone', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    api.on('files/delete_v2', (req) => json({ metadata: { path: (req.arg as { path: string }).path } }));
    await store.delete(entries.get('Work/Plan.md')!);
    expect(api.calls('files/delete_v2')[0].arg).toEqual({
      path: '/Documents/MarkNotes/Work/Plan.md',
      parent_rev: 'r2',
    });

    api.on('files/delete_v2', () =>
      routeError({ '.tag': 'path_lookup', path_lookup: { '.tag': 'not_found' } }),
    );
    api.on('files/get_metadata', () => routeError({ '.tag': 'path', path: { '.tag': 'not_found' } }));
    await store.delete(entries.get('Todo.md')!);

    api.on('files/delete_v2', () => routeError({ '.tag': 'path_write', path_write: { '.tag': 'no_write' } }));
    await expect(store.delete(entries.get('Todo.md')!)).rejects.toThrow(/Dropbox error 409/);
  });

  it('deletes files only at the synced revision', async () => {
    const entries = new Map((await store.snapshot()).map((e) => [e.path, e]));
    const todo = entries.get('Todo.md')!;
    api.on('files/delete_v2', (req) => json({ metadata: { path: (req.arg as { path: string }).path } }));
    await store.delete(todo);
    expect(api.calls('files/delete_v2')[0].arg).toEqual({
      path: '/Documents/MarkNotes/Todo.md',
      parent_rev: todo.version,
    });

    // A newer revision on the drive: the delete is refused and reported as a change.
    api.on('files/delete_v2', () =>
      routeError({ '.tag': 'path_lookup', path_lookup: { '.tag': 'not_found' } }),
    );
    api.on('files/get_metadata', () => json(file('/Documents/MarkNotes/Todo.md', 'newer')));
    await expect(store.delete(todo)).rejects.toBeInstanceOf(RemoteChangedError);
  });

  it('writes and reads the local modification time as client_modified', async () => {
    api.on('files/upload', (req) =>
      json(
        untagged({
          ...file((req.arg as { path: string }).path, 'r9'),
          client_modified: (req.arg as { client_modified: string }).client_modified,
        }),
      ),
    );
    const created = await store.uploadNew('Work/New.md', bytes('x'), Date.parse('2023-05-06T07:08:09.123Z'));
    expect(api.calls('files/upload').at(-1)!.arg).toMatchObject({ client_modified: '2023-05-06T07:08:09Z' });
    expect(created.modifiedMillis).toBe(Date.parse('2023-05-06T07:08:09Z'));
  });

  it('reads null until the manifest is written, then round-trips it', async () => {
    let manifest: string | null = null;
    api.on('files/download', () =>
      manifest === null
        ? routeError({ '.tag': 'path', path: { '.tag': 'not_found' } })
        : new Response(manifest),
    );
    api.on('files/upload', (req) => {
      manifest = req.body;
      return json(untagged(file('/Documents/MarkNotes/.marknotes/manifest.json', 'm1')));
    });
    expect(await store.readManifest()).toBeNull();
    await store.writeManifest(bytes('{"format":1}'));
    expect(api.calls('files/upload')[0].arg).toEqual({
      path: '/Documents/MarkNotes/.marknotes/manifest.json',
      mode: 'overwrite',
      mute: true,
    });
    expect(text(await store.readManifest())).toBe('{"format":1}');
    expect(api.calls('files/download').at(-1)!.arg).toEqual({
      path: '/Documents/MarkNotes/.marknotes/manifest.json',
    });
  });

  it('refreshes the access token once on 401', async () => {
    const tokens = staticTokens();
    store = new DropboxDriveStore(new DropboxClient(tokens, api.fetch), 'Documents/MarkNotes');
    const original = api.routes.get('files/list_folder')!;
    api.on('files/list_folder', (req) =>
      req.headers.authorization === 'Bearer a1'
        ? json({ error_summary: 'expired_access_token/' }, 401)
        : original(req),
    );
    expect((await store.snapshot()).length).toBe(3);
    expect(tokens.refreshed).toBe(1);
    expect(api.calls('files/list_folder').map((r) => r.headers.authorization)).toEqual([
      'Bearer a1',
      'Bearer a2',
    ]);

    api.on('files/list_folder/continue', () => json({ error_summary: 'invalid_access_token/' }, 401));
    await expect(store.snapshot()).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('works on the drive root', async () => {
    store = new DropboxDriveStore(new DropboxClient(staticTokens(), api.fetch), '');
    api.on('files/list_folder', () =>
      json({ entries: [file('/Top.md', 'r1'), folder('/Sub')], cursor: 'r', has_more: false }),
    );
    expect((await store.snapshot()).map((e) => e.path).sort()).toEqual(['Sub', 'Top.md']);
    expect(api.calls('files/list_folder')[0].arg).toEqual({ path: '', recursive: true });
    api.on('files/upload', (req) => json(untagged(file((req.arg as { path: string }).path, 'r2'))));
    expect((await store.uploadNew('Sub/A.md', bytes('a'))).path).toBe('Sub/A.md');
    expect((api.calls('files/upload')[0].arg as { path: string }).path).toBe('/Sub/A.md');
  });
});

describe('DropboxFolderBrowser', () => {
  it('lists sub-folders sorted by name', async () => {
    const api = new FakeDropbox();
    api.on('files/list_folder', () =>
      json({ entries: [folder('/Docs/zeta'), file('/Docs/a.md', 'r')], cursor: 'k', has_more: true }),
    );
    api.on('files/list_folder/continue', () =>
      json({ entries: [folder('/Docs/Alpha')], cursor: 'k2', has_more: false }),
    );
    const browser = new DropboxFolderBrowser(new DropboxClient(staticTokens(), api.fetch));
    expect(await browser.listFolders('/Docs/')).toEqual([
      { path: 'Docs/Alpha', name: 'Alpha' },
      { path: 'Docs/zeta', name: 'zeta' },
    ]);
    expect(api.calls('files/list_folder')[0].arg).toEqual({ path: '/Docs' });
  });
});

describe('DropboxConnector', () => {
  const account = (id: string): DriveAccount => ({
    id,
    provider: 'dropbox',
    label: 'me',
    remoteFolder: 'Apps',
    createRootFolder: true,
    rootFolderName: 'MarkNotes',
  });

  it('is unavailable without an app key', () => {
    const connector = new DropboxConnector({
      appKey: '',
      vault: new MemoryVault(),
      openExternal: async () => {},
    });
    expect(connector.unavailableReason()).toMatch(/No Dropbox app key in this build/);
    expect(
      new DropboxConnector({
        appKey: 'k',
        vault: new MemoryVault(),
        openExternal: async () => {},
      }).unavailableReason(),
    ).toBeNull();
  });

  it('signs in with PKCE through the loopback redirect and stores the refresh token', async () => {
    const api = new FakeDropbox();
    const vault = new MemoryVault();
    let authorizeUrl: URL | undefined;
    api.on('oauth2/token', () =>
      json({
        access_token: 'at',
        expires_in: 14400,
        refresh_token: 'rt',
        token_type: 'bearer',
        account_id: 'dbid:1',
      }),
    );
    api.on('users/get_current_account', () =>
      json({ email: 'me@example.com', name: { display_name: 'Me' } }),
    );
    const connector = new DropboxConnector({
      appKey: 'app-key',
      vault,
      fetch: api.fetch,
      openExternal: async (url) => {
        authorizeUrl = new URL(url);
        const p = authorizeUrl.searchParams;
        const redirect = new URL(p.get('redirect_uri')!);
        redirect.search = new URLSearchParams({ code: 'the-code', state: p.get('state')! }).toString();
        const page = await fetch(redirect);
        expect(page.status).toBe(200);
      },
    });

    const signedIn = await connector.signIn();
    expect(signedIn).toMatchObject({ provider: 'dropbox', label: 'me@example.com' });
    expect(signedIn!.id).toMatch(/^dropbox-/);

    expect(`${authorizeUrl!.origin}${authorizeUrl!.pathname}`).toBe(
      'https://www.dropbox.com/oauth2/authorize',
    );
    const p = authorizeUrl!.searchParams;
    expect(p.get('client_id')).toBe('app-key');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('token_access_type')).toBe('offline');
    expect(p.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/dropbox$/);
    expect(p.get('scope')).toBe(
      'account_info.read files.metadata.read files.content.read files.content.write',
    );
    expect(p.get('state')).toBeTruthy();

    const exchange = new URLSearchParams(api.calls('oauth2/token')[0].body);
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('the-code');
    expect(exchange.get('client_id')).toBe('app-key');
    expect(exchange.get('redirect_uri')).toBe(p.get('redirect_uri'));
    const verifier = exchange.get('code_verifier')!;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    expect(Buffer.from(digest).toString('base64url')).toBe(p.get('code_challenge'));

    expect(api.calls('users/get_current_account')[0].headers.authorization).toBe('Bearer at');
    expect(JSON.parse(vault.items.get(signedIn!.id)!)).toMatchObject({
      refreshToken: 'rt',
      accessToken: 'at',
    });
  });

  it('falls back to the display name when there is no email', async () => {
    const api = new FakeDropbox();
    api.on('oauth2/token', () => json({ access_token: 'at', expires_in: 14400, refresh_token: 'rt' }));
    api.on('users/get_current_account', () => json({ email: '', name: { display_name: 'Me' } }));
    const connector = new DropboxConnector({
      appKey: 'k',
      vault: new MemoryVault(),
      fetch: api.fetch,
      openExternal: async (url) => {
        const p = new URL(url).searchParams;
        await fetch(`${p.get('redirect_uri')}?code=c&state=${encodeURIComponent(p.get('state')!)}`);
      },
    });
    expect((await connector.signIn())?.label).toBe('Me');
  });

  it('resolves null when the user denies access or cancels', async () => {
    const api = new FakeDropbox();
    const vault = new MemoryVault();
    const denied = new DropboxConnector({
      appKey: 'k',
      vault,
      fetch: api.fetch,
      openExternal: async (url) => {
        const p = new URL(url).searchParams;
        await fetch(
          `${p.get('redirect_uri')}?error=access_denied&state=${encodeURIComponent(p.get('state')!)}`,
        );
      },
    });
    expect(await denied.signIn()).toBeNull();

    const controller = new AbortController();
    const cancelled = new DropboxConnector({
      appKey: 'k',
      vault,
      fetch: api.fetch,
      openExternal: async () => controller.abort(),
    });
    expect(await cancelled.signIn(controller.signal)).toBeNull();
    expect(api.requests).toHaveLength(0);
    expect(vault.items.size).toBe(0);
  });

  it('rejects a redirect with the wrong state', async () => {
    const api = new FakeDropbox();
    const connector = new DropboxConnector({
      appKey: 'k',
      vault: new MemoryVault(),
      fetch: api.fetch,
      openExternal: async (url) => {
        const p = new URL(url).searchParams;
        await fetch(`${p.get('redirect_uri')}?code=c&state=forged`);
      },
    });
    await expect(connector.signIn()).rejects.toThrow(/state/);
    expect(api.requests).toHaveLength(0);
  });

  it('refreshes expired access tokens with the stored refresh token', async () => {
    const api = new FakeDropbox();
    const vault = new MemoryVault();
    await vault.set('dropbox-1', JSON.stringify({ refreshToken: 'rt', accessToken: 'old', expiresAt: 0 }));
    api.on('oauth2/token', () => json({ access_token: 'fresh', expires_in: 14400 }));
    api.on('files/list_folder', () => json({ entries: [], cursor: 'c', has_more: false }));
    const connector = new DropboxConnector({
      appKey: 'k',
      vault,
      fetch: api.fetch,
      openExternal: async () => {},
    });
    const store = await connector.store(account('dropbox-1'));
    expect(await connector.store(account('dropbox-1'))).toBe(store);
    await store.snapshot();

    const refresh = new URLSearchParams(api.calls('oauth2/token')[0].body);
    expect(Object.fromEntries(refresh)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt',
      client_id: 'k',
    });
    expect(api.calls('files/list_folder')[0].headers.authorization).toBe('Bearer fresh');
    expect(api.calls('files/list_folder')[0].arg).toEqual({ path: '/Apps/MarkNotes', recursive: true });
    expect(JSON.parse(vault.items.get('dropbox-1')!)).toMatchObject({
      refreshToken: 'rt',
      accessToken: 'fresh',
    });
  });

  it('reports a revoked refresh token as RemoteUnavailableError', async () => {
    const api = new FakeDropbox();
    const vault = new MemoryVault();
    await vault.set('dropbox-1', JSON.stringify({ refreshToken: 'rt', accessToken: '', expiresAt: 0 }));
    api.on('oauth2/token', () => json({ error: 'invalid_grant' }, 400));
    const connector = new DropboxConnector({
      appKey: 'k',
      vault,
      fetch: api.fetch,
      openExternal: async () => {},
    });
    const store = await connector.store(account('dropbox-1'));
    await expect(store.snapshot()).rejects.toBeInstanceOf(RemoteUnavailableError);
  });

  it('throws RemoteUnavailableError when signed out, and signOut revokes and forgets', async () => {
    const api = new FakeDropbox();
    const vault = new MemoryVault();
    const connector = new DropboxConnector({
      appKey: 'k',
      vault,
      fetch: api.fetch,
      openExternal: async () => {},
    });
    await expect(connector.store(account('dropbox-x'))).rejects.toBeInstanceOf(RemoteUnavailableError);
    await expect(connector.folderBrowser('dropbox-x')).rejects.toBeInstanceOf(RemoteUnavailableError);

    await vault.set(
      'dropbox-1',
      JSON.stringify({ refreshToken: 'rt', accessToken: 'at', expiresAt: Date.now() + 3600_000 }),
    );
    api.on('auth/token/revoke', () => json(null));
    await connector.signOut('dropbox-1');
    expect(api.calls('auth/token/revoke')[0].headers.authorization).toBe('Bearer at');
    expect(vault.items.has('dropbox-1')).toBe(false);

    // Revocation failures don't prevent signing out.
    await vault.set(
      'dropbox-2',
      JSON.stringify({ refreshToken: 'rt', accessToken: 'at', expiresAt: Date.now() + 3600_000 }),
    );
    api.on('auth/token/revoke', () => new Response('boom', { status: 500 }));
    await connector.signOut('dropbox-2');
    expect(vault.items.has('dropbox-2')).toBe(false);
  });
});
