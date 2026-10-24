import { useEffect, useRef, useState } from 'react';
import type { LockStatus } from '../../../preload/api';
import { api, unwrap } from '../data/api';
import { deleteDatabases } from '../data/db';
import { ConfirmDialog } from './Dialog';
import { errorMessage } from './context';

/**
 * Deletes the local data without being able to read it (forgotten passphrase, unreadable key): every drive is
 * disconnected, the key replaced and the databases deleted. The notes download again when a drive is connected.
 */
async function resetLocalData() {
  for (const account of await unwrap(api().drives())) await unwrap(api().removeDrive(account.id));
  await unwrap(api().resetLocalKey());
  await deleteDatabases();
}

/** Shown before anything is read when the app lock is enabled, or when the local key cannot be read. */
export function LockScreen(props: { status: LockStatus; onUnlocked(status: LockStatus): void }) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const unreadable = props.status.state === 'error';

  useEffect(() => {
    input.current?.focus();
  }, []);

  const unlock = () => {
    if (busy || passphrase === '') return;
    setBusy(true);
    setError(null);
    unwrap(api().unlock(passphrase)).then(
      (status) => props.onUnlocked(status),
      (e) => {
        setError(errorMessage(e));
        setPassphrase('');
        setBusy(false);
        input.current?.focus();
      },
    );
  };

  return (
    <div className="page lock-screen">
      <div className="page-inner">
        <h1>MarkNotes is locked</h1>
        {unreadable ? (
          <p className="notice error" data-testid="lock-error">
            {props.status.error ?? 'The notes on this device cannot be read.'} Delete the local data, then
            connect a drive again to download your notes.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="unlock-passphrase">Passphrase</label>
              <input
                id="unlock-passphrase"
                ref={input}
                type="password"
                autoComplete="current-password"
                value={passphrase}
                disabled={busy}
                onChange={(e) => {
                  setPassphrase(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => e.key === 'Enter' && unlock()}
              />
            </div>
            <div className="row">
              <button className="filled" disabled={busy || passphrase === ''} onClick={unlock}>
                {busy ? 'Unlocking…' : 'Unlock'}
              </button>
            </div>
            <p className="small">
              Forgot the passphrase? It cannot be recovered: delete the local data, then connect a drive again
              to download your notes. Notes that were never synced are lost.
            </p>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="row">
          <button className="outlined danger" disabled={busy} onClick={() => setConfirmReset(true)}>
            Delete all local data
          </button>
        </div>
      </div>
      {confirmReset && (
        <ConfirmDialog
          title="Delete all local data?"
          message="Every drive is disconnected, the app lock is removed and the notes, images and sync data stored on this device are deleted. Nothing is deleted from the drives: connect a drive again to download your notes. Notes that were never synced are lost."
          confirm="Delete"
          danger
          onClose={() => setConfirmReset(false)}
          onConfirm={() => {
            setBusy(true);
            setError(null);
            resetLocalData().then(
              () => window.location.reload(),
              (e) => {
                setError(`Could not delete the local data: ${errorMessage(e)}`);
                setBusy(false);
              },
            );
          }}
        />
      )}
    </div>
  );
}
