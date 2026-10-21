declare const __DROPBOX_APP_KEY__: string | undefined;
declare const __MSAL_CLIENT_ID__: string | undefined;
declare const __MARKNOTES_PRERELEASE__: boolean | undefined;

/** Public OAuth registration IDs shared with Android, not client secrets. Environment/build values override them. */
export const DROPBOX_APP_KEY: string =
  process.env.DROPBOX_APP_KEY ||
  (typeof __DROPBOX_APP_KEY__ === 'string' ? __DROPBOX_APP_KEY__ : '') ||
  'sdjefhss3elcfp3';

export const MSAL_CLIENT_ID: string =
  process.env.MSAL_CLIENT_ID ||
  (typeof __MSAL_CLIENT_ID__ === 'string' ? __MSAL_CLIENT_ID__ : '') ||
  'eb2e8605-a611-4b3d-a087-31a9c2ae4945';

/** Whether this build was published as a GitHub pre-release (release.yml sets MARKNOTES_PRERELEASE). */
export const PRERELEASE_BUILD: boolean =
  typeof __MARKNOTES_PRERELEASE__ === 'boolean' ? __MARKNOTES_PRERELEASE__ : false;

export const PROTON_APP_VERSION = 'external-drive-marknotes@0.1.0-alpha';
