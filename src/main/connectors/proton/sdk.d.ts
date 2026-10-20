// Hand-written subset of the @protontech/drive-sdk (v0.22) public API used by MarkNotes. See sdk.js.
import type * as openpgp from 'openpgp';

export type PrivateKey = openpgp.PrivateKey;
export type PublicKey = openpgp.PublicKey | openpgp.PrivateKey;

export interface SessionKey {
  data: Uint8Array<ArrayBuffer>;
  algorithm: string | null;
  aeadAlgorithm?: string | null;
}

/** 0 = not signed, 1 = signed and valid, 2 = signed and invalid. */
export type VERIFICATION_STATUS = 0 | 1 | 2;

type Bytes = Uint8Array<ArrayBuffer>;
type VerifyResult = { verified: VERIFICATION_STATUS; verificationErrors?: Error[] };

export interface OpenPGPCrypto {
  generatePassphrase: () => string;
  generateSessionKey: (
    encryptionKeys: PublicKey[],
    options: { enableAeadWithEncryptionKeys: boolean },
  ) => Promise<SessionKey>;
  encryptSessionKey: (
    sessionKey: SessionKey,
    encryptionKeys: PublicKey | PublicKey[],
  ) => Promise<{ keyPacket: Bytes }>;
  encryptSessionKeyWithPassword: (sessionKey: SessionKey, password: string) => Promise<{ keyPacket: Bytes }>;
  generateKey: (
    passphrase: string,
    options: { enableAead: boolean },
  ) => Promise<{ privateKey: PrivateKey; armoredKey: string }>;
  encryptArmored: (
    data: Bytes,
    encryptionKeys: PublicKey[],
    sessionKey: SessionKey | undefined,
    options: { enableAeadWithEncryptionKeys: boolean },
  ) => Promise<{ armoredData: string }>;
  encryptAndSign: (
    data: Bytes,
    sessionKey: SessionKey,
    encryptionKeys: PublicKey[],
    signingKey: PrivateKey,
    options: { enableAeadWithEncryptionKeys: boolean },
  ) => Promise<{ encryptedData: Bytes }>;
  encryptAndSignArmored: (
    data: Bytes,
    sessionKey: SessionKey | undefined,
    encryptionKeys: PublicKey[],
    signingKey: PrivateKey,
    options: { compress?: boolean; enableAeadWithEncryptionKeys: boolean },
  ) => Promise<{ armoredData: string }>;
  encryptAndSignDetached: (
    data: Bytes,
    sessionKey: SessionKey,
    encryptionKeys: PublicKey[],
    signingKey: PrivateKey,
    options: { enableAeadWithEncryptionKeys: boolean },
  ) => Promise<{ encryptedData: Bytes; signature: Bytes }>;
  encryptAndSignDetachedArmored: (
    data: Bytes,
    sessionKey: SessionKey,
    encryptionKeys: PublicKey[],
    signingKey: PrivateKey,
    options: { enableAeadWithEncryptionKeys: boolean },
  ) => Promise<{ armoredData: string; armoredSignature: string }>;
  sign: (data: Bytes, signingKey: PrivateKey, signatureContext: string) => Promise<{ signature: Bytes }>;
  signArmored: (data: Bytes, signingKey: PrivateKey | PrivateKey[]) => Promise<{ signature: string }>;
  verify: (
    data: Bytes,
    signature: Bytes,
    verificationKeys: PublicKey | PublicKey[],
    signatureContext?: string,
  ) => Promise<VerifyResult>;
  verifyArmored: (
    data: Bytes,
    armoredSignature: string,
    verificationKeys: PublicKey | PublicKey[],
    signatureContext?: string,
  ) => Promise<VerifyResult>;
  decryptSessionKey: (data: Bytes, decryptionKeys: PrivateKey | PrivateKey[]) => Promise<SessionKey>;
  decryptArmoredSessionKey: (
    armoredData: string,
    decryptionKeys: PrivateKey | PrivateKey[],
  ) => Promise<SessionKey>;
  decryptKey: (armoredKey: string, passphrase: string) => Promise<PrivateKey>;
  decryptAndVerify(
    data: Bytes,
    sessionKey: SessionKey,
    verificationKeys: PublicKey | PublicKey[],
  ): Promise<{ data: Bytes } & VerifyResult>;
  decryptAndVerifyDetached(
    data: Bytes,
    signature: Bytes | undefined,
    sessionKey: SessionKey,
    verificationKeys?: PublicKey | PublicKey[],
  ): Promise<{ data: Bytes } & VerifyResult>;
  decryptArmored(armoredData: string, decryptionKeys: PrivateKey | PrivateKey[]): Promise<Bytes>;
  decryptArmoredAndVerify: (
    armoredData: string,
    decryptionKeys: PrivateKey | PrivateKey[],
    verificationKeys: PublicKey | PublicKey[],
  ) => Promise<{ data: Bytes } & VerifyResult>;
  decryptArmoredAndVerifyDetached: (
    armoredData: string,
    armoredSignature: string | undefined,
    sessionKey: SessionKey,
    verificationKeys: PublicKey | PublicKey[],
  ) => Promise<{ data: Bytes } & VerifyResult>;
  decryptArmoredWithPassword(armoredData: string, password: string): Promise<Bytes>;
}

