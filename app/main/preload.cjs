// app/main/preload.cjs — CommonJS on purpose.
// Electron loads preload scripts as CommonJS under the default sandbox; an ESM
// preload (this package is "type":"module") silently fails to run, leaving the
// renderer without window.blox/window.bloxSetup. Self-contained: no imports, so
// nothing to resolve at preload time. Channel names mirror shared/ipc.ts —
// keep in sync.
const { contextBridge, ipcRenderer } = require('electron');

const IPC = {
  runStart: 'run:start',
  runCancel: 'run:cancel',
  runExited: 'run:exited',
  panelBase: 'panel:base',
  authSave: 'auth:save',
  authStatus: 'auth:status',
  authClear: 'auth:clear',
  authLoginSubscription: 'auth:loginSubscription',
  authSubscriptionStatus: 'auth:subscriptionStatus',
  runLog: 'run:log',
  setupDetectRojo: 'setup:detectRojo',
  setupInstallRojo: 'setup:installRojo',
  setupInstallPlugin: 'setup:installPlugin',
  setupCheckStudio: 'setup:checkStudio',
  onboardState: 'onboard:state',
  onboardComplete: 'onboard:complete',
};

contextBridge.exposeInMainWorld('blox', {
  panelBase: () => ipcRenderer.invoke(IPC.panelBase),
  runStart: (p) => ipcRenderer.invoke(IPC.runStart, p),
  runCancel: () => ipcRenderer.invoke(IPC.runCancel),
  onRunExited: (cb) => ipcRenderer.on(IPC.runExited, (_e, r) => cb(r)),
  onRunLog: (cb) => ipcRenderer.on(IPC.runLog, (_e, text) => cb(text)),
});

contextBridge.exposeInMainWorld('bloxSetup', {
  authSave: (k) => ipcRenderer.invoke(IPC.authSave, k),
  authStatus: () => ipcRenderer.invoke(IPC.authStatus),
  authLoginSubscription: () => ipcRenderer.invoke(IPC.authLoginSubscription),
  authSubscriptionStatus: () => ipcRenderer.invoke(IPC.authSubscriptionStatus),
  detectRojo: () => ipcRenderer.invoke(IPC.setupDetectRojo),
  installRojo: () => ipcRenderer.invoke(IPC.setupInstallRojo),
  installPlugin: () => ipcRenderer.invoke(IPC.setupInstallPlugin),
  checkStudio: () => ipcRenderer.invoke(IPC.setupCheckStudio),
  onboardState: () => ipcRenderer.invoke(IPC.onboardState),
  onboardComplete: () => ipcRenderer.invoke(IPC.onboardComplete),
});
