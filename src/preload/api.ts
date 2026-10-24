import type { DriveAccount, DriveProvider, RemoteEntry, RemoteFolder } from '../shared/types';

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * `secure`: an OS keychain protects saved credentials. `weak`: Linux without a keyring, credentials are only kept
 * in memory until the app quits. `unavailable`: credentials cannot be saved.
 */
export type SecureStorageStatus = 'secure' | 'weak' | 'unavailable';

/**
 * How the key that encrypts the local notes is protected: `keychain` (OS keychain), `passphrase` (app lock) or
 * `none` (no keychain protects anything, e.g. Linux without a keyring: the app lock is recommended).
 */
export type LocalKeyProtection = 'keychain' | 'passphrase' | 'none';

export interface LockStatus {
  /** `error`: the key cannot be read (e.g. the keychain changed); only deleting the local data helps. */
  state: 'unlocked' | 'locked' | 'error';
  /** Whether the app lock (passphrase) is enabled. */
  enabled: boolean;
  protection: LocalKeyProtection;
  error: string | null;
}

export interface SignedIn {
  id: string;
  provider: DriveProvider;
  label: string;
}

export interface ProviderInfo {
  provider: DriveProvider;
  name: string;
  /** Why the provider can't be used in this build, or null. */
  unavailableReason: string | null;
  /** Whether the provider lets the user browse folders. */
  browsable: boolean;
}

export type ProtonLogin = { kind: 'signedIn'; account: SignedIn } | { kind: 'twoFactor'; pendingId: string };

export interface AddDriveOptions {
  remoteFolder: string;
  createRootFolder: boolean;
  rootFolderName: string;
}

export type RemoteOp =
  | { op: 'snapshot' }
  | { op: 'download'; entry: RemoteEntry }
  | { op: 'uploadNew'; path: string; bytes: Uint8Array; modifiedMillis?: number }
  | { op: 'uploadRevision'; entry: RemoteEntry; bytes: Uint8Array; modifiedMillis?: number }
  | { op: 'createFolder'; path: string }
  | { op: 'delete'; entry: RemoteEntry }
  | { op: 'readManifest' }
  | { op: 'writeManifest'; bytes: Uint8Array };

/** Auto-update state, pushed from the main process on every change. */
export type UpdateStatus =
  | { state: 'disabled'; reason: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'upToDate' }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string };

/** API exposed by the preload script as `window.marknotes`. */
export interface MarkNotesApi {
  platform: string;
  deviceId(): Promise<Result<string>>;
  /** How credentials are protected on this device (see `SecureStorageStatus`). */
  secureStorage(): Promise<Result<SecureStorageStatus>>;
  lockStatus(): Promise<Result<LockStatus>>;
  /** The key that encrypts the local notes; fails while locked. */
  localKey(): Promise<Result<Uint8Array>>;
  /** Wrong passphrases fail with a generic error after a short delay. */
  unlock(passphrase: string): Promise<Result<LockStatus>>;
  enableLock(passphrase: string): Promise<Result<LockStatus>>;
  disableLock(passphrase: string): Promise<Result<LockStatus>>;
  changePassphrase(oldPassphrase: string, newPassphrase: string): Promise<Result<LockStatus>>;
  /** Locks now (no-op without the app lock): the key is forgotten and the window reloads. */
  lockNow(): Promise<Result<boolean>>;
  /**
   * Replaces the local key, so the data encrypted with the old one is unreadable; returns the new key. While locked
   * this also removes the app lock (forgotten passphrase).
   */
  resetLocalKey(): Promise<Result<Uint8Array>>;
  /** Subscribes to the app being locked (before the window reloads); returns an unsubscribe function. */
  onLocked(listener: () => void): () => void;
  providers(): Promise<Result<ProviderInfo[]>>;
  drives(): Promise<Result<DriveAccount[]>>;
  signIn(provider: DriveProvider): Promise<Result<SignedIn | null>>;
  cancelSignIn(): Promise<Result<void>>;
  protonLogin(username: string, password: string): Promise<Result<ProtonLogin>>;
  protonTwoFactor(pendingId: string, code: string): Promise<Result<SignedIn>>;
  /** Abandons a Proton login waiting for its two-factor code. */
  protonCancel(pendingId: string): Promise<Result<void>>;
  listFolders(accountId: string, path: string): Promise<Result<RemoteFolder[]>>;
  addDrive(accountId: string, options: AddDriveOptions): Promise<Result<DriveAccount>>;
  discardSignIn(accountId: string): Promise<Result<void>>;
  removeDrive(driveId: string): Promise<Result<void>>;
  remote(driveId: string, op: RemoteOp): Promise<Result<unknown>>;
  openExternal(url: string): Promise<Result<void>>;
  updateStatus(): Promise<Result<UpdateStatus>>;
  /** Subscribes to update status changes; returns an unsubscribe function. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  /** Quits and installs a downloaded update. */
  installUpdate(): Promise<Result<void>>;
  /** Only available in end-to-end test builds (MARKNOTES_E2E=1). */
  testRemote?(
    driveId: string,
    action: 'put' | 'read' | 'list',
    path?: string,
    text?: string,
  ): Promise<Result<unknown>>;
}

declare global {
  interface Window {
    marknotes: MarkNotesApi;
  }
}
