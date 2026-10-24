import { isChordSequence } from '../../../shared/chords';
import type { Settings } from './db';

/**
 * Settings key of the "Chord sequences" switch. Off by default and stored on this device only: it is never synced or
 * written to the drive, and it never changes notes.
 */
export const CHORD_SEQUENCES_SETTING = 'chordSequences';

export async function loadChordSequencesEnabled(settings: Settings): Promise<boolean> {
  return (await settings.get<unknown>(CHORD_SEQUENCES_SETTING, false)) === true;
}

export async function saveChordSequencesEnabled(settings: Settings, enabled: boolean): Promise<void> {
  await settings.set(CHORD_SEQUENCES_SETTING, enabled);
}

/**
 * Whether a note can be opened right away (`open`) or the user must first be asked to enable chord sequences
 * (`ask`): only chord sequences need the setting.
 */
export function openNoteDecision(text: string, chordSequencesEnabled: boolean): 'open' | 'ask' {
  return !chordSequencesEnabled && isChordSequence(text) ? 'ask' : 'open';
}
