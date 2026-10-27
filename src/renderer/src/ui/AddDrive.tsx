import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import type { ProviderInfo, SignedIn } from '../../../preload/api';
import * as P from '../../../shared/paths';
import {
  alreadyConnectedMessage,
  DEFAULT_ROOT_FOLDER,
  PROVIDER_NAMES,
  type DriveAccount,
  type DriveProvider,
  type RemoteFolder,
} from '../../../shared/types';
import { api, unwrap } from '../data/api';
import { errorMessage, useApp } from './context';
import { StorageWarning } from './StorageWarning';

type Step =
  | { kind: 'choose' }
  | { kind: 'signingIn'; provider: DriveProvider }
  | { kind: 'protonLogin' }
  | { kind: 'folder'; account: SignedIn; browsable: boolean };

export function AddDrive(props: { onDone(): void; reconnect?: DriveAccount }) {
  const { sync } = useApp();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [step, setStep] = useState<Step>({ kind: 'choose' });
  const [error, setError] = useState<string | null>(null);
  const signedIn = useRef<SignedIn | null>(null);
  const active = useRef(true);
  const [committing, setCommitting] = useState(false);

  useEffect(() => {
    active.current = true;
    unwrap(api().providers()).then(setProviders, (e) => setError(errorMessage(e)));
    return () => {
      active.current = false;
    };
  }, []);

  /** Leaves the wizard; an account that signed in but was not added is signed out again. */
  const leave = () => {
    active.current = false;
    if (step.kind === 'signingIn') void api().cancelSignIn();
    if (signedIn.current) void api().discardSignIn(signedIn.current.id);
    props.onDone();
  };

  const signedInAs = async (account: SignedIn) => {
    if (!active.current) {
      await unwrap(api().discardSignIn(account.id));
      return;
    }
    if (!props.reconnect && sync.current.drives.some((d) => d.account.id === account.id)) {
      // Re-adding would reuse the drive's sync records with a new folder; the main process refuses it too.
      void api().discardSignIn(account.id);
      setError(alreadyConnectedMessage(account.label));
      setStep({ kind: 'choose' });
      return;
    }
    signedIn.current = account;
    if (props.reconnect) {
      setCommitting(true);
      try {
        await sync.reconnect(props.reconnect.id, account.id);
        signedIn.current = null;
        props.onDone();
        void sync.syncNow();
      } catch (e) {
        setError(errorMessage(e));
        await unwrap(api().discardSignIn(account.id));
        signedIn.current = null;
        setStep({ kind: 'choose' });
      } finally {
        setCommitting(false);
      }
      return;
    }
    const info = providers.find((p) => p.provider === account.provider);
    setStep({ kind: 'folder', account, browsable: info?.browsable ?? false });
  };

  const choose = async (provider: DriveProvider) => {
    setError(null);
    if (provider === 'proton') {
      setStep({ kind: 'protonLogin' });
      return;
    }
    setStep({ kind: 'signingIn', provider });
    try {
      const account = await unwrap(api().signIn(provider));
      if (account) await signedInAs(account);
      else setStep({ kind: 'choose' });
    } catch (e) {
      setError(errorMessage(e));
      setStep({ kind: 'choose' });
    }
  };

  return (
    <>
      <div className="topbar">
        <button className="icon" aria-label="Back" disabled={committing} onClick={leave}>
          <Icon name="back" />
        </button>
        <h1>
          {props.reconnect
            ? 'Reconnect drive'
            : step.kind === 'protonLogin'
              ? 'Proton Drive login'
              : 'Add drive'}
        </h1>
      </div>
      <div className="page">
        <div className="page-inner">
          {error && <p className="error">{error}</p>}
          {step.kind === 'choose' && (
            <>
              <StorageWarning />
              {props.reconnect ? (
                <p>
                  Sign in again as {props.reconnect.label}. Your sync folder and local sync data will be kept.
                </p>
              ) : (
                <p>
                  Choose where to sync your notes. You can connect several drives: each one keeps a full copy.
                </p>
              )}
              {providers
                .filter((p) => !props.reconnect || p.provider === props.reconnect.provider)
                .map((p) => (
                  <button
                    key={p.provider}
                    className="choice"
                    disabled={committing || p.unavailableReason !== null}
                    onClick={() => void choose(p.provider)}
                  >
                    <span className="title">{p.name}</span>
                    {p.unavailableReason && <span className="small">{p.unavailableReason}</span>}
                  </button>
                ))}
            </>
          )}
          {step.kind === 'signingIn' && (
            <>
              <p>Signing in to {PROVIDER_NAMES[step.provider]}…</p>
              <p className="small">Complete the sign-in in your browser, then come back here.</p>
              <button
                disabled={committing}
                onClick={() => {
                  void api().cancelSignIn();
                  setStep({ kind: 'choose' });
                }}
              >
                Cancel
              </button>
            </>
          )}
          {step.kind === 'protonLogin' && (
            <ProtonLogin
              staged={!!props.reconnect}
              initialUsername={props.reconnect?.label}
              onSignedIn={signedInAs}
            />
          )}
          {step.kind === 'folder' && (
            <FolderStep
              account={step.account}
              browsable={step.browsable}
              onConnect={async (options) => {
                await unwrap(api().addDrive(step.account.id, options));
                signedIn.current = null;
                props.onDone();
                void sync.driveAdded();
              }}
            />
          )}
        </div>
      </div>
    </>
  );
}

