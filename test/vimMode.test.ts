import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadVimMode, saveVimMode, VIM_MODE_SETTING } from '../src/renderer/src/data/vimMode';
import { deleteLocalData, openDatabase, Settings, type Db } from '../src/renderer/src/data/db';

let db: Db;
let counter = 0;

beforeEach(async () => {
  db = await openDatabase({
    name: `vim-setting-${++counter}`,
    key: crypto.getRandomValues(new Uint8Array(32)),
  });
});

describe('vim mode setting', () => {
  it('is off by default and persists on the device', async () => {
    const settings = new Settings(db);
    expect(await loadVimMode(settings)).toBe(false);
    await saveVimMode(settings, true);
    expect(await loadVimMode(new Settings(db))).toBe(true);
    await saveVimMode(settings, false);
    expect(await loadVimMode(settings)).toBe(false);
  });

  it('treats anything but true as off', async () => {
    const settings = new Settings(db);
    await settings.set(VIM_MODE_SETTING, 'true');
    expect(await loadVimMode(settings)).toBe(false);
  });

  it('is an app setting kept when the local data is deleted', async () => {
    const settings = new Settings(db);
    await saveVimMode(settings, true);
    await deleteLocalData(db);
    expect(await loadVimMode(settings)).toBe(true);
  });
});
