/** How a failed sync step should be treated by automatic sync: retry later or stop until the user acts. */
export interface SyncFailure {
  kind: 'retryable' | 'permanent';
}

/**
 * Outcome of a sync attempt for automatic sync: `retry` when every failure is temporary, `deferred` when the attempt
 * did not start because a merge was in progress, `stop` when it did not start or a failure needs the user.
 */
export type SyncAttemptResult = { state: 'complete' | 'retry' | 'deferred' | 'stop' };

/** An error that carries its classification, e.g. across IPC from the main process. */
export class SyncFailureError extends Error {
  constructor(
    message: string,
    readonly failure: SyncFailure,
  ) {
    super(message);
  }
}

const NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const isNetworkCode = (value: unknown) =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { code?: unknown }).code === 'string' &&
  NETWORK_CODES.has((value as { code: string }).code);

/**
 * Only structured transport errors and HTTP 408, 429 and 5xx statuses (`status`, `httpStatus` or `statusCode`, as
 * set by the Dropbox, OneDrive and Proton connectors) are retryable; anything else, sign-in errors included, is
 * permanent. Message text is never inspected.
 */
export function classifySyncFailure(error: unknown): SyncFailure {
  if (error instanceof SyncFailureError) return error.failure;
  if (typeof error !== 'object' || error === null) return { kind: 'permanent' };
  const value = error as Record<string, unknown>;
  const status = value.httpStatus ?? value.statusCode ?? value.status;
  if (typeof status === 'number' && status > 0) {
    return {
      kind: status === 408 || status === 429 || (status >= 500 && status <= 599) ? 'retryable' : 'permanent',
    };
  }
  if (isNetworkCode(value) || (value.cause !== error && isNetworkCode(value.cause)))
    return { kind: 'retryable' };
  return { kind: 'permanent' };
}

/** `complete` without failures, `retry` when every failure is retryable, `stop` otherwise. */
export function syncAttemptResult(failures: SyncFailure[]): SyncAttemptResult {
  if (failures.length === 0) return { state: 'complete' };
  return { state: failures.every((failure) => failure.kind === 'retryable') ? 'retry' : 'stop' };
}
