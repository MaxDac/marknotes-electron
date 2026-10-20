import { useMemo, useState } from 'react';
import type { ConflictChoice } from '../../../shared/merge';
import * as P from '../../../shared/paths';
import type { SyncConflict } from '../../../shared/syncEngine';
import { PROVIDER_NAMES } from '../../../shared/types';
import { Dialog } from './Dialog';
import { useApp, useSyncState } from './context';

const CHOICES: { value: ConflictChoice; label: string }[] = [
  { value: 'local', label: 'Mine' },
  { value: 'remote', label: 'Theirs' },
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
            return <ConflictCard key={`${c.driveId}:${c.path}`} conflict={c} driveName={driveName} />;
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
  const merge = useMemo(() => conflict.merge, [conflict]);
  const [choices, setChoices] = useState<Partial<Record<number, ConflictChoice>>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const conflictCount = merge.conflicts.length;
  const allChosen = Object.keys(choices).length === conflictCount;
  let conflictIndex = 0;

  return (
    <div className="card" data-testid="conflict">
      <div className="title">{P.displayName(conflict.path)}</div>
      <div className="small">
        /{conflict.path} · Changed on this device and on {driveName}.
      </div>
      {merge.chunks.map((chunk, i) => {
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
            <div className="side-label">Change {index + 1} · This device</div>
            <pre className="local">{joined(chunk.local) || ' '}</pre>
            <div className="side-label">{driveName}</div>
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
        {conflictCount > 0 && (
          <button
            className="filled"
            disabled={!allChosen || state.running}
            onClick={() => void sync.resolve(conflict, { kind: 'merged', text: merge.text(choices) })}
          >
            Save merge
          </button>
        )}
        <button className="outlined" disabled={state.running} onClick={() => setEditing(merge.text(choices))}>
          Edit merged
        </button>
        <button disabled={state.running} onClick={() => void sync.resolve(conflict, { kind: 'keepLocal' })}>
          Keep mine
        </button>
        <button disabled={state.running} onClick={() => void sync.resolve(conflict, { kind: 'keepRemote' })}>
          Keep theirs
        </button>
        <button disabled={state.running} onClick={() => void sync.resolve(conflict, { kind: 'keepBoth' })}>
          Keep both files
        </button>
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
                  void sync.resolve(conflict, { kind: 'merged', text: editing });
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
