// app/main/index.ts
import { app, BrowserWindow, ipcMain, utilityProcess, safeStorage } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createEngineHost, type EngineChild } from './engine.js';
import { createKeyVault } from './auth.js';
import { createSetup } from './setup.js';
import { createOnboardState } from './onboardState.js';
import { IPC, type RunStartPayload } from '../shared/ipc.js';

const here = dirname(fileURLToPath(import.meta.url));
// Packaged: engine lives under resources/engine. Dev: the repo root's dist.
const enginePath =
  process.env.BLOX_ENGINE_PATH ??
  (app.isPackaged
    ? resolve(process.resourcesPath, 'engine/dist/cli.js')
    : resolve(here, '../../../dist/cli.js'));
const PANEL_BASE = 'http://127.0.0.1:35768';

// Point the packaged engine at the bundled rojo so it needs no manual install.
const packagedRojo = app.isPackaged ? resolve(process.resourcesPath, 'engine/rojo.exe') : undefined;
if (packagedRojo) process.env.BLOX_ROJO_BIN = packagedRojo;

const vault = createKeyVault({
  storage: safeStorage,
  filePath: resolve(app.getPath('userData'), 'key.bin'),
});

const host = createEngineHost({
  enginePath,
  loadKey: () => vault.loadKey(),
  rojoDir: process.env.BLOX_ROJO_DIR,
  fork: (entry, args, env) =>
    utilityProcess.fork(entry, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as EngineChild,
});

// PATH probe for rojo: run `rojo --version`, bin path on success, null on error.
const whichRojo = () =>
  new Promise<string | null>((res) => execFile('rojo', ['--version'], (err) => res(err ? null : 'rojo')));

const setup = createSetup({
  runCli: (args) => host.runCli(args),
  which: () => whichRojo(),
  download: async (url, dest) => {
    const r = await fetch(url);
    writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  },
  rojoBinPath: resolve(app.getPath('userData'), 'rojo.exe'),
});
const onboard = createOnboardState(resolve(app.getPath('userData'), 'onboard.json'));

let current: { cancel(): void } | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: { preload: resolve(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false },
  });
  void win.loadFile(resolve(here, '../renderer/index.html'));

  // Run lifecycle.
  ipcMain.handle(IPC.panelBase, () => PANEL_BASE);
  ipcMain.handle(IPC.runStart, (_e, p: RunStartPayload) => {
    const handle = host.run(p.prompt, p.projectPath, {
      mode: p.mode, maxTurns: p.maxTurns, budgetUsd: p.budgetUsd, effort: p.effort,
    });
    current = handle;
    void handle.done.then((r) => win.webContents.send(IPC.runExited, r));
    return true;
  });
  ipcMain.handle(IPC.runCancel, () => { current?.cancel(); current = null; return true; });

  // Auth vault.
  ipcMain.handle(IPC.authSave, (_e, key: string) => { vault.saveKey(key); return true; });
  ipcMain.handle(IPC.authStatus, () => vault.hasKey());
  ipcMain.handle(IPC.authClear, () => { vault.clearKey(); return true; });

  // Onboarding setup actions + persisted state.
  ipcMain.handle(IPC.setupDetectRojo, () => setup.detectRojo());
  ipcMain.handle(IPC.setupInstallRojo, () => setup.installRojo());
  ipcMain.handle(IPC.setupInstallPlugin, () => setup.installPlugin());
  ipcMain.handle(IPC.setupCheckStudio, () => setup.checkStudio());
  ipcMain.handle(IPC.onboardState, () => onboard.isComplete());
  ipcMain.handle(IPC.onboardComplete, () => { onboard.markComplete(); return true; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