export interface SRPVerifier {
  modulusId: string;
  version: number;
  salt: string;
  verifier: string;
}

export interface SRPModule {
  getSrp: (
    version: number,
    modulus: string,
    serverEphemeral: string,
    salt: string,
    password: string,
  ) => Promise<{ expectedServerProof: string; clientProof: string; clientEphemeral: string }>;
  getSrpVerifier: (password: string) => Promise<SRPVerifier>;
  computeKeyPassword: (password: string, salt: string) => Promise<string>;
  generateKeySalt: () => string;
}

export interface ProtonDriveAccountAddress {
  email: string;
  addressId: string;
  primaryKeyIndex: number;
  keys: { id: string; key: PrivateKey }[];
}

export interface ProtonDriveAccount {
  getOwnPrimaryAddress(): Promise<ProtonDriveAccountAddress>;
  getOwnAddresses(): Promise<ProtonDriveAccountAddress[]>;
  getOwnAddress(emailOrAddressId: string): Promise<ProtonDriveAccountAddress>;
  hasProtonAccount(email: string): Promise<boolean>;
  getPublicKeys(email: string, forceRefresh?: boolean): Promise<PublicKey[]>;
}

type BaseRequest = { url: string; method: string; headers: Headers; timeoutMs: number; signal?: AbortSignal };
export type ProtonDriveHTTPClientJsonRequest = BaseRequest & { json?: object; body?: XMLHttpRequestBodyInit };
export type ProtonDriveHTTPClientBlobRequest = BaseRequest & {
  body?: XMLHttpRequestBodyInit;
  onProgress?: (progress: number) => void;
};

