// app/main/preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type RunStartPayload } from '../shared/ipc.js';

contextBridge.exposeInMainWorld('blox', {
  panelBase: () => ipcRenderer.invoke(IPC.panelBase) as Promise<string>,
  runStart: (p: RunStartPayload) => ipcRenderer.invoke(IPC.runStart, p) as Promise<boolean>,
  runCancel: () => ipcRenderer.invoke(IPC.runCancel) as Promise<boolean>,
  onRunExited: (cb: (r: { code: number | null }) => void) =>
    ipcRenderer.on(IPC.runExited, (_e, r) => cb(r)),
});

contextBridge.exposeInMainWorld('bloxSetup', {
  authSave: (k: string) => ipcRenderer.invoke(IPC.authSave, k),
  authStatus: () => ipcRenderer.invoke(IPC.authStatus),
  detectRojo: () => ipcRenderer.invoke(IPC.setupDetectRojo),
  installRojo: () => ipcRenderer.invoke(IPC.setupInstallRojo),
  installPlugin: () => ipcRenderer.invoke(IPC.setupInstallPlugin),
  checkStudio: () => ipcRenderer.invoke(IPC.setupCheckStudio),
  onboardState: () => ipcRenderer.invoke(IPC.onboardState),
  onboardComplete: () => ipcRenderer.invoke(IPC.onboardComplete),
});
