import { useEffect, useMemo, useState } from 'react';
import { NoteStore } from '../../shared/noteStore';
import { api, unwrap } from './data/api';
import { loadChordSequencesEnabled, saveChordSequencesEnabled } from './data/chordSequences';
import { IdbNodeBackend, openDatabase, Settings } from './data/db';
import { SyncManager } from './data/syncManager';
import { AddDrive } from './ui/AddDrive';
import { Browser } from './ui/Browser';
import { Conflicts } from './ui/Conflicts';
import { AppContext, errorMessage, type AppServices } from './ui/context';
import { SettingsPage } from './ui/SettingsPage';
import { applyTheme, type ThemeColor, type ThemeMode } from './ui/theme';
import { UpdateBanner } from './ui/UpdateBanner';

export type Page = 'notes' | 'settings' | 'addDrive' | 'conflicts';

interface Loaded {
  notes: NoteStore;
  sync: SyncManager;
  settings: Settings;
  mode: ThemeMode;
  color: ThemeColor;
  chordSequences: boolean;
}

async function load(): Promise<Loaded> {
  const db = await openDatabase();
  const settings = new Settings(db);
  const notes = new NoteStore(new IdbNodeBackend(db));
  const deviceId = await unwrap(api().deviceId());
  const sync = new SyncManager(notes, db, settings, deviceId);
  await sync.init();
  return {
    notes,
    sync,
    settings,
    mode: await settings.get<ThemeMode>('themeMode', 'system'),
    color: await settings.get<ThemeColor>('themeColor', 'blue'),
    chordSequences: await loadChordSequencesEnabled(settings),
  };
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

export function App() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [theme, setThemeState] = useState<{ mode: ThemeMode; color: ThemeColor }>({
    mode: 'system',
    color: 'blue',
  });
  const [systemDark, setSystemDark] = useState(darkQuery.matches);
  const [page, setPage] = useState<Page>('notes');
  const [chordSequences, setChordSequencesState] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load().then(
      (l) => {
        if (cancelled) return;
        setLoaded(l);
        setThemeState({ mode: l.mode, color: l.color });
        setChordSequencesState(l.chordSequences);
        l.sync.syncIfConnected();
      },
      (e) => setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const listener = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    darkQuery.addEventListener('change', listener);
    return () => darkQuery.removeEventListener('change', listener);
  }, []);

  useEffect(() => applyTheme(theme.mode, theme.color, systemDark), [theme, systemDark]);

  const services = useMemo<AppServices | null>(
    () =>
      loaded && {
        notes: loaded.notes,
        sync: loaded.sync,
        settings: loaded.settings,
        theme,
        setTheme(mode, color) {
          setThemeState({ mode, color });
          void loaded.settings.set('themeMode', mode);
          void loaded.settings.set('themeColor', color);
        },
        chordSequences,
        setChordSequences(enabled) {
          setChordSequencesState(enabled);
          void saveChordSequencesEnabled(loaded.settings, enabled);
        },
      },
    [loaded, theme, chordSequences],
  );

  if (error) return <div className="empty error">Could not open the notes: {error}</div>;
  if (!services) return <div className="empty">Loading…</div>;

  return (
    <AppContext.Provider value={services}>
      <div className="app">
        <UpdateBanner />
        <Browser navigate={setPage} hidden={page !== 'notes'} />
        {page === 'settings' && <SettingsPage navigate={setPage} />}
        {page === 'addDrive' && <AddDrive onDone={() => setPage('settings')} />}
        {page === 'conflicts' && <Conflicts onBack={() => setPage('notes')} />}
      </div>
    </AppContext.Provider>
  );
}
