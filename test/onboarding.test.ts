import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { IdbNodeBackend, openDatabase, Settings } from '../src/renderer/src/data/db';
import { NoteStore } from '../src/shared/noteStore';
import {
  handleOnboarding,
  loadOnboardingHandled,
  ONBOARDING_SETTING,
} from '../src/renderer/src/data/onboarding';

describe('device-local onboarding', () => {
  it('offers the guide for both new and existing profiles without a handled flag', async () => {
    const get = async <T>(_key: string, fallback: T) => fallback;
    expect(await loadOnboardingHandled({ get })).toBe(false);
  });

  it('does not accept malformed values as a handled guide', async () => {
    for (const value of [false, undefined, null, 'true', 1, {}]) {
      const get = async <T>() => value as T;
      expect(await loadOnboardingHandled({ get })).toBe(false);
    }
  });

  it('offers the guide to an existing profile without touching its notes', async () => {
    const name = `existing-${crypto.randomUUID()}`;
    const db = await openDatabase({
      name,
      legacyName: `${name}-legacy`,
      key: crypto.getRandomValues(new Uint8Array(32)),
    });
    const notes = new NoteStore(new IdbNodeBackend(db));
    await notes.write('Existing.md', 'Leave my draft alone');
    expect(await loadOnboardingHandled(new Settings(db))).toBe(false);
    expect(await notes.read('Existing.md')).toBe('Leave my draft alone');
    expect((await notes.list('')).map((entry) => entry.path)).toEqual(['Existing.md']);
    db.close();
  });

  it('persists only after explicit handling, encrypted across database reopen', async () => {
    const name = `onboarding-${crypto.randomUUID()}`;
    const key = crypto.getRandomValues(new Uint8Array(32));
    const db = await openDatabase({ name, legacyName: `${name}-legacy`, key });
    const settings = new Settings(db);
    expect(await loadOnboardingHandled(settings)).toBe(false);
    expect(await db.getAll('nodes')).toEqual([]);
    await handleOnboarding(settings);
    expect(await loadOnboardingHandled(settings)).toBe(true);
    const raw = await db.idb.getAll('settings');
    expect(JSON.stringify(raw)).not.toContain(ONBOARDING_SETTING);
    db.close();
    const reopened = await openDatabase({ name, legacyName: `${name}-legacy`, key });
    expect(await loadOnboardingHandled(new Settings(reopened))).toBe(true);
    expect(await reopened.getAll('nodes')).toEqual([]);
    reopened.close();
  });

  it('surfaces read and write errors rather than treating them as handled', async () => {
    const error = new Error('storage unavailable');
    await expect(
      loadOnboardingHandled({
        get: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow(error);
    await expect(
      handleOnboarding({
        set: async () => {
          throw error;
        },
      }),
    ).rejects.toThrow(error);
  });
});
