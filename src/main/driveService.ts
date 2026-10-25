import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AddDriveOptions, ProtonLogin, ProviderInfo, RemoteOp, SignedIn } from '../preload/api';
import * as P from '../shared/paths';
import {
  alreadyConnectedMessage,
  DEFAULT_ROOT_FOLDER,
  PROVIDER_NAMES,
  type DriveAccount,
  type DriveProvider,
  type RemoteDriveStore,
  type RemoteFolder,
} from '../shared/types';
import type { DriveConnector, SignedInAccount } from './connectors/types';

/** Proton-specific login steps, implemented by the Proton connector. */
export interface ProtonLoginConnector extends DriveConnector {
  login(username: string, password: string, staged?: boolean): Promise<ProtonLogin>;
  submitTwoFactor(pendingId: string, code: string): Promise<SignedInAccount>;
  cancelLogin(pendingId: string): Promise<void>;
}

interface StateFile {
  deviceId: string;
  drives: DriveAccount[];
}

/**
 * Owns connected drives (non-secret settings in a JSON file), sign-in flows and the remote stores the
 * renderer's sync engine talks to over IPC.
 */
export class DriveService {
  private state: StateFile | null = null;
  private stores = new Map<string, Promise<RemoteDriveStore>>();
  /** Accounts that signed in but were not saved as drives yet. */
  private pending = new Map<string, SignedInAccount>();
  private signInAbort: AbortController | null = null;
  private operations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly file: string,
    readonly connectors: Record<DriveProvider, DriveConnector>,
  ) {}

  private async load(): Promise<StateFile> {
    if (this.state) return this.state;
    let loaded: Partial<StateFile> = {};
    if (existsSync(this.file)) {
      try {
        loaded = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StateFile>;
      } catch {
        loaded = {};
      }
    }
    this.state = { deviceId: loaded.deviceId || randomUUID(), drives: loaded.drives ?? [] };
    if (!loaded.deviceId) await this.save();
    return this.state;
  }

  private async save() {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await writeFile(tmp, JSON.stringify(this.state, null, 2));
    await rename(tmp, this.file);
  }

  async deviceId() {
    return (await this.load()).deviceId;
  }

  async providers(): Promise<ProviderInfo[]> {
    const result: ProviderInfo[] = [];
    for (const provider of ['proton', 'dropbox', 'onedrive'] as DriveProvider[]) {
      result.push({
        provider,
        name: PROVIDER_NAMES[provider],
        unavailableReason: this.connectors[provider].unavailableReason(),
        browsable: provider !== 'proton',
      });
    }
    return result;
  }

  async drives(): Promise<DriveAccount[]> {
    return [...(await this.load()).drives];
  }

  private connector(provider: DriveProvider) {
    const c = this.connectors[provider];
    const reason = c.unavailableReason();
    if (reason) throw new Error(reason);
    return c;
  }

  private remember(account: SignedInAccount): SignedIn {
    this.pending.set(account.id, account);
    return { id: account.id, provider: account.provider, label: account.label };
  }

  async signIn(provider: DriveProvider): Promise<SignedIn | null> {
    this.signInAbort?.abort();
    const abort = new AbortController();
    this.signInAbort = abort;
    try {
      const account = await this.connector(provider).signIn(abort.signal);
      if (account && abort.signal.aborted) {
        await this.connectors[provider].signOut(account.id);
        return null;
      }
      return account ? this.remember(account) : null;
    } catch (e) {
      if (abort.signal.aborted) return null;
      throw e;
    } finally {
      if (this.signInAbort === abort) this.signInAbort = null;
    }
  }

  cancelSignIn() {
    this.signInAbort?.abort();
    this.signInAbort = null;
  }

  private proton() {
    return this.connector('proton') as ProtonLoginConnector;
  }

  async protonLogin(username: string, password: string, staged = false): Promise<ProtonLogin> {
    const result = await this.proton().login(username, password, staged);
    return result.kind === 'signedIn' ? { kind: 'signedIn', account: this.remember(result.account) } : result;
  }

  async protonTwoFactor(pendingId: string, code: string): Promise<SignedIn> {
    return this.remember(await this.proton().submitTwoFactor(pendingId, code));
  }

  /** Abandons a Proton login waiting for its two-factor code. */
  async protonCancel(pendingId: string) {
    await this.proton().cancelLogin(pendingId);
  }

  private accountFor(accountId: string): { provider: DriveProvider } {
    const pending = this.pending.get(accountId);
    if (pending) return pending;
    const drive = this.state?.drives.find((d) => d.id === accountId);
    if (drive) return drive;
    throw new Error('This account is no longer signed in');
  }

  async listFolders(accountId: string, path: string): Promise<RemoteFolder[]> {
    const browser = await this.connector(this.accountFor(accountId).provider).folderBrowser(accountId);
    if (!browser) return [];
    return (await browser.listFolders(path)).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Saves a signed-in account as a new drive. An account that is already connected (Proton ids are per user)
   * is refused: the renderer keeps that drive's sync records under its id, so replacing its folder would make
   * every synced note look deleted on the drive and delete it locally and on the other drives.
   */
  async addDrive(accountId: string, options: AddDriveOptions): Promise<DriveAccount> {
    const signedIn = this.pending.get(accountId);
    if (!signedIn) throw new Error('Sign in again to add this drive');
    const state = await this.load();
    if (state.drives.some((d) => d.id === signedIn.id)) {
      this.pending.delete(accountId);
      throw new Error(alreadyConnectedMessage(signedIn.label));
    }
    const rootFolderName = options.rootFolderName.trim() || DEFAULT_ROOT_FOLDER;
    if (options.createRootFolder) P.validateName(rootFolderName);
    const account: DriveAccount = {
      id: signedIn.id,
      provider: signedIn.provider,
      label: signedIn.label,
      ...(signedIn.providerAccountId ? { providerAccountId: signedIn.providerAccountId } : {}),
      remoteFolder: P.normalize(options.remoteFolder),
      createRootFolder: options.createRootFolder,
      rootFolderName,
    };
    state.drives = [...state.drives, account];
    this.stores.delete(account.id);
    await this.save();
    this.pending.delete(accountId);
    return account;
  }

  /** Forgets an account that signed in but was never saved as a drive (the user cancelled). */
  async discardSignIn(accountId: string) {
    const signedIn = this.pending.get(accountId);
    this.pending.delete(accountId);
    const state = await this.load();
    if (signedIn && !state.drives.some((d) => d.id === accountId)) {
      await this.connectors[signedIn.provider].signOut(accountId).catch(() => undefined);
    }
  }

  private serial<T>(driveId: string, operation: () => Promise<T>): Promise<T> {
    const run = (this.operations.get(driveId) ?? Promise.resolve()).then(operation, operation);
    this.operations.set(driveId, run);
    void run
      .finally(() => {
        if (this.operations.get(driveId) === run) this.operations.delete(driveId);
      })
      .catch(() => undefined);
    return run;
  }

  /** Replaces credentials only: the drive configuration and every renderer sync key stay unchanged. */
  reconnect(driveId: string, accountId: string): Promise<DriveAccount> {
    return this.serial(driveId, async () => {
      const state = await this.load();
      const drive = state.drives.find((d) => d.id === driveId);
      const staged = this.pending.get(accountId);
      if (!drive) throw new Error('This drive is no longer connected');
      if (!staged || state.drives.some((d) => d.id === accountId) || staged.provider !== drive.provider) {
        throw new Error('Sign in again to reconnect this drive');
      }
      const connector = this.connector(drive.provider);
      if (!connector.replaceCredentials) throw new Error('This provider does not support reconnect');
      await connector.replaceCredentials(drive, staged);
      this.pending.delete(accountId);
      this.stores.delete(driveId);
      if (drive.providerAccountId || !staged.providerAccountId) return { ...drive };
      // Drives added before the provider identity was recorded keep it from now on.
      const pinned: DriveAccount = { ...drive, providerAccountId: staged.providerAccountId };
      state.drives = state.drives.map((d) => (d.id === driveId ? pinned : d));
      await this.save();
      return { ...pinned };
    });
  }

  /** Disconnects a drive. Nothing is deleted from the drive; local sync data is cleared by the renderer. */
  removeDrive(driveId: string) {
    return this.serial(driveId, () => this.removeDriveNow(driveId));
  }

  private async removeDriveNow(driveId: string) {
    const state = await this.load();
    const drive = state.drives.find((d) => d.id === driveId);
    if (!drive) return;
    await this.connectors[drive.provider].signOut(driveId).catch(() => undefined);
    state.drives = state.drives.filter((d) => d.id !== driveId);
    this.stores.delete(driveId);
    await this.save();
  }

  async store(driveId: string): Promise<RemoteDriveStore> {
    let store = this.stores.get(driveId);
    if (!store) {
      const drive = (await this.load()).drives.find((d) => d.id === driveId);
      if (!drive) throw new Error('This drive is no longer connected');
      store = this.connector(drive.provider).store(drive);
      const creating = store;
      store.catch(() => {
        if (this.stores.get(driveId) === creating) this.stores.delete(driveId);
      });
      this.stores.set(driveId, store);
    }
    return store;
  }

  remote(driveId: string, request: RemoteOp): Promise<unknown> {
    return this.serial(driveId, () => this.remoteNow(driveId, request));
  }

  private async remoteNow(driveId: string, request: RemoteOp): Promise<unknown> {
    const store = await this.store(driveId);
    switch (request.op) {
      case 'snapshot':
        return store.snapshot();
      case 'download':
        return store.download(request.entry);
      case 'uploadNew':
        return store.uploadNew(request.path, request.bytes, request.modifiedMillis);
      case 'uploadRevision':
        return store.uploadRevision(request.entry, request.bytes, request.modifiedMillis);
      case 'createFolder':
        return store.createFolder(request.path);
      case 'delete':
        return store.delete(request.entry);
      case 'rename':
        return store.rename(request.entry, request.toPath);
      case 'readManifest':
        return store.readManifest();
      case 'writeManifest':
        return store.writeManifest(request.bytes);
    }
  }
}
