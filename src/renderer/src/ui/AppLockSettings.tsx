import { useEffect, useRef, useState } from 'react';
import type { LockStatus, Result } from '../../../preload/api';
import { api, unwrap } from '../data/api';
import { Dialog } from './Dialog';
import { errorMessage, useApp } from './context';

const IDLE_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
  { value: 60, label: '60 min' },
];

const MIN_PASSPHRASE = 8;

interface Field {
  id: string;
  label: string;
  autoComplete: 'current-password' | 'new-password';
}

/** Asks for one or more passphrases; `onSubmit` may throw to show an error. */
function PassphraseDialog(props: {
  title: string;
  message?: string;
  fields: Field[];
  confirm: string;
  /** Asks for the new passphrase twice and checks its length. */
  newPassphrase?: boolean;
  onSubmit(values: string[]): Promise<void>;
  onClose(): void;
}) {
  const fields = props.newPassphrase
    ? [
        ...props.fields,
        { id: 'repeat', label: 'Repeat the new passphrase', autoComplete: 'new-password' as const },
      ]
    : props.fields;
  const [values, setValues] = useState(() => fields.map(() => ''));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  const submit = async () => {
    if (busy || values.some((v) => v === '')) return;
    if (props.newPassphrase) {
      const created = values[values.length - 2];
      if (created.length < MIN_PASSPHRASE) {
        setError(`Use at least ${MIN_PASSPHRASE} characters`);
        return;
      }
      if (created !== values[values.length - 1]) {
        setError('The passphrases do not match');
        return;
      }
    }
    setBusy(true);
    setError(null);
    try {
      await props.onSubmit(props.newPassphrase ? values.slice(0, -1) : values);
      props.onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={props.title}
      onClose={props.onClose}
      actions={
        <>
          <button onClick={props.onClose}>Cancel</button>
          <button
            className="filled"
            disabled={busy || values.some((v) => v === '')}
            onClick={() => void submit()}
          >
            {props.confirm}
          </button>
        </>
      }
    >
      {props.message && <p>{props.message}</p>}
      {fields.map((field, i) => (
        <div className="field" key={field.id}>
          <label htmlFor={`passphrase-${field.id}`}>{field.label}</label>
          <input
            id={`passphrase-${field.id}`}
            ref={i === 0 ? first : undefined}
            type="password"
            autoComplete={field.autoComplete}
            value={values[i]}
            disabled={busy}
            onChange={(e) => {
              const next = [...values];
              next[i] = e.target.value;
              setValues(next);
              setError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </div>
      ))}
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
    </Dialog>
  );
}

type Action = 'enable' | 'disable' | 'change' | null;

/** Settings → Privacy: local encryption status and the app lock. */
export function AppLockSettings() {
  const { lock, setLock, idleMinutes, setIdleMinutes } = useApp();
  const [action, setAction] = useState<Action>(null);
  const run = async (call: Promise<Result<LockStatus>>) => setLock(await unwrap(call));

  return (
    <>
      <p className="small">
        Notes, images and sync data stored on this device are encrypted.{' '}
        {lock.enabled
          ? 'The app lock protects the key with your passphrase.'
          : lock.protection === 'keychain'
            ? 'The key is protected by the system keychain.'
            : ''}
      </p>
      {lock.protection === 'none' && (
        <p className="notice" data-testid="local-key-warning">
          No system keyring protects the encryption key on this device, so anything running as your user can
          read the notes. Enable the app lock to protect them with a passphrase.
        </p>
      )}
      <h3>App lock</h3>
      <p className="small">
        Asks for a passphrase when MarkNotes starts, after the idle time, and when the computer sleeps or the
        screen locks. The passphrase cannot be recovered: if you forget it, delete the local data and connect
        a drive again to download your notes.
      </p>
      <div className="row">
        {lock.enabled ? (
          <>
            <button className="outlined" onClick={() => void api().lockNow()}>
              Lock now
            </button>
            <button className="outlined" onClick={() => setAction('change')}>
              Change passphrase
            </button>
            <button className="outlined danger" onClick={() => setAction('disable')}>
              Turn off app lock
            </button>
          </>
        ) : (
          <button className="filled" onClick={() => setAction('enable')}>
            Turn on app lock
          </button>
        )}
      </div>
      {lock.enabled && (
        <div className="field">
          <label>Lock after inactivity</label>
          <div className="row" role="radiogroup" aria-label="Lock after inactivity">
            {IDLE_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={idleMinutes === o.value}
                className={idleMinutes === o.value ? 'selected' : 'outlined'}
                onClick={() => setIdleMinutes(o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {action === 'enable' && (
        <PassphraseDialog
          title="Turn on app lock"
          message="Choose a passphrase. It cannot be recovered if you forget it."
          fields={[{ id: 'new', label: 'New passphrase', autoComplete: 'new-password' }]}
          newPassphrase
          confirm="Turn on"
          onSubmit={([passphrase]) => run(api().enableLock(passphrase))}
          onClose={() => setAction(null)}
        />
      )}
      {action === 'disable' && (
        <PassphraseDialog
          title="Turn off app lock"
          fields={[{ id: 'current', label: 'Passphrase', autoComplete: 'current-password' }]}
          confirm="Turn off"
          onSubmit={([passphrase]) => run(api().disableLock(passphrase))}
          onClose={() => setAction(null)}
        />
      )}
      {action === 'change' && (
        <PassphraseDialog
          title="Change passphrase"
          fields={[
            { id: 'current', label: 'Current passphrase', autoComplete: 'current-password' },
            { id: 'new', label: 'New passphrase', autoComplete: 'new-password' },
          ]}
          newPassphrase
          confirm="Change"
          onSubmit={([current, next]) => run(api().changePassphrase(current, next))}
          onClose={() => setAction(null)}
        />
      )}
    </>
  );
}
