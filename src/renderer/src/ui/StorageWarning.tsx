import { useEffect, useState } from 'react';
import type { SecureStorageStatus } from '../../../preload/api';
import { api, unwrap } from '../data/api';

/** Explains how drive credentials are kept when the OS keychain cannot protect them. */
export function StorageWarning() {
  const [status, setStatus] = useState<SecureStorageStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    unwrap(api().secureStorage()).then(
      (s) => !cancelled && setStatus(s),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === 'weak') {
    return (
      <p className="notice" data-testid="storage-warning">
        No system keyring (such as GNOME Keyring or KWallet) is available, so drive sign-ins are only kept in
        memory: you will need to sign in again after restarting MarkNotes. Install and unlock a keyring to
        stay signed in.
      </p>
    );
  }
  if (status === 'unavailable') {
    return (
      <p className="notice error" data-testid="storage-warning">
        Secure storage is not available on this system, so drives cannot be connected.
      </p>
    );
  }
  return null;
}
