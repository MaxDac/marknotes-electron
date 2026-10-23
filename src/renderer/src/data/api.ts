import type { MarkNotesApi, RemoteOp, Result } from '../../../preload/api';
import type { RemoteDriveStore, RemoteEntry } from '../../../shared/types';

export const api = (): MarkNotesApi => window.marknotes;

/** Unwraps an IPC result, rethrowing the main-process error message. */
export async function unwrap<T>(promise: Promise<Result<T>>): Promise<T> {
  const result = await promise;
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

/** RemoteDriveStore living in the main process, reached over IPC. */
export class IpcRemoteDriveStore implements RemoteDriveStore {
  constructor(private readonly driveId: string) {}
  private call<T>(op: RemoteOp) {
    return unwrap(api().remote(this.driveId, op)) as Promise<T>;
  }
  snapshot() {
    return this.call<RemoteEntry[]>({ op: 'snapshot' });
  }
  download(entry: RemoteEntry) {
    return this.call<Uint8Array>({ op: 'download', entry });
  }
  uploadNew(path: string, bytes: Uint8Array, modifiedMillis?: number) {
    return this.call<RemoteEntry>({ op: 'uploadNew', path, bytes, modifiedMillis });
  }
  uploadRevision(entry: RemoteEntry, bytes: Uint8Array, modifiedMillis?: number) {
    return this.call<RemoteEntry>({ op: 'uploadRevision', entry, bytes, modifiedMillis });
  }
  createFolder(path: string) {
    return this.call<RemoteEntry>({ op: 'createFolder', path });
  }
  delete(entry: RemoteEntry) {
    return this.call<void>({ op: 'delete', entry });
  }
  readManifest() {
    return this.call<Uint8Array | null>({ op: 'readManifest' });
  }
  writeManifest(bytes: Uint8Array) {
    return this.call<void>({ op: 'writeManifest', bytes });
  }
}
