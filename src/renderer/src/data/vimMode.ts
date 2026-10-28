import type { Settings } from './db';

/**
 * Settings key of the "Vim mode" switch. Off by default and stored on this device only: it is never synced or
 * written to the drive, and it never changes notes.
 */
export const VIM_MODE_SETTING = 'vimMode';

export async function loadVimMode(settings: Settings): Promise<boolean> {
  return (await settings.get<unknown>(VIM_MODE_SETTING, false)) === true;
}

export async function saveVimMode(settings: Settings, enabled: boolean): Promise<void> {
  await settings.set(VIM_MODE_SETTING, enabled);
}
