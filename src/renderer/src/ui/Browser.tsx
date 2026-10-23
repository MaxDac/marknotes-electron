import { useCallback, useEffect, useMemo, useState } from 'react';
import { isChordSequence } from '../../../shared/chords';
import type { NoteEntry } from '../../../shared/noteStore';
import * as P from '../../../shared/paths';
import logo from '../../../../branding/marknotes-mark.svg';
import type { Page } from '../App';
import { ConfirmDialog, Dialog, NameDialog } from './Dialog';
import { NoteEditor } from './ChordEditor';
import { errorMessage, useApp, useNotesVersion, useSyncState } from './context';

type DialogState =
  | { kind: 'newNote' }
  | { kind: 'newChords' }
  | { kind: 'newFolder' }
  | { kind: 'rename'; entry: NoteEntry }
  | { kind: 'delete'; entry: NoteEntry }
  | { kind: 'move'; entry: NoteEntry };

/** Folders sorted as a tree: case-insensitive, segment by segment. */
const treeOrder = (a: string, b: string) => {
  const left = a.split('/');
  const right = b.split('/');
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const c = left[i].localeCompare(right[i], undefined, { sensitivity: 'accent' });
    if (c !== 0) return c;
  }
  return left.length - right.length;
};

const formatDate = (millis: number) =>
  new Date(millis).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