export interface ProtonDriveHTTPClient {
  fetchJson(request: ProtonDriveHTTPClientJsonRequest): Promise<Response>;
  fetchBlob(request: ProtonDriveHTTPClientBlobRequest): Promise<Response>;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export declare enum NodeType {
  File = 'file',
  Folder = 'folder',
  Album = 'album',
}

export interface Revision {
  uid: string;
  creationTime: Date;
  claimedSize?: number;
  claimedModificationTime?: Date;
}

export interface NodeEntity {
  uid: string;
  parentUid?: string;
  name: Result<string, Error>;
  type: NodeType | string;
  mediaType?: string;
  creationTime: Date;
  modificationTime: Date;
  trashTime?: Date;
  activeRevision?: Revision;
  treeEventScopeId: string;
}

export type NodeOrUid = NodeEntity | string;
export type NodeResult = { uid: string; ok: true } | { uid: string; ok: false; error: Error };

export declare enum DriveEventType {
  NodeCreated = 'node_created',
  NodeUpdated = 'node_updated',
  NodeDeleted = 'node_deleted',
  SharedWithMeUpdated = 'shared_with_me_updated',
  TreeRefresh = 'tree_refresh',
  TreeRemove = 'tree_remove',
  FastForward = 'fast_forward',
}

export interface DriveEvent {
  type: DriveEventType | string;
  nodeUid?: string;
  parentNodeUid?: string;
  treeEventScopeId: string;
  eventId: string;
}

export interface UploadMetadata {
  mediaType: string;
  expectedSize: number | null;
  modificationTime?: Date;
  overrideExistingDraftByOtherClient?: boolean;
}

export interface UploadController {
  completion(): Promise<{ nodeRevisionUid: string; nodeUid: string }>;
}

export interface FileUploader {
  uploadFromStream(
    stream: ReadableStream,
    thumbnails: never[],
    onProgress?: (uploadedBytes: number) => void,
  ): Promise<UploadController>;
}

export interface DownloadController {
  completion(): Promise<void>;
}

export interface FileDownloader {
  downloadToStream(
    stream: WritableStream,
    onProgress?: (downloadedBytes: number) => void,
  ): DownloadController;
}

/** The subset of ProtonDriveClient used by ProtonDriveStore (also implemented by test fakes). */
export interface DriveClient {
  getMyFilesRootFolder(): Promise<NodeEntity>;
  iterateFolderChildren(parentNodeUid: NodeOrUid): AsyncGenerator<NodeEntity>;
  getNode(nodeUid: NodeOrUid): Promise<NodeEntity>;
  createFolder(parentNodeUid: NodeOrUid, name: string, modificationTime?: Date): Promise<NodeEntity>;
  trashNodes(nodeUids: NodeOrUid[]): AsyncGenerator<NodeResult>;
  getFileDownloader(nodeUid: NodeOrUid): Promise<FileDownloader>;
  getFileUploader(parentFolderUid: NodeOrUid, name: string, metadata: UploadMetadata): Promise<FileUploader>;
  getFileRevisionUploader(nodeUid: NodeOrUid, metadata: UploadMetadata): Promise<FileUploader>;
  iterateEvents(treeEventScopeId: string, lastEventId?: string): AsyncGenerator<DriveEvent>;
}

export interface CacheLike {
  setEntity(key: string, value: unknown, tags?: string[]): Promise<void>;
  getEntity(key: string): Promise<unknown>;
  removeEntities(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

export declare class MemoryCache<T = unknown> implements CacheLike {
  constructor();
  setEntity(key: string, value: T, tags?: string[]): Promise<void>;
  getEntity(key: string): Promise<T>;
  removeEntities(keys: string[]): Promise<void>;
  clear(): Promise<void>;
}

export interface ProtonDriveClientParameters {
  httpClient: ProtonDriveHTTPClient;
  entitiesCache: CacheLike;
  cryptoCache: CacheLike;
  account: ProtonDriveAccount;
  openPGPCryptoModule: OpenPGPCrypto;
  srpModule: SRPModule;
  config?: { baseUrl?: string; language?: string; clientUid?: string };
}

export declare class ProtonDriveClient implements DriveClient {
  constructor(parameters: ProtonDriveClientParameters);
  getMyFilesRootFolder(): Promise<NodeEntity>;
  iterateFolderChildren(parentNodeUid: NodeOrUid): AsyncGenerator<NodeEntity>;
  getNode(nodeUid: NodeOrUid): Promise<NodeEntity>;
  createFolder(parentNodeUid: NodeOrUid, name: string, modificationTime?: Date): Promise<NodeEntity>;
  trashNodes(nodeUids: NodeOrUid[]): AsyncGenerator<NodeResult>;
  getFileDownloader(nodeUid: NodeOrUid): Promise<FileDownloader>;
  getFileUploader(parentFolderUid: NodeOrUid, name: string, metadata: UploadMetadata): Promise<FileUploader>;
  getFileRevisionUploader(nodeUid: NodeOrUid, metadata: UploadMetadata): Promise<FileUploader>;
  iterateEvents(treeEventScopeId: string, lastEventId?: string): AsyncGenerator<DriveEvent>;
}
