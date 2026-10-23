import type { ConflictChoice, MergeResult } from '@marknotes/sync';
import { mergeText } from '@marknotes/sync';
import { useState } from 'react';
import * as P from '../../../shared/paths';
import type { SyncConflict } from '../../../shared/syncEngine';
import { PROVIDER_NAMES } from '../../../shared/types';
import { Dialog } from './Dialog';
import { useApp, useSyncState } from './context';

const CHOICES: { value: ConflictChoice; label: string }[] = [
  { value: 'local', label: 'Kept' },
  { value: 'remote', label: 'Copy' },
  { value: 'both', label: 'Both' },
  { value: 'neither', label: 'Neither' },
];

const joined = (ls: string[]) => ls.join('').replace(/\n$/, '');

export function Conflicts(props: { onBack(): void }) {
  const state = useSyncState();
  return (
    <>
      <div className="topbar">
        <button className="icon" aria-label="Back" onClick={props.onBack}>
          ←
        </button>
        <h1>Sync conflicts</h1>
      </div>
      <div className="page">
        <div className="page-inner">
          {state.conflicts.length === 0 && <p className="empty">No conflicts</p>}
          {state.conflicts.map((c) => {
            const drive = state.drives.find((d) => d.account.id === c.driveId)?.account;
            const driveName = drive ? `${PROVIDER_NAMES[drive.provider]} (${drive.label})` : 'the drive';
            return <ConflictCard key={c.copyPath} conflict={c} driveName={driveName} />;
          })}
        </div>
      </div>
    </>
  );
}

function ConflictCard(props: { conflict: SyncConflict; driveName: string }) {
  const { sync } = useApp();
  const state = useSyncState();
  const { conflict, driveName } = props;
  const [merge, setMerge] = useState<MergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choices, setChoices] = useState<Partial<Record<number, ConflictChoice>>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const kept = conflict.winner === 'local' ? 'this device' : driveName;
  const other = conflict.winner === 'local' ? driveName : 'this device';
  const allChosen = merge !== null && Object.keys(choices).length === merge.conflicts;
  const merged = () => (merge ? mergeText(merge.chunks, choices as Record<number, ConflictChoice>) : '');

  const startMerge = async () => {
    setError(null);
    try {
      setChoices({});
      setMerge(await sync.mergePreview(conflict));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  let conflictIndex = 0;
  return (
    <div className="card" data-testid="conflict">
      <div className="title">{P.displayName(conflict.path)}</div>
      <div className="small">
        /{conflict.path} · Changed on this device and on {driveName}. The newest version (from {kept}) was
        kept; the version from {other} was saved as {conflict.copyPath}.
      </div>
      {error && <div className="small">Could not merge: {error}</div>}
      {merge?.chunks.map((chunk, i) => {
        if (chunk.kind === 'resolved') {
          const text = joined(chunk.lines);
          if (text === '') return null;
          const lines = text.split('\n');
          const shown = lines.length > 6 ? [...lines.slice(0, 2), '…', ...lines.slice(-2)] : lines;
          return (
            <div key={i} className="context">
              {shown.join('\n')}
            </div>
          );
        }
        const index = conflictIndex++;
        return (
          <div key={i} className="hunk">
            <div className="side-label">Change {index + 1} · Kept version</div>
            <pre className="local">{joined(chunk.local) || ' '}</pre>
            <div className="side-label">Conflicted copy</div>
            <pre className="remote">{joined(chunk.remote) || ' '}</pre>
            <div className="row" style={{ padding: 6 }}>
              {CHOICES.map((c) => (
                <button
                  key={c.value}
                  className={choices[index] === c.value ? 'selected' : 'outlined'}
                  onClick={() => setChoices({ ...choices, [index]: c.value })}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}
      <div className="row" style={{ marginTop: 8 }}>
        {merge === null ? (
          <>
            <button className="filled" disabled={state.running} onClick={() => void startMerge()}>
              Merge copy back
            </button>
            <button disabled={state.running} onClick={() => void sync.discardCopy(conflict)}>
              Discard copy
            </button>
            <button disabled={state.running} onClick={() => sync.keepBoth(conflict)}>
              Keep both files
            </button>
          </>
        ) : (
          <>
            <button
              className="filled"
              disabled={!allChosen || state.running}
              onClick={() => void sync.mergeCopyBack(conflict, merged())}
            >
              Save merge
            </button>
            <button className="outlined" disabled={state.running} onClick={() => setEditing(merged())}>
              Edit merged
            </button>
            <button onClick={() => setMerge(null)}>Cancel</button>
          </>
        )}
      </div>
      {editing !== null && (
        <Dialog
          title="Edit merged note"
          onClose={() => setEditing(null)}
          actions={
            <>
              <button onClick={() => setEditing(null)}>Cancel</button>
              <button
                className="filled"
                onClick={() => {
                  void sync.mergeCopyBack(conflict, editing);
                  setEditing(null);
                }}
              >
                Save
              </button>
            </>
          }
        >
          <textarea className="merged" value={editing} onChange={(e) => setEditing(e.target.value)} />
        </Dialog>
      )}
    </div>
  );
}
