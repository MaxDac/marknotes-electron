import { createContext, useContext, useEffect, useState } from 'react';
import type { LockStatus } from '../../../preload/api';
import type { NoteStore } from '../../../shared/noteStore';
import type { Settings } from '../data/db';
import type { SyncManager, SyncState } from '../data/syncManager';
import type { ThemeColor, ThemeMode } from './theme';

export interface AppServices {
  notes: NoteStore;
  sync: SyncManager;
  settings: Settings;
  theme: { mode: ThemeMode; color: ThemeColor };
  setTheme(mode: ThemeMode, color: ThemeColor): void;
  /** The "Chord sequences" setting: creating chord sequences is offered only when it is on. */
  chordSequences: boolean;
  setChordSequences(enabled: boolean): void;
  lock: LockStatus;
  setLock(status: LockStatus): void;
  /** Minutes without activity before the app locks (0: never); only used with the app lock. */
  idleMinutes: number;
  setIdleMinutes(minutes: number): void;
}

export const AppContext = createContext<AppServices | null>(null);

export function useApp(): AppServices {
  const app = useContext(AppContext);
  if (!app) throw new Error('AppContext missing');
  return app;
}

export function useSyncState(): SyncState {
  const { sync } = useApp();
  const [state, setState] = useState(sync.current);
  useEffect(() => sync.subscribe(setState), [sync]);
  return state;
}

/** Bumps whenever the note tree changes, to re-read derived data. */
export function useNotesVersion(): number {
  const { notes } = useApp();
  const [version, setVersion] = useState(0);
  useEffect(() => notes.onChange(() => setVersion((v) => v + 1)), [notes]);
  return version;
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
