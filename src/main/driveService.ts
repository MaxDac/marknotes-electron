import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AddDriveOptions, ProtonLogin, ProviderInfo, RemoteOp, SignedIn } from '../preload/api';
import * as P from '../shared/paths';
import {
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
  login(username: string, password: string): Promise<ProtonLogin>;
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

  async protonLogin(username: string, password: string): Promise<ProtonLogin> {
    const result = await this.proton().login(username, password);
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

  async addDrive(accountId: string, options: AddDriveOptions): Promise<DriveAccount> {
    const signedIn = this.pending.get(accountId);
    if (!signedIn) throw new Error('Sign in again to add this drive');
    const rootFolderName = options.rootFolderName.trim() || DEFAULT_ROOT_FOLDER;
    if (options.createRootFolder) P.validateName(rootFolderName);
    const account: DriveAccount = {
      id: signedIn.id,
      provider: signedIn.provider,
      label: signedIn.label,
      remoteFolder: P.normalize(options.remoteFolder),
      createRootFolder: options.createRootFolder,
      rootFolderName,
    };
    const state = await this.load();
    state.drives = [...state.drives.filter((d) => d.id !== account.id), account];
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

  /** Disconnects a drive. Nothing is deleted from the drive; local sync data is cleared by the renderer. */
  async removeDrive(driveId: string) {
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
      store.catch(() => this.stores.delete(driveId));
      this.stores.set(driveId, store);
    }
    return store;
  }

  async remote(driveId: string, request: RemoteOp): Promise<unknown> {
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