export function Browser(props: { navigate(page: Page): void; hidden: boolean }) {
  const { notes, sync } = useApp();
  const syncState = useSyncState();
  const version = useNotesVersion();
  const [folder, setFolder] = useState('');
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [entries, setEntries] = useState<NoteEntry[]>([]);
  const [chordPaths, setChordPaths] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [menu, setMenu] = useState<{ entry: NoteEntry; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const exists = folder === '' || (await notes.isFolder(folder));
      if (!exists) {
        if (!cancelled) setFolder('');
        return;
      }
      const [list, all] = await Promise.all([notes.list(folder), notes.listFolders()]);
      if (cancelled) return;
      setEntries(list);
      const chordFlags = await Promise.all(
        list.map((e) => (e.isFolder ? false : notes.read(e.path).then(isChordSequence, () => false))),
      );
      if (cancelled) return;
      setChordPaths(new Set(list.filter((_, i) => chordFlags[i]).map((e) => e.path)));
      setFolders(all.sort(treeOrder));
      if (openNote && !(await notes.exists(openNote)) && !cancelled) setOpenNote(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [notes, folder, version, openNote]);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      setError(null);
      await action();
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  const visibleFolders = useMemo(
    () => folders.filter((f) => ![...collapsed].some((c) => P.isAncestor(c, f) && c !== '')),
    [folders, collapsed],
  );
  const hasChildren = (path: string) => folders.some((f) => P.parent(f) === path);

  const followMove = (from: string, to: string) => {
    if (openNote && (openNote === from || P.isAncestor(from, openNote))) {
      setOpenNote(to + openNote.substring(from.length));
    }
    if (folder === from || P.isAncestor(from, folder)) setFolder(to + folder.substring(from.length));
  };

  const createActions = (testIdPrefix: string) => (
    <div className="empty-actions">
      <button
        className="filled"
        data-testid={`${testIdPrefix}-new-note`}
        onClick={() => setDialog({ kind: 'newNote' })}
      >
        New note
      </button>
      <button data-testid={`${testIdPrefix}-new-chords`} onClick={() => setDialog({ kind: 'newChords' })}>
        New chord sequence
      </button>
    </div>
  );

  return (
    <div className="app" style={props.hidden ? { display: 'none' } : undefined}>
      <div className="topbar">
        <h1>
          <img src={logo} alt="" className="logo" />
          MarkNotes
        </h1>
        <button className="filled" data-testid="new-note" onClick={() => setDialog({ kind: 'newNote' })}>
          New note
        </button>
        <button data-testid="new-chords" onClick={() => setDialog({ kind: 'newChords' })}>
          New chord sequence
        </button>
        <button onClick={() => setDialog({ kind: 'newFolder' })}>New folder</button>
        <div className="spacer" />
        {syncState.conflicts.length > 0 && (
          <button className="danger" onClick={() => props.navigate('conflicts')}>
            Sync conflicts<span className="badge">{syncState.conflicts.length}</span>
          </button>
        )}
        {syncState.drives.length > 0 && (
          <button disabled={syncState.running} onClick={() => void sync.syncNow()}>
            {syncState.running ? 'Syncing…' : 'Sync now'}
          </button>
        )}
        <button onClick={() => props.navigate('settings')}>Settings</button>
      </div>
      {(syncState.message || error) && (
        <div className="status" data-testid="status">
          {error ? <span className="error">{error}</span> : syncState.message}
        </div>
      )}
      <div className="main">
        <nav className="sidebar" aria-label="Folders">
          <h2>Folders</h2>
          <div className={`tree-row ${folder === '' ? 'current' : ''}`} onClick={() => setFolder('')}>
            <span className="toggle" />
            <span className="label">All notes</span>
          </div>
          {visibleFolders.map((f) => {
            const expandable = hasChildren(f);
            const isCollapsed = collapsed.has(f);
            return (
              <div
                key={f}
                className={`tree-row ${folder === f ? 'current' : ''}`}
                style={{ paddingLeft: 4 + (P.depth(f) - 1) * 14 }}
                onClick={() => setFolder(f)}
                title={f}
              >
                <span
                  className="toggle"
                  role={expandable ? 'button' : undefined}
                  aria-label={expandable ? (isCollapsed ? 'Expand' : 'Collapse') : undefined}
                  onClick={(e) => {
                    if (!expandable) return;
                    e.stopPropagation();
                    const next = new Set(collapsed);
                    if (isCollapsed) next.delete(f);
                    else next.add(f);
                    setCollapsed(next);
                  }}
                >
                  {expandable ? (isCollapsed ? '▸' : '▾') : ''}
                </span>
                <span className="label">📁 {P.name(f)}</span>
              </div>
            );
          })}
        </nav>
        <section className="list" aria-label="Notes">
          <div className="list-header">
            {folder !== '' && (
              <button className="icon" aria-label="Back" onClick={() => setFolder(P.parent(folder))}>
                ←
              </button>
            )}
            <span className="crumb">{folder === '' ? 'All notes' : P.name(folder)}</span>
          </div>
          <div className="entries">
            {entries.length === 0 && (
              <div className="empty">
                No notes here yet
                {createActions('empty')}
              </div>
            )}
            {entries.map((entry) => (
              <div
                key={entry.path}
                className={`entry ${entry.path === openNote ? 'open' : ''}`}
                data-testid="entry"
                onClick={() => (entry.isFolder ? setFolder(entry.path) : setOpenNote(entry.path))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setMenu({ entry, x: e.clientX, y: e.clientY });
                }}
              >
                <span>{entry.isFolder ? '📁' : chordPaths.has(entry.path) ? '🎸' : '📄'}</span>
                <span className="name">
                  {P.displayName(entry.path)}
                  {!entry.isFolder && <div className="meta">{formatDate(entry.modifiedMillis)}</div>}
                </span>
                <button
                  className="icon"
                  aria-label="More"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ entry, x: r.left, y: r.bottom });
                  }}
                >
                  ⋮
                </button>
              </div>
            ))}
          </div>
        </section>
        {openNote ? (
          <NoteEditor
            key={openNote}
            path={openNote}
            onClose={() => setOpenNote(null)}
            onOpenNote={setOpenNote}
          />
        ) : (
          <div className="editor-pane">
            <div className="empty">
              Select a note or create a new one.
              {createActions('pane')}
            </div>
          </div>
        )}
      </div>

      {menu && (
        <div className="backdrop" style={{ background: 'transparent' }} onMouseDown={() => setMenu(null)}>
          <div
            className="menu"
            role="menu"
            style={{
              left: Math.min(menu.x, window.innerWidth - 160),
              top: Math.min(menu.y, window.innerHeight - 130),
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {(['rename', 'move', 'delete'] as const).map((kind) => (
              <button
                key={kind}
                role="menuitem"
                onClick={() => {
                  setDialog({ kind, entry: menu.entry });
                  setMenu(null);
                }}
              >
                {kind === 'rename' ? 'Rename' : kind === 'move' ? 'Move to…' : 'Delete'}
              </button>
            ))}
          </div>
        </div>
      )}

      {dialog?.kind === 'newNote' && (
        <NameDialog
          title="New note"
          confirm="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => setOpenNote(await notes.createNote(folder, name.trim()))}
        />
      )}
      {dialog?.kind === 'newChords' && (
        <NameDialog
          title="New chord sequence"
          confirm="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => setOpenNote(await notes.createChordSequence(folder, name.trim()))}
        />
      )}
      {dialog?.kind === 'newFolder' && (
        <NameDialog
          title="New folder"
          confirm="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            await notes.createChildFolder(folder, name.trim());
          }}
        />
      )}
      {dialog?.kind === 'rename' && (
        <NameDialog
          title="Rename"
          confirm="Rename"
          initial={P.displayName(dialog.entry.path)}
          onClose={() => setDialog(null)}
          onSubmit={async (name) => {
            const from = dialog.entry.path;
            followMove(from, await notes.rename(from, name.trim()));
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Delete ${P.displayName(dialog.entry.path)}?`}
          message={
            dialog.entry.isFolder
              ? 'The folder and all its notes will be deleted.'
              : 'The note will be deleted.'
          }
          confirm="Delete"
          danger
          onClose={() => setDialog(null)}
          onConfirm={() => void run(() => notes.delete(dialog.entry.path))}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          entry={dialog.entry}
          folders={folders}
          onClose={() => setDialog(null)}
          onMove={(target) =>
            void run(async () => {
              const from = dialog.entry.path;
              followMove(from, await notes.move(from, target));
            })
          }
        />
      )}
    </div>
  );
}

function MoveDialog(props: {
  entry: NoteEntry;
  folders: string[];
  onMove(target: string): void;
  onClose(): void;
}) {
  const { entry } = props;
  const targets = [''].concat(
    props.folders.filter((f) => !(entry.isFolder && (f === entry.path || P.isAncestor(entry.path, f)))),
  );
  return (
    <Dialog
      title={`Move ${P.displayName(entry.path)} to`}
      onClose={props.onClose}
      actions={<button onClick={props.onClose}>Cancel</button>}
    >
      <div className="folder-picker">
        {targets.map((t) => (
          <div
            key={t}
            className="entry"
            style={{
              paddingLeft: 10 + Math.max(0, P.depth(t) - 1) * 14,
              opacity: t === P.parent(entry.path) ? 0.5 : 1,
            }}
            onClick={() => {
              if (t === P.parent(entry.path)) return;
              props.onMove(t);
              props.onClose();
            }}
          >
            {t === '' ? 'All notes' : `📁 ${P.name(t)}`}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
