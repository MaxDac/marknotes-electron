import { useState } from 'react';
import { cleanUnusedAttachments } from '../../../shared/attachments';
import { PROVIDER_NAMES, syncFolder } from '../../../shared/types';
import logo from '../../../../branding/marknotes-mark.svg';
import type { Page } from '../App';
import { api } from '../data/api';
import type { DriveStatus } from '../data/syncManager';
import { AppLockSettings } from './AppLockSettings';
import { ConfirmDialog } from './Dialog';
import { DiagnosticsSettings } from './DiagnosticsSettings';
import { errorMessage, useApp, useSyncState } from './context';
import { OTHER_APPS, openOtherApp } from './otherApps';
import { StorageWarning } from './StorageWarning';
import { PALETTES, THEME_MODES, type ThemeColor } from './theme';

export function SettingsPage(props: { navigate(page: Page): void }) {
  const { notes, sync, theme, setTheme, chordSequences, setChordSequences } = useApp();
  const state = useSyncState();
  const [disconnect, setDisconnect] = useState<DriveStatus | null>(null);
  const [confirmClean, setConfirmClean] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [cleanMessage, setCleanMessage] = useState<string | null>(null);
  const [deleteLocal, setDeleteLocal] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [wipeError, setWipeError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const lastDrive = state.drives.length === 1;

  return (
    <>
      <div className="topbar">
        <button className="icon" aria-label="Back" onClick={() => props.navigate('notes')}>
          ←
        </button>
        <h1>Settings</h1>
      </div>
      <div className="page">
        <div className="page-inner">
          <h2>Drives</h2>
          {state.drives.length === 0 && (
            <p className="small">No drives connected. Notes are only stored on this device.</p>
          )}
          {state.drives.map((drive) => (
            <div className="card" key={drive.account.id} data-testid="drive">
              <div className="row">
                <div style={{ flex: 1 }}>
                  <div className="title">
                    {PROVIDER_NAMES[drive.account.provider]} · {drive.account.label}
                  </div>
                  <div className="small">Folder: /{syncFolder(drive.account)}</div>
                  {drive.lastSyncAt > 0 && (
                    <div className="small">Last sync: {new Date(drive.lastSyncAt).toLocaleString()}</div>
                  )}
                  {drive.message && <div className="small">{drive.message}</div>}
                  {drive.unavailableReason && <div className="error small">{drive.unavailableReason}</div>}
                </div>
                <button className="danger" onClick={() => setDisconnect(drive)}>
                  Disconnect
                </button>
              </div>
            </div>
          ))}
          <div className="row">
            <button className="filled" onClick={() => props.navigate('addDrive')}>
              Add drive
            </button>
            <button
              className="outlined"
              disabled={state.running || state.drives.length === 0}
              onClick={() => void sync.syncNow()}
            >
              {state.running ? 'Syncing…' : 'Sync now'}
            </button>
            {state.conflicts.length > 0 && (
              <button className="outlined danger" onClick={() => props.navigate('conflicts')}>
                Resolve {state.conflicts.length} conflict(s)
              </button>
            )}
          </div>
          {state.message && (
            <p className="small" data-testid="sync-message">
              {state.message}
            </p>
          )}

          <h2>Appearance</h2>
          <div className="field">
            <label>Theme</label>
            <div className="row" role="radiogroup" aria-label="Theme">
              {THEME_MODES.map((m) => (
                <button
                  key={m.value}
                  role="radio"
                  aria-checked={theme.mode === m.value}
                  className={theme.mode === m.value ? 'selected' : 'outlined'}
                  onClick={() => setTheme(m.value, theme.color)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>Colour: {PALETTES[theme.color].label}</label>
            <div className="row" role="radiogroup" aria-label="Colour">
              {(Object.keys(PALETTES) as ThemeColor[]).map((c) => (
                <button
                  key={c}
                  role="radio"
                  aria-checked={theme.color === c}
                  aria-label={PALETTES[c].label}
                  title={PALETTES[c].label}
                  className={`swatch ${theme.color === c ? 'selected' : ''}`}
                  style={{ background: PALETTES[c].light }}
                  onClick={() => setTheme(theme.mode, c)}
                />
              ))}
            </div>
          </div>

          <h2>Chord sequences</h2>
          <label className="row">
            <input
              type="checkbox"
              role="switch"
              aria-label="Chord sequences"
              data-testid="chord-sequences-setting"
              checked={chordSequences}
              onChange={(e) => setChordSequences(e.target.checked)}
            />
            Create and edit chord sequences for guitar and bass
          </label>
          <p className="small">
            When this is off, &quot;New chord sequence&quot; is hidden. Existing chord sequences are kept and
            synced either way. This setting is stored on this device only.
          </p>

          <h2>Images</h2>
          <p className="small">
            Images are stored in the attachments folder and synced to every drive. Images that no note uses
            any more are only removed when you clean them up here.
          </p>
          <div className="row">
            <button className="outlined" disabled={cleaning} onClick={() => setConfirmClean(true)}>
              Clean unused images
            </button>
          </div>
          {cleanMessage && (
            <p className="small" data-testid="clean-message">
              {cleanMessage}
            </p>
          )}

          <h2>Privacy</h2>
          <StorageWarning />
          <p className="small">
            Notes are stored on this device so that you can read and edit them offline. Images from the web
            are only loaded when you ask for them in a note.
          </p>
          <AppLockSettings />
          <div className="row">
            <button className="outlined danger" onClick={() => setConfirmWipe(true)}>
              Delete all local data
            </button>
          </div>
          {wipeError && <p className="error small">{wipeError}</p>}

          <DiagnosticsSettings />
          <h2>About</h2>
          <p className="about-logo">
            <img src={logo} alt="" className="logo" />
            MarkNotes
          </p>
          <p className="small">
            MarkNotes is a personal, non-commercial project. Sync happens on app launch and when you click
            &quot;Sync now&quot;; there is no background polling.
          </p>
          <h3>Other MarkNotes apps</h3>
          <p className="small">They share the same drive folder and note format.</p>
          <div className="row" data-testid="other-apps">
            {OTHER_APPS.map((other) => (
              <button
                key={other.url}
                className="outlined"
                title={other.url}
                onClick={() => {
                  setLinkError(null);
                  void openOtherApp((url) => api().openExternal(url), other).then(setLinkError);
                }}
              >
                {other.label}
              </button>
            ))}
          </div>
          {linkError && (
            <p className="error small" role="alert">
              {linkError}
            </p>
          )}
        </div>
      </div>
      {disconnect && (
        <ConfirmDialog
          title={`Disconnect ${PROVIDER_NAMES[disconnect.account.provider]}?`}
          message={
            lastDrive ? 'Nothing is deleted from the drive.' : 'Notes stay on this device and on the drive.'
          }
          confirm="Disconnect"
          danger
          onClose={() => {
            setDisconnect(null);
            setDeleteLocal(false);
          }}
          onConfirm={() => {
            const wipe = lastDrive && deleteLocal;
            void sync
              .removeDrive(disconnect.account, { deleteLocalData: wipe })
              .then(() => wipe && window.location.reload());
          }}
        >
          {lastDrive && (
            <label className="row">
              <input
                type="checkbox"
                checked={deleteLocal}
                data-testid="delete-local-notes"
                onChange={(e) => setDeleteLocal(e.target.checked)}
              />
              Also delete the notes stored on this device
            </label>
          )}
        </ConfirmDialog>
      )}
      {confirmWipe && (
        <ConfirmDialog
          title="Delete all local data?"
          message="Every drive is disconnected, then the notes, images and sync data stored on this device are deleted. Nothing is deleted from the drives: connect a drive again to download your notes. Notes that were never synced are lost."
          confirm="Delete"
          danger
          onClose={() => setConfirmWipe(false)}
          onConfirm={() => {
            setWipeError(null);
            sync.deleteAllLocalData().then(
              () => window.location.reload(),
              (e) => setWipeError(`Could not delete the local data: ${errorMessage(e)}`),
            );
          }}
        />
      )}
      {confirmClean && (
        <ConfirmDialog
          title="Clean unused images?"
          message="Images that no note references are deleted from this device and, on the next sync, from every drive."
          confirm="Delete"
          danger
          onClose={() => setConfirmClean(false)}
          onConfirm={() => {
            setCleaning(true);
            setCleanMessage(null);
            cleanUnusedAttachments(notes).then(
              (count) => {
                setCleanMessage(
                  count === 0 ? 'No unused images' : `Deleted ${count} unused image${count === 1 ? '' : 's'}`,
                );
                setCleaning(false);
              },
              (e) => {
                setCleanMessage(`Could not clean images: ${errorMessage(e)}`);
                setCleaning(false);
              },
            );
          }}
        />
      )}
    </>
  );
}
