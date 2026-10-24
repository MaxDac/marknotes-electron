import { useEffect, useMemo, useState } from 'react';
import type { LockStatus } from '../../preload/api';
import { NoteStore } from '../../shared/noteStore';
import { api, unwrap } from './data/api';
import { loadChordSequencesEnabled, saveChordSequencesEnabled } from './data/chordSequences';
import { IdbNodeBackend, openDatabase, Settings } from './data/db';
import { SyncManager } from './data/syncManager';
import { AddDrive } from './ui/AddDrive';
import { Browser } from './ui/Browser';
import { Conflicts } from './ui/Conflicts';
import { LockScreen } from './ui/LockScreen';
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
  idleMinutes: number;
}

async function load(): Promise<Loaded> {
  const key = await unwrap(api().localKey());
  const db = await openDatabase({ key, rotateKey: () => unwrap(api().resetLocalKey()) });
  key.fill(0);
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
    idleMinutes: await settings.get<number>('lockIdleMinutes', DEFAULT_IDLE_MINUTES),
  };
}

export const DEFAULT_IDLE_MINUTES = 15;
const ACTIVITY_EVENTS = ['keydown', 'mousedown', 'mousemove', 'wheel', 'touchstart'] as const;

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
  const [lock, setLock] = useState<LockStatus | null>(null);
  const [idleMinutes, setIdleMinutesState] = useState(DEFAULT_IDLE_MINUTES);
  const unlocked = lock?.state === 'unlocked';

  useEffect(() => {
    unwrap(api().lockStatus()).then(setLock, (e) => setError(errorMessage(e)));
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    let cancelled = false;
    load().then(
      (l) => {
        if (cancelled) return;
        setLoaded(l);
        setThemeState({ mode: l.mode, color: l.color });
        setChordSequencesState(l.chordSequences);
        setIdleMinutesState(l.idleMinutes);
        l.sync.syncIfConnected();
      },
      (e) => setError(errorMessage(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [unlocked]);

  // Locked by the main process (idle, sleep, screen lock): save pending edits, then reload to the lock screen.
  useEffect(() => {
    if (!loaded) return;
    return api().onLocked(() => {
      void loaded.sync.flushPending().finally(() => window.location.reload());
    });
  }, [loaded]);

  useEffect(() => {
    if (!loaded || !lock?.enabled || idleMinutes <= 0) return;
    let timer: ReturnType<typeof setTimeout>;
    const restart = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void api().lockNow(), idleMinutes * 60_000);
    };
    restart();
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, restart, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, restart);
    };
  }, [loaded, lock?.enabled, idleMinutes]);

  useEffect(() => {
    const listener = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    darkQuery.addEventListener('change', listener);
    return () => darkQuery.removeEventListener('change', listener);
  }, []);

  useEffect(() => applyTheme(theme.mode, theme.color, systemDark), [theme, systemDark]);

  const services = useMemo<AppServices | null>(
    () =>
      loaded &&
      lock && {
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
        lock,
        setLock,
        idleMinutes,
        setIdleMinutes(minutes) {
          setIdleMinutesState(minutes);
          void loaded.settings.set('lockIdleMinutes', minutes);
        },
      },
    [loaded, theme, lock, idleMinutes, chordSequences],
  );

  if (error) return <div className="empty error">Could not open the notes: {error}</div>;
  if (lock && !unlocked) return <LockScreen status={lock} onUnlocked={setLock} />;
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
