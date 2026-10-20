import type { DriveProvider } from '../../shared/types';
import { DROPBOX_APP_KEY, MSAL_CLIENT_ID } from '../config';
import { DropboxConnector } from './dropbox';
import { OneDriveConnector } from './onedrive';
import { ProtonConnector } from './proton/connector';
import type { DriveConnector, OpenExternal, SecretVault } from './types';

export interface ConnectorDeps {
  vault: SecretVault;
  openExternal: OpenExternal;
}

/** The real cloud providers. Dropbox and OneDrive need app registrations injected at build time. */
export function createConnectors(deps: ConnectorDeps): Record<DriveProvider, DriveConnector> {
  return {
    proton: new ProtonConnector({ vault: deps.vault }),
    dropbox: new DropboxConnector({
      appKey: DROPBOX_APP_KEY,
      vault: deps.vault,
      openExternal: deps.openExternal,
    }),
    onedrive: new OneDriveConnector({
      clientId: MSAL_CLIENT_ID,
      vault: deps.vault,
      openExternal: deps.openExternal,
    }),
  };
}
