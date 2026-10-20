import { FakeRemoteDriveStore } from '../../shared/fakeRemote';
import * as P from '../../shared/paths';
import {
  syncFolder,
  type DriveAccount,
  type DriveProvider,
  type RemoteDriveStore,
  type RemoteEntry,
} from '../../shared/types';
import type { DriveConnector, RemoteFolderBrowser, SignedInAccount } from './types';

/** A remote store scoped to `prefix` inside a whole fake drive. */
class ScopedStore implements RemoteDriveStore {
  constructor(
    private readonly drive: FakeRemoteDriveStore,
    private readonly prefix: string,
  ) {}
  private abs = (path: string) => P.join(this.prefix, path);
  private rel = (e: RemoteEntry): RemoteEntry => ({
    ...e,
    path: e.path.substring(this.prefix ? this.prefix.length + 1 : 0),
  });
  async snapshot() {
    return (await this.drive.snapshot())
      .filter((e) => P.isAncestor(this.prefix, e.path) && e.path !== this.prefix)
      .map(this.rel)
      .filter((e) => !e.path.startsWith('.marknotes'));
  }
  download(entry: RemoteEntry) {
    return this.drive.download({ ...entry, path: this.abs(entry.path) });
  }
  async uploadNew(path: string, bytes: Uint8Array) {
    return this.rel(await this.drive.uploadNew(this.abs(path), bytes));
  }
  async uploadRevision(entry: RemoteEntry, bytes: Uint8Array) {
    return this.rel(await this.drive.uploadRevision({ ...entry, path: this.abs(entry.path) }, bytes));
  }
  async createFolder(path: string) {
    return this.rel(await this.drive.createFolder(this.abs(path)));
  }
  delete(entry: RemoteEntry) {
    return this.drive.delete({ ...entry, path: this.abs(entry.path) });
  }
  async readManifest() {
    const e = this.drive.nodes.get(this.abs('.marknotes/manifest.json'));
    return e ? e.bytes : null;
  }
  async writeManifest(bytes: Uint8Array) {
    const path = this.abs('.marknotes/manifest.json');
    const e = this.drive.nodes.get(path);
    if (e) e.bytes = bytes;
    else await this.drive.uploadNew(path, bytes);
  }
}

/** In-memory provider used only by end-to-end tests (MARKNOTES_E2E=1). */
export class FakeConnector implements DriveConnector {
  readonly drives = new Map<string, FakeRemoteDriveStore>();

  constructor(readonly provider: DriveProvider) {}

  unavailableReason() {
    return null;
  }

  drive(accountId: string): FakeRemoteDriveStore {
    let d = this.drives.get(accountId);
    if (!d) {
      d = new FakeRemoteDriveStore();
      void d.createFolder('Documents');
      this.drives.set(accountId, d);
    }
    return d;
  }

  async signIn(): Promise<SignedInAccount> {
    const id = `${this.provider}:test`;
    this.drive(id);
    return { id, provider: this.provider, label: 'test@example.com' };
  }

  async folderBrowser(accountId: string): Promise<RemoteFolderBrowser> {
    const d = this.drive(accountId);
    return {
      listFolders: async (path) =>
        (await d.snapshot())
          .filter((e) => e.isFolder && P.parent(e.path) === path && !e.path.startsWith('.'))
          .map((e) => ({ path: e.path, name: P.name(e.path) })),
    };
  }

  async store(account: DriveAccount): Promise<RemoteDriveStore> {
    const d = this.drive(account.id);
    const prefix = syncFolder(account);
    if (prefix) await d.createFolder(prefix);
    return new ScopedStore(d, prefix);
  }

  async signOut() {}
}
