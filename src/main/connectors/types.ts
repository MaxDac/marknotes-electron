import type { DriveAccount, DriveProvider, RemoteDriveStore, RemoteFolder } from '../../shared/types';

/** An account that has just signed in, before the user picked the folder to sync. */
export interface SignedInAccount {
  id: string;
  provider: DriveProvider;
  label: string;
}

/** Lists folders of a drive, used to pick the folder to sync. */
export interface RemoteFolderBrowser {
  /** Lists the sub-folders of `path` ("" = drive root). */
  listFolders(path: string): Promise<RemoteFolder[]>;
}

/** Persistent, encrypted storage for credentials, keyed by account id. */
export interface SecretVault {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Signs in to a cloud provider and creates RemoteDriveStores for its accounts. */
export interface DriveConnector {
  readonly provider: DriveProvider;
  /** Why the provider can't be used in this build, or null when it can. */
  unavailableReason(): string | null;
  /**
   * Starts an interactive sign-in (system browser) and resolves when it completes. Credentials are
   * stored in the vault under the returned account id. Resolves null when cancelled.
   */
  signIn(signal?: AbortSignal): Promise<SignedInAccount | null>;
  /** Browser for picking the folder to sync, or null when the provider has no folder listing. */
  folderBrowser(accountId: string): Promise<RemoteFolderBrowser | null>;
  /** Creates the store syncing syncFolder(account). Throws RemoteUnavailableError when signed out. */
  store(account: DriveAccount): Promise<RemoteDriveStore>;
  /** Forgets the credentials of `accountId`. */
  signOut(accountId: string): Promise<void>;
}

export type FetchFn = typeof fetch;

/** Opens a URL in the system browser. */
export type OpenExternal = (url: string) => Promise<void>;
