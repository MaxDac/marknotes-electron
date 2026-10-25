import { contextBridge, ipcRenderer } from 'electron';
import type { CaptureProtectionStatus, MarkNotesApi, UpdateStatus } from './api';

const call =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(channel, ...args);

const api: MarkNotesApi = {
  platform: process.platform,
  recordDiagnostic: call('diagnostics:record') as MarkNotesApi['recordDiagnostic'],
  clearDiagnostics: call('diagnostics:clear') as MarkNotesApi['clearDiagnostics'],
  exportDiagnostics: call('diagnostics:export') as MarkNotesApi['exportDiagnostics'],
  diagnosticsDraft: call('diagnostics:draft') as MarkNotesApi['diagnosticsDraft'],
  openDiagnosticsDraft: call('diagnostics:open') as MarkNotesApi['openDiagnosticsDraft'],
  deviceId: call('app:deviceId') as MarkNotesApi['deviceId'],
  secureStorage: call('app:secureStorage') as MarkNotesApi['secureStorage'],
  captureProtection: call('privacy:capture') as MarkNotesApi['captureProtection'],
  setCaptureProtection: call('privacy:setCapture') as MarkNotesApi['setCaptureProtection'],
  onCaptureProtection(listener) {
    const handler = (_event: unknown, status: CaptureProtectionStatus) => listener(status);
    ipcRenderer.on('privacy:captureChanged', handler);
    return () => ipcRenderer.removeListener('privacy:captureChanged', handler);
  },
  lockStatus: call('lock:status') as MarkNotesApi['lockStatus'],
  localKey: call('lock:key') as MarkNotesApi['localKey'],
  unlock: call('lock:unlock') as MarkNotesApi['unlock'],
  enableLock: call('lock:enable') as MarkNotesApi['enableLock'],
  disableLock: call('lock:disable') as MarkNotesApi['disableLock'],
  changePassphrase: call('lock:change') as MarkNotesApi['changePassphrase'],
  lockNow: call('lock:lockNow') as MarkNotesApi['lockNow'],
  resetLocalKey: call('lock:reset') as MarkNotesApi['resetLocalKey'],
  onLocked(listener) {
    const handler = () => listener();
    ipcRenderer.on('lock:locked', handler);
    return () => ipcRenderer.removeListener('lock:locked', handler);
  },
  providers: call('drives:providers') as MarkNotesApi['providers'],
  drives: call('drives:list') as MarkNotesApi['drives'],
  signIn: call('drives:signIn') as MarkNotesApi['signIn'],
  cancelSignIn: call('drives:cancelSignIn') as MarkNotesApi['cancelSignIn'],
  protonLogin: call('drives:protonLogin') as MarkNotesApi['protonLogin'],
  protonTwoFactor: call('drives:protonTwoFactor') as MarkNotesApi['protonTwoFactor'],
  protonCancel: call('drives:protonCancel') as MarkNotesApi['protonCancel'],
  listFolders: call('drives:listFolders') as MarkNotesApi['listFolders'],
  addDrive: call('drives:add') as MarkNotesApi['addDrive'],
  discardSignIn: call('drives:discardSignIn') as MarkNotesApi['discardSignIn'],
  removeDrive: call('drives:remove') as MarkNotesApi['removeDrive'],
  remote: call('remote:op') as MarkNotesApi['remote'],
  openExternal: call('app:openExternal') as MarkNotesApi['openExternal'],
  updateStatus: call('update:status') as MarkNotesApi['updateStatus'],
  onUpdateStatus(listener) {
    const handler = (_event: unknown, status: UpdateStatus) => listener(status);
    ipcRenderer.on('update:changed', handler);
    return () => ipcRenderer.removeListener('update:changed', handler);
  },
  installUpdate: call('update:install') as MarkNotesApi['installUpdate'],
};

if (process.env.MARKNOTES_E2E === '1') {
  api.testRemote = call('test:remote') as NonNullable<MarkNotesApi['testRemote']>;
}

contextBridge.exposeInMainWorld('marknotes', api);
