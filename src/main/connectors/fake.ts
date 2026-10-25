import type { TestFault, TestFaultOp } from '../../preload/api';
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

/** A remote store scoped to `prefix` inside a whole fake drive; `check` throws the injected test faults. */
class ScopedStore implements RemoteDriveStore {
  readonly remoteFolderDeletion = 'unsupported';
  constructor(
    private readonly drive: FakeRemoteDriveStore,
    private readonly prefix: string,
    private readonly check: (op: TestFaultOp) => void = () => undefined,
  ) {}
  private abs = (path: string) => P.join(this.prefix, path);
  private rel = (e: RemoteEntry): RemoteEntry => ({
    ...e,
    path: e.path.substring(this.prefix ? this.prefix.length + 1 : 0),
  });
  async snapshot() {
    this.check('snapshot');
    return (await this.drive.snapshot())
      .filter((e) => P.isAncestor(this.prefix, e.path) && e.path !== this.prefix)
      .map(this.rel)
      .filter((e) => !e.path.startsWith('.marknotes'));
  }
  async download(entry: RemoteEntry) {
    this.check('download');
    return this.drive.download({ ...entry, path: this.abs(entry.path) });
  }
  async uploadNew(path: string, bytes: Uint8Array, modifiedMillis?: number) {
    this.check('uploadNew');
    return this.rel(await this.drive.uploadNew(this.abs(path), bytes, modifiedMillis));
  }
  async uploadRevision(entry: RemoteEntry, bytes: Uint8Array, modifiedMillis?: number) {
    this.check('uploadRevision');
    return this.rel(
      await this.drive.uploadRevision({ ...entry, path: this.abs(entry.path) }, bytes, modifiedMillis),
    );
  }
  async createFolder(path: string) {
    this.check('createFolder');
    return this.rel(await this.drive.createFolder(this.abs(path)));
  }
  async delete(entry: RemoteEntry) {
    this.check('delete');
    return this.drive.delete({ ...entry, path: this.abs(entry.path) });
  }
  async rename(entry: RemoteEntry, toPath: string) {
    this.check('rename');
    return this.drive.rename({ ...entry, path: this.abs(entry.path) }, this.abs(toPath));
  }
  async readManifest() {
    this.check('readManifest');
    const e = this.drive.nodes.get(this.abs('.marknotes/manifest.json'));
    return e ? e.bytes : null;
  }
  async writeManifest(bytes: Uint8Array) {
    this.check('writeManifest');
    const path = this.abs('.marknotes/manifest.json');
    const e = this.drive.nodes.get(path);
    if (e) e.bytes = bytes;
    else await this.drive.uploadNew(path, bytes);
  }
}

/** In-memory provider used only by end-to-end tests (MARKNOTES_E2E=1). */
export class FakeConnector implements DriveConnector {
  readonly drives = new Map<string, FakeRemoteDriveStore>();
  private readonly faults = new Map<string, TestFault>();
  private signIns = 0;

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

  /** Makes operations on a drive fail until `times` failures happened or it is cleared with null. */
  setFault(accountId: string, fault: TestFault | null): TestFault | null {
    if (fault) this.faults.set(accountId, { ...fault });
    else this.faults.delete(accountId);
    return this.faults.get(accountId) ?? null;
  }

  private checkFault(accountId: string, op: TestFaultOp) {
    const fault = this.faults.get(accountId);
    if (!fault || (fault.op && fault.op !== op)) return;
    if (fault.times !== undefined && --fault.times <= 0) this.faults.delete(accountId);
    // A status as set by the real connectors, so the failure is classified like theirs.
    throw fault.kind === 'retryable'
      ? Object.assign(new Error('The drive is temporarily unavailable'), { status: 503 })
      : Object.assign(new Error('The drive rejected the request'), { status: 403 });
  }

  /** Like the real connectors: Proton ids are per user, Dropbox/OneDrive ids are new per sign-in. */
  async signIn(): Promise<SignedInAccount> {
    const fresh = this.provider !== 'proton' && this.signIns++ > 0;
    return this.signedIn(`${this.provider}:test${fresh ? `-${crypto.randomUUID()}` : ''}`);
  }

  /** A staged Proton login (reconnect) is stored under a pending id, as in the real connector. */
  async login(_username: string, _password: string, staged = false) {
    const account = staged ? this.signedIn(`proton-pending-${crypto.randomUUID()}`) : await this.signIn();
    return { kind: 'signedIn' as const, account };
  }

  private signedIn(id: string): SignedInAccount {
    this.drive(id);
    return { id, provider: this.provider, label: 'test@example.com', providerAccountId: 'test' };
  }

  async replaceCredentials(account: DriveAccount, signedIn: SignedInAccount) {
    if (signedIn.providerAccountId !== account.providerAccountId) throw new Error('Account mismatch');
    this.drives.delete(signedIn.id);
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
    if (prefix && !d.exists(prefix)) await d.createFolder(prefix);
    return new ScopedStore(d, prefix, (op) => this.checkFault(account.id, op));
  }

  async signOut() {}
}
