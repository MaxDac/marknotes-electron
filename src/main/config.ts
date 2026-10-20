declare const __DROPBOX_APP_KEY__: string | undefined;
declare const __MSAL_CLIENT_ID__: string | undefined;

/** Build-time values (electron-vite `define`), overridable through the environment for `npm run dev`. */
export const DROPBOX_APP_KEY: string =
  process.env.DROPBOX_APP_KEY || (typeof __DROPBOX_APP_KEY__ === 'string' ? __DROPBOX_APP_KEY__ : '');

export const MSAL_CLIENT_ID: string =
  process.env.MSAL_CLIENT_ID || (typeof __MSAL_CLIENT_ID__ === 'string' ? __MSAL_CLIENT_ID__ : '');

export const PROTON_APP_VERSION = 'external-drive-marknotes@0.1.0-alpha';
