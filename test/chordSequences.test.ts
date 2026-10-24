import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { newChordSequenceContent } from '../src/shared/chords';
import {
  CHORD_SEQUENCES_SETTING,
  loadChordSequencesEnabled,
  openNoteDecision,
  saveChordSequencesEnabled,
} from '../src/renderer/src/data/chordSequences';
import { deleteLocalData, openDatabase, Settings, type Db } from '../src/renderer/src/data/db';

let db: Db;
let counter = 0;

beforeEach(async () => {
  db = await openDatabase({
    name: `chord-setting-${++counter}`,
    key: crypto.getRandomValues(new Uint8Array(32)),
  });
});

describe('chord sequences setting', () => {
  it('is off by default and persists on the device', async () => {
    const settings = new Settings(db);
    expect(await loadChordSequencesEnabled(settings)).toBe(false);
    await saveChordSequencesEnabled(settings, true);
    expect(await loadChordSequencesEnabled(new Settings(db))).toBe(true);
    await saveChordSequencesEnabled(settings, false);
    expect(await loadChordSequencesEnabled(settings)).toBe(false);
  });

  it('treats anything but true as off', async () => {
    const settings = new Settings(db);
    await settings.set(CHORD_SEQUENCES_SETTING, 'true');
    expect(await loadChordSequencesEnabled(settings)).toBe(false);
  });

  it('is an app setting kept when the local data is deleted', async () => {
    const settings = new Settings(db);
    await saveChordSequencesEnabled(settings, true);
    await deleteLocalData(db);
    expect(await loadChordSequencesEnabled(settings)).toBe(true);
  });

  it('asks before opening a chord sequence only while the setting is off', () => {
    const chords = newChordSequenceContent('abcdefgh') + '## C (guitar)\nfrets: x 3/3 2/2 0 1/1 0\n';
    expect(openNoteDecision(chords, false)).toBe('ask');
    expect(openNoteDecision(chords, true)).toBe('open');
    expect(openNoteDecision('---\nid: abcdefgh\n---\n# Plain\n', false)).toBe('open');
    expect(openNoteDecision('', false)).toBe('open');
  });
});
