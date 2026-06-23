// app/main/index.ts
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { createEngineHost, type EngineChild } from './engine.js';
import { createCredStore, parseSubscriptionLinked } from './auth.js';
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

const cred = createCredStore();

const host = createEngineHost({
  enginePath,
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
  ipcMain.handle(IPC.runStart, async (_e, p: RunStartPayload) => {
    // A run needs a blox/Rojo project. Fresh folder → scaffold one first.
    // `blox init` pulls scripts from the open Studio place (step 4 verified it).
    if (!existsSync(resolve(p.projectPath, 'default.project.json'))) {
      win.webContents.send(IPC.runLog, 'initializing project (no default.project.json found)…');
      const init = await host.runCli(['init', '--project', p.projectPath]);
      if (init.stdout.trim()) win.webContents.send(IPC.runLog, init.stdout.trim());
      // `blox init` exits 1 both on real failure AND on success-with-conflicts;
      // for the fresh-folder target a conflict can't occur, so abort on any non-zero.
      if (init.code !== 0) {
        // init's real cause + hint ("open Studio with a place loaded…") is on stderr.
        const why = init.stderr.trim() || `init exited ${init.code}`;
        win.webContents.send(IPC.runLog, why);
        win.webContents.send(IPC.runExited, { code: init.code ?? 1 });
        return false;
      }
    }
    const handle = host.run(p.prompt, p.projectPath, {
      mode: p.mode, maxTurns: p.maxTurns, budgetUsd: p.budgetUsd, effort: p.effort, model: p.model,
    });
    current = handle;
    void handle.done.then((r) => win.webContents.send(IPC.runExited, r));
    return true;
  });
  ipcMain.handle(IPC.runCancel, () => { current?.cancel(); current = null; return true; });

  // API key → shared auth.json (engine reads it via buildAuthEnv).
  ipcMain.handle(IPC.authSave, (_e, key: string) => { cred.saveApiKey(key); return true; });
  ipcMain.handle(IPC.authStatus, () => cred.hasApiKey());
  ipcMain.handle(IPC.authClear, () => true); // no-op: first-run wizard never clears

  // Subscription: check current link state via the engine (parses claude auth status).
  ipcMain.handle(IPC.authSubscriptionStatus, async () => {
    const { stdout } = await host.runCli(['auth', 'status']);
    return parseSubscriptionLinked(stdout);
  });

  // Subscription sign-in: claude's OAuth is interactive (browser), so open a real
  // console window for it — the forked engine has piped stdio and can't host it.
  // Then poll `blox auth status` until linked (~3 min cap) and pin mode.
  ipcMain.handle(IPC.authLoginSubscription, async () => {
    const pre = await host.runCli(['auth', 'status']);
    if (/not found on PATH|failed to run claude/i.test(pre.stdout)) {
      return { linked: false, error: 'Claude CLI not found. Install Claude Code: https://claude.com/claude-code' };
    }
    // ponytail: `cmd /c start` is the reliable way to pop a console from a GUI
    // app. `start`'s first token is the *command* unless quoted — an unquoted
    // "blox-sign-in" makes Windows try to RUN it ("cannot find blox-sign-in"),
    // so the window title MUST be quoted. windowsVerbatimArguments keeps Node
    // from re-escaping those quotes. If no window appears on the live box, the
    // detached:true + windowsHide:false combo is already set.
    spawn(process.env.ComSpec || 'cmd.exe',
      ['/c', 'start', '"blox-sign-in"', 'cmd', '/k', 'claude', 'auth', 'login'],
      { windowsHide: false, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();

    const deadline = Date.now() + 3 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const { stdout } = await host.runCli(['auth', 'status']);
      const res = parseSubscriptionLinked(stdout);
      if (res.linked) { await host.runCli(['auth', 'use', 'subscription']); return res; }
      if (Date.now() > deadline) return { linked: false, error: 'timed out waiting for sign-in' };
    }
  });

  // Onboarding setup actions + persisted state.
  ipcMain.handle(IPC.setupDetectRojo, () => setup.detectRojo());
  ipcMain.handle(IPC.setupInstallRojo, () => setup.installRojo());
  ipcMain.handle(IPC.setupInstallPlugin, () => setup.installPlugin());
  ipcMain.handle(IPC.setupCheckStudio, () => setup.checkStudio());
  ipcMain.handle(IPC.onboardState, () => onboard.isComplete());
  ipcMain.handle(IPC.onboardComplete, () => { onboard.markComplete(); return true; });

  // Multi-model: write CCR provider config + list configured models via the engine.
  ipcMain.handle(IPC.modelAdd, async (_e, kind: 'openrouter' | 'local', opts: { key?: string; baseUrl?: string; models: string[] }) => {
    const cmd = ['model', 'add', kind, ...opts.models];
    if (opts.key) cmd.push('--key', opts.key);
    if (opts.baseUrl) cmd.push('--base-url', opts.baseUrl);
    const r = await host.runCli(cmd);
    return { ok: r.code === 0, detail: r.stdout.trim() };
  });
  ipcMain.handle(IPC.modelList, async () => {
    const r = await host.runCli(['model', 'list']);
    return r.stdout.split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('('));
  });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
