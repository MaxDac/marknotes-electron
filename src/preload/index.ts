import { contextBridge, ipcRenderer } from 'electron';
import type { MarkNotesApi } from './api';

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const api: MarkNotesApi = {
  platform: process.platform,
  deviceId: call('app:deviceId') as MarkNotesApi['deviceId'],
  providers: call('drives:providers') as MarkNotesApi['providers'],
  drives: call('drives:list') as MarkNotesApi['drives'],
  signIn: call('drives:signIn') as MarkNotesApi['signIn'],
  cancelSignIn: call('drives:cancelSignIn') as MarkNotesApi['cancelSignIn'],
  protonLogin: call('drives:protonLogin') as MarkNotesApi['protonLogin'],
  protonTwoFactor: call('drives:protonTwoFactor') as MarkNotesApi['protonTwoFactor'],
  listFolders: call('drives:listFolders') as MarkNotesApi['listFolders'],
  addDrive: call('drives:add') as MarkNotesApi['addDrive'],
  discardSignIn: call('drives:discardSignIn') as MarkNotesApi['discardSignIn'],
  removeDrive: call('drives:remove') as MarkNotesApi['removeDrive'],
  remote: call('remote:op') as MarkNotesApi['remote'],
  openExternal: call('app:openExternal') as MarkNotesApi['openExternal'],
};

if (process.env.MARKNOTES_E2E === '1') {
  api.testRemote = call('test:remote') as NonNullable<MarkNotesApi['testRemote']>;
}

contextBridge.exposeInMainWorld('marknotes', api);
