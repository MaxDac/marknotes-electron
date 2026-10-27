import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { isChordSequence } from '../../../shared/chords';
import type { NoteEntry } from '../../../shared/noteStore';
import * as P from '../../../shared/paths';
import logo from '../../../../branding/marknotes-mark.svg';
import type { Page } from '../App';
import { openNoteDecision } from '../data/chordSequences';
import { ConfirmDialog, Dialog, NameDialog } from './Dialog';
import { NoteEditor } from './ChordEditor';
import { errorMessage, useApp, useNotesVersion, useSyncState } from './context';
import { ImportDialog, type ImportRequest } from './ImportDialog';
import { kindOf } from '../../../shared/importing/prepareImport';
import { Icon } from './icons';

type DialogState =
  | { kind: 'newNote' }
  | { kind: 'newChords' }
  | { kind: 'newFolder' }
  | { kind: 'rename'; entry: NoteEntry }
  | { kind: 'delete'; entry: NoteEntry }
  | { kind: 'move'; entry: NoteEntry }
  | { kind: 'enableChords'; path: string }
  | { kind: 'import'; request: ImportRequest | null };

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

/** Indent of a tree row: the web app uses 16px per level. */
const indent = (depth: number) => ({ paddingLeft: depth * 16 });

export function Browser(props: {
  navigate(page: Page): void;
  hidden: boolean;
  onBlockingChange(blocked: boolean): void;
}) {
  const { notes, sync, chordSequences, setChordSequences } = useApp();
  const syncState = useSyncState();
  const folderNotices = syncState.drives.reduce((n, d) => n + d.folderNotices.length, 0);
  const version = useNotesVersion();
  const [folder, setFolder] = useState('');
  const [openNote, setOpenNote] = useState<string | null>(null);
  const [notesByFolder, setNotesByFolder] = useState<Record<string, NoteEntry[]>>({});
  const [chordPaths, setChordPaths] = useState<Set<string>>(new Set());
  const [folders, setFolders] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [menu, setMenu] = useState<{ entry: NoteEntry; x: number; y: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const chordCache = useRef(new Map<string, { modified: number; chord: boolean }>());
  const { onBlockingChange } = props;

  useEffect(() => onBlockingChange(dialog !== null || menu !== null), [dialog, menu, onBlockingChange]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const exists = folder === '' || (await notes.isFolder(folder));
      if (!exists) {
        if (!cancelled) setFolder('');
        return;
      }
      const all = (await notes.listFolders()).sort(treeOrder);
      const lists = await Promise.all(
        ['', ...all].map(
          async (f) => [f, (await notes.list(f)).filter((e) => !e.isFolder)] as [string, NoteEntry[]],
        ),
      );
      if (cancelled) return;
      const cache = chordCache.current;
      const flags = new Set<string>();
      await Promise.all(
        lists
          .flatMap(([, list]) => list)
          .map(async (e) => {
            let known = cache.get(e.path);
            if (known?.modified !== e.modifiedMillis) {
              known = {
                modified: e.modifiedMillis,
                chord: await notes.read(e.path).then(isChordSequence, () => false),
              };
              cache.set(e.path, known);
            }
            if (known.chord) flags.add(e.path);
          }),
      );
      if (cancelled) return;
      setNotesByFolder(Object.fromEntries(lists));
      setChordPaths(flags);
      setFolders(all);
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

  const followMove = (from: string, to: string) => {
    if (openNote && (openNote === from || P.isAncestor(from, openNote))) {
      setOpenNote(to + openNote.substring(from.length));
    }
    if (folder === from || P.isAncestor(from, folder)) setFolder(to + folder.substring(from.length));
  };

  /** Opens a note, first asking to enable chord sequences when it is one and the setting is off. */
  const requestOpen = useCallback(
    async (path: string) => {
      const text = chordSequences ? '' : await notes.read(path).catch(() => '');
      if (openNoteDecision(text, chordSequences) === 'ask') setDialog({ kind: 'enableChords', path });
      else setOpenNote(path);
    },
    [notes, chordSequences],
  );

  const createActions = (testIdPrefix: string) => (
    <div className="empty-actions">
      <button
        className="btn btn-solid"
        data-testid={`${testIdPrefix}-new-note`}
        onClick={() => setDialog({ kind: 'newNote' })}
      >
        <Icon name="plus" />
        New note
      </button>
      {chordSequences && (
        <button
          className="btn btn-outline"
          data-testid={`${testIdPrefix}-new-chords`}
          onClick={() => setDialog({ kind: 'newChords' })}
        >
          <Icon name="chords" />
          New chord sequence
        </button>
      )}
    </div>
  );

  const toggleCollapsed = (path: string) => {
    const next = new Set(collapsed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
  };

  const openMenu = (entry: NoteEntry, x: number, y: number) => setMenu({ entry, x, y });

  const moreButton = (entry: NoteEntry) => (
    <button
      className="btn btn-icon row-more"
      aria-label="More"
      title="More"
      onClick={(e) => {
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(entry, r.left, r.bottom);
      }}
    >
      <Icon name="more" />
    </button>
  );

  /** The folders and notes inside `parent`: folders first, as the tree of the web app. */
  const renderLevel = (parent: string, depth: number): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (const f of folders.filter((g) => P.parent(g) === parent)) {
      const expandable = folders.some((g) => P.parent(g) === f) || (notesByFolder[f] ?? []).length > 0;
      const isCollapsed = collapsed.has(f);
      const entry: NoteEntry = { path: f, isFolder: true, modifiedMillis: 0, size: 0 };
      rows.push(
        <div
          key={`folder:${f}`}
          className={`tree-row ${folder === f ? 'current' : ''}`}
          data-testid="entry"
          style={indent(depth)}
          onClick={() => setFolder(f)}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(entry, e.clientX, e.clientY);
          }}
          title={f}
        >
          <span
            className="expander"
            role={expandable ? 'button' : undefined}
            aria-label={expandable ? (isCollapsed ? 'Expand' : 'Collapse') : undefined}
            aria-expanded={expandable ? !isCollapsed : undefined}
            onClick={(e) => {
              if (!expandable) return;
              e.stopPropagation();
              toggleCollapsed(f);
            }}
          >
            {expandable && <Icon name="chevron" />}
          </span>
          <span className="icon-slot">
            <Icon name="folder" />
          </span>
          <span className="label">{P.name(f)}</span>
          {moreButton(entry)}
        </div>,
      );
      if (!isCollapsed) rows.push(...renderLevel(f, depth + 1));
    }
    for (const entry of notesByFolder[parent] ?? []) {
      const chords = chordPaths.has(entry.path);
      rows.push(
        <div
          key={`note:${entry.path}`}
          className={`entry ${entry.path === openNote ? 'open' : ''}`}
          data-testid="entry"
          data-kind={chords ? 'chords' : 'note'}
          style={indent(depth)}
          title={formatDate(entry.modifiedMillis)}
          onClick={() => {
            setDrawer(false);
            void requestOpen(entry.path);
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            openMenu(entry, e.clientX, e.clientY);
          }}
        >
          <span className="expander" />
          <span className="icon-slot">
            <Icon name={chords ? 'chords' : 'file'} />
          </span>
          <span className="label">{P.displayName(entry.path)}</span>
          {moreButton(entry)}
        </div>,
      );
    }
    return rows;
  };

  const noteCount = Object.values(notesByFolder).reduce((n, list) => n + list.length, 0);
  const breadcrumb = openNote
    ? [...P.parent(openNote).split('/').filter(Boolean), P.displayName(openNote)].join(' / ')
    : folder === ''
      ? 'All notes'
      : P.name(folder);

  return (
    <div
      className="app browser"
      style={props.hidden ? { display: 'none' } : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDropCapture={(e) => {
        // An open dialog handles its own drops (the import dialog imports them).
        if (dialog !== null) return;
        const files = [...e.dataTransfer.files];
        if (files.length === 0) return;
        const images = files.every((f) => kindOf(f.type, f.name) === 'image');
        // Images dropped on the editor are inserted into the open note.
        if (images && (e.target as HTMLElement).closest('.cm-editor')) return;
        e.preventDefault();
        e.stopPropagation();
        setDialog({ kind: 'import', request: { files, clipboard: null } });
      }}
    >
      <div className={`main ${drawer ? 'sidebar-open' : ''}`}>
        <aside className="sidebar">
          <div className="brand">
            <img src={logo} alt="" className="logo" />
            <h1 className="wordmark">MarkNotes</h1>
          </div>
          <button
            className="btn btn-solid btn-new"
            data-testid="new-note"
            data-tour="new-note"
            onClick={() => setDialog({ kind: 'newNote' })}
          >
            <Icon name="plus" />
            New note
          </button>
          <div className="sidebar-actions">
            {chordSequences && (
              <button
                className="btn btn-ghost nav-item"
                data-testid="new-chords"
                onClick={() => setDialog({ kind: 'newChords' })}
              >
                <Icon name="chords" />
                <span>New chord sequence</span>
              </button>
            )}
            <button className="btn btn-ghost nav-item" onClick={() => setDialog({ kind: 'newFolder' })}>
              <Icon name="folder" />
              <span>New folder</span>
            </button>
            <button
              className="btn btn-ghost nav-item"
              data-testid="import"
              data-tour="import"
              onClick={() => setDialog({ kind: 'import', request: null })}
            >
              <Icon name="import" />
              <span>Import…</span>
            </button>
          </div>
          <nav className="tree" aria-label="Folders" data-tour="folders">
            <div className={`tree-row ${folder === '' ? 'current' : ''}`} onClick={() => setFolder('')}>
              <span className="expander" />
              <span className="icon-slot">
                <Icon name="notes" />
              </span>
              <span className="label">All notes</span>
            </div>
            {renderLevel('', 0)}
            {noteCount === 0 && folders.length === 0 && (
              <div className="empty tree-empty">
                No notes here yet
                {createActions('empty')}
              </div>
            )}
          </nav>
          <div className="drives">
            <div className="section-title">Drives</div>
            {syncState.drives.map((d) => (
              <div
                key={d.account.id}
                className="drive-row"
                title={d.unavailableReason ?? d.message ?? d.account.label}
              >
                <span className={`cloud-badge ${d.unavailableReason ? 'warn' : ''}`}>
                  <Icon name="cloud" />
                </span>
                <span className="label">{d.account.label}</span>
              </div>
            ))}
            {syncState.drives.length === 0 && (
              <div className="small hint">Your notes are stored on this device only.</div>
            )}
            <button
              className="btn btn-ghost connect-item nav-item"
              onClick={() => props.navigate('addDrive')}
            >
              <Icon name="plug" />
              <span>Connect a drive</span>
            </button>
          </div>
        </aside>
        {drawer && <div className="scrim" onClick={() => setDrawer(false)} />}
        <div className="content">
          <div className="topbar">
            <button
              className="btn btn-icon menu-toggle"
              aria-label="Show folders"
              title="Show folders"
              onClick={() => setDrawer(true)}
            >
              <Icon name="menu" />
            </button>
            <div className="breadcrumb">{breadcrumb}</div>
            {(syncState.message || error) && (
              <div className="status" data-testid="status">
                {error ? <span className="error">{error}</span> : syncState.message}
              </div>
            )}
            <div className="top-actions">
              {syncState.conflicts.length > 0 && (
                <button className="btn btn-outline danger" onClick={() => props.navigate('conflicts')}>
                  <Icon name="alert" />
                  Sync conflicts<span className="badge">{syncState.conflicts.length}</span>
                </button>
              )}
              {folderNotices > 0 && (
                <button
                  className="btn btn-outline"
                  data-testid="folder-notices"
                  onClick={() => props.navigate('settings')}
                >
                  Folders to remove<span className="badge">{folderNotices}</span>
                </button>
              )}
              {syncState.drives.length > 0 && (
                <button
                  className="btn btn-outline"
                  disabled={syncState.running}
                  onClick={() => void sync.syncNow()}
                >
                  <Icon name="refresh" />
                  {syncState.running ? 'Syncing…' : 'Sync now'}
                </button>
              )}
              <button
                className="btn btn-icon"
                aria-label="Settings"
                title="Settings"
                data-tour="settings"
                onClick={() => props.navigate('settings')}
              >
                <Icon name="sliders" />
              </button>
              <button
                className="btn btn-outline"
                data-tour="help"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => props.navigate('help')}
              >
                <Icon name="help" />
                Help
              </button>
            </div>
          </div>
          {openNote ? (
            <NoteEditor
              key={openNote}
              path={openNote}
              onClose={() => setOpenNote(null)}
              onOpenNote={(path) => void requestOpen(path)}
            />
          ) : (
            <div className="editor-pane">
              <div className="empty empty-state">
                <div className="empty-art">
                  <Icon name="notes" />
                </div>
                <h2>Choose or create a note</h2>
                <p>Select a note in the sidebar, or start a new one.</p>
                {createActions('pane')}
              </div>
            </div>
          )}
        </div>
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
      {dialog?.kind === 'enableChords' && (
        <ConfirmDialog
          title="Enable chord sequences?"
          message={`“${P.displayName(dialog.path)}” is a chord sequence, and chord sequences are turned off. Turn them on in Settings and open it?`}
          confirm="Enable"
          onClose={() => setDialog(null)}
          onConfirm={() => {
            setChordSequences(true);
            setOpenNote(dialog.path);
          }}
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
      {dialog?.kind === 'import' && (
        <ImportDialog
          request={dialog.request}
          folder={folder}
          folders={folders}
          onClose={() => setDialog(null)}
          onImported={(path) => {
            setFolder(P.parent(path));
            void requestOpen(path);
          }}
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
            <Icon name={t === '' ? 'notes' : 'folder'} />
            {t === '' ? 'All notes' : P.name(t)}
          </div>
        ))}
      </div>
    </Dialog>
  );
}