function ProtonLogin(props: {
  staged?: boolean;
  initialUsername?: string;
  onSignedIn(account: SignedIn): Promise<void>;
}) {
  const [username, setUsername] = useState(props.initialUsername ?? '');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A login waiting for its two-factor code; abandoned (and its password dropped) when the form goes away. */
  const pending = useRef<string | null>(null);
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (pending.current) void api().protonCancel(pending.current);
    };
  }, []);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (pendingId) {
        const account = await unwrap(api().protonTwoFactor(pendingId, code.trim()));
        pending.current = null;
        await props.onSignedIn(account);
      } else {
        const result = await unwrap(api().protonLogin(username.trim(), password, props.staged));
        setPassword('');
        if (result.kind === 'signedIn') await props.onSignedIn(result.account);
        else {
          if (!active.current) {
            await unwrap(api().protonCancel(result.pendingId));
            return;
          }
          pending.current = result.pendingId;
          setPendingId(result.pendingId);
        }
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <p className="notice">This is a third-party application not officially supported by Proton.</p>
      {pendingId === null ? (
        <>
          <div className="field">
            <label htmlFor="proton-user">Username or email</label>
            <input
              id="proton-user"
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="proton-password">Password</label>
            <input
              id="proton-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button className="filled" type="submit" disabled={busy || !username.trim() || !password}>
            Log in
          </button>
        </>
      ) : (
        <>
          <p>Enter the 6-digit code from your authenticator app.</p>
          <div className="field">
            <label htmlFor="proton-2fa">Two-factor code</label>
            <input
              id="proton-2fa"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </div>
          <button className="filled" type="submit" disabled={busy || code.trim().length < 6}>
            Verify
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <p className="small">
        Your password is never stored. To sync without asking for it again, the keys that decrypt your drive
        are kept on this device, protected by the system keychain (or only in memory when there is no
        keychain). CAPTCHA / human verification is not supported in this version.
      </p>
    </form>
  );
}

function FolderStep(props: {
  account: SignedIn;
  browsable: boolean;
  onConnect(options: {
    remoteFolder: string;
    createRootFolder: boolean;
    rootFolderName: string;
  }): Promise<void>;
}) {
  const { account, browsable } = props;
  const [path, setPath] = useState('');
  const [folders, setFolders] = useState<RemoteFolder[] | null>(null);
  const [createRoot, setCreateRoot] = useState(true);
  const [rootName, setRootName] = useState(DEFAULT_ROOT_FOLDER);
  const [manualFolder, setManualFolder] = useState(DEFAULT_ROOT_FOLDER);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!browsable) return;
    let cancelled = false;
    setFolders(null);
    unwrap(api().listFolders(account.id, path)).then(
      (f) => !cancelled && setFolders(f),
      (e) => !cancelled && setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [account.id, path, browsable]);

  let nameValid = true;
  try {
    if (browsable && createRoot) P.validateName(rootName.trim());
    if (!browsable) P.normalize(manualFolder);
  } catch {
    nameValid = false;
  }
  const target = browsable
    ? createRoot
      ? P.join(path, rootName.trim())
      : path
    : (() => {
        try {
          return P.normalize(manualFolder);
        } catch {
          return manualFolder;
        }
      })();

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      await props.onConnect(
        browsable
          ? { remoteFolder: path, createRootFolder: createRoot, rootFolderName: rootName.trim() }
          : {
              remoteFolder: P.normalize(manualFolder),
              createRootFolder: false,
              rootFolderName: DEFAULT_ROOT_FOLDER,
            },
      );
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        Signed in to {PROVIDER_NAMES[account.provider]} as {account.label}
      </p>
      {browsable ? (
        <>
          <div className="row">
            {path !== '' && (
              <button className="icon" aria-label="Up" onClick={() => setPath(P.parent(path))}>
                <Icon name="back" />
              </button>
            )}
            <strong>Folder: /{path}</strong>
          </div>
          <div className="folder-picker" data-testid="folder-picker">
            {folders === null && <div className="empty">Loading…</div>}
            {folders?.length === 0 && <div className="empty">No sub-folders</div>}
            {folders?.map((f) => (
              <div key={f.path} className="entry" onClick={() => setPath(f.path)}>
                <Icon name="folder" /> {f.name}
              </div>
            ))}
          </div>
          <label className="row">
            <input type="checkbox" checked={createRoot} onChange={(e) => setCreateRoot(e.target.checked)} />
            Create a folder for the notes here
          </label>
          {createRoot && (
            <div className="field">
              <label htmlFor="root-name">Folder name</label>
              <input
                id="root-name"
                type="text"
                value={rootName}
                onChange={(e) => setRootName(e.target.value)}
              />
            </div>
          )}
        </>
      ) : (
        <div className="field">
          <label htmlFor="manual-folder">Folder in My files</label>
          <input
            id="manual-folder"
            type="text"
            value={manualFolder}
            onChange={(e) => setManualFolder(e.target.value)}
          />
        </div>
      )}
      <p className="small">Notes will be synced to /{target}</p>
      {error && <p className="error">{error}</p>}
      <button className="filled" disabled={busy || !nameValid} onClick={() => void connect()}>
        Connect
      </button>
    </>
  );
}
