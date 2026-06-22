# Desktop Auth + First-Run Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the desktop wizard sign in with an Anthropic subscription (not only an API key), unify credentials on the engine's `auth.json` so the key actually reaches the model, and make a run on a fresh Windows folder work (strip quotes, auto-init).

**Architecture:** The Electron main process stops keeping its own `safeStorage` vault and instead reads/writes the engine's existing `~/.config/blox/auth.json` (`0600`) — the same file `buildAuthEnv` reads when the forked engine runs. Subscription sign-in spawns a visible console window for Claude's interactive browser OAuth, then polls `blox auth status`. The run handler auto-runs `blox init` when the target folder isn't a blox project yet.

**Tech Stack:** Electron (main + preload + renderer), TypeScript (ESM, `"type":"module"`; preload is CommonJS `.cjs`), Vitest. Engine is the existing `blox` CLI (`dist/cli.js`) forked via `utilityProcess.fork`.

## Global Constraints

- Tests run from `app/`: `npm test` (vitest), `npm run build` (`tsc` + `node scripts/copy-assets.mjs`).
- Credential store path MUST match the engine's: `XDG_CONFIG_HOME || ~/.config` then `blox/auth.json`, written mode `0600` (mirrors `src/auth.ts:authConfigDir`/`saveAuthStore`).
- `app/main/preload.cjs` is CommonJS and self-contained; its `IPC` object is a hand-copy of `app/shared/ipc.ts` — any channel added in one MUST be added in the other.
- Pure logic is unit-tested; console-spawn, live OAuth, and auto-init are I/O — covered by manual Windows smoke, not unit tests.
- Target platform for the interactive flows is native Windows (`win32`).

---

### Task 1: Replace the safeStorage vault with the shared auth.json cred store

**Files:**
- Modify (rewrite): `app/main/auth.ts`
- Test (rewrite): `app/main/auth.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces:
  - `credStorePath(env?: NodeJS.ProcessEnv): string`
  - `type AuthMode = 'subscription' | 'apiKey'`
  - `interface AuthStore { mode?: AuthMode; apiKey?: string }`
  - `createCredStore(filePath?: string)` → `{ saveApiKey(key:string):void; hasApiKey():boolean; useSubscription():void; load():AuthStore }`
  - `parseSubscriptionLinked(stdout: string): { linked: boolean; detail?: string }`

- [ ] **Step 1: Write the failing test** — replace the whole contents of `app/main/auth.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCredStore, credStorePath, parseSubscriptionLinked } from './auth.js';

const file = join(tmpdir(), `blox-auth-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
afterEach(() => rmSync(file, { force: true }));

describe('createCredStore', () => {
  it('saves an API key and reports it, defaulting mode to apiKey', () => {
    const s = createCredStore(file);
    expect(s.hasApiKey()).toBe(false);
    s.saveApiKey('sk-abc');
    expect(s.hasApiKey()).toBe(true);
    expect(s.load()).toEqual({ mode: 'apiKey', apiKey: 'sk-abc' });
  });

  it('useSubscription sets mode without dropping a stored key', () => {
    const s = createCredStore(file);
    s.saveApiKey('sk-abc');
    s.useSubscription();
    expect(s.load()).toEqual({ mode: 'subscription', apiKey: 'sk-abc' });
  });

  it('missing file loads as empty', () => {
    expect(createCredStore(file).load()).toEqual({});
  });
});

describe('credStorePath', () => {
  it('honors XDG_CONFIG_HOME', () => {
    expect(credStorePath({ XDG_CONFIG_HOME: '/tmp/cfg' })).toBe('/tmp/cfg/blox/auth.json');
  });
});

describe('parseSubscriptionLinked', () => {
  it('detects linked with detail', () => {
    expect(parseSubscriptionLinked('active mode: subscription\nsubscription: linked (Pro, a@b.com)\napi key: not set'))
      .toEqual({ linked: true, detail: 'Pro, a@b.com' });
  });
  it('detects not linked', () => {
    expect(parseSubscriptionLinked('subscription: not linked — run `blox auth login`'))
      .toEqual({ linked: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- auth`
Expected: FAIL — `createCredStore`/`credStorePath`/`parseSubscriptionLinked` not exported.

- [ ] **Step 3: Write minimal implementation** — replace the whole contents of `app/main/auth.ts`:

```ts
// app/main/auth.ts
// Desktop credential store. Reads/writes the SAME file the engine reads
// (src/auth.ts), so a key saved here reaches the forked engine's buildAuthEnv.
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export type AuthMode = 'subscription' | 'apiKey';
export interface AuthStore { mode?: AuthMode; apiKey?: string }

// Mirror src/auth.ts:authConfigDir — same machine/user → same path.
export function credStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const xdg = typeof env.XDG_CONFIG_HOME === 'string' ? env.XDG_CONFIG_HOME.trim() : '';
  const base = xdg || join(homedir(), '.config');
  return join(base, 'blox', 'auth.json');
}

export function createCredStore(filePath: string = credStorePath()) {
  const load = (): AuthStore => {
    if (!existsSync(filePath)) return {};
    try {
      const r = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
      const s: AuthStore = {};
      if (r.mode === 'subscription' || r.mode === 'apiKey') s.mode = r.mode;
      if (typeof r.apiKey === 'string' && r.apiKey) s.apiKey = r.apiKey;
      return s;
    } catch {
      return {};
    }
  };
  const save = (s: AuthStore): void => {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
    chmodSync(filePath, 0o600); // enforce perms even if the file pre-existed
  };
  return {
    saveApiKey(key: string): void { const s = load(); s.apiKey = key; s.mode = 'apiKey'; save(s); },
    hasApiKey(): boolean { return !!load().apiKey; },
    useSubscription(): void { const s = load(); s.mode = 'subscription'; save(s); },
    load,
  };
}

// Parse `blox auth status` formatted output (src/auth.ts:formatAuthStatus).
export function parseSubscriptionLinked(stdout: string): { linked: boolean; detail?: string } {
  const m = stdout.match(/subscription:\s*linked(?:\s*\(([^)]*)\))?/i);
  return m ? { linked: true, detail: m[1] || undefined } : { linked: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm test -- auth`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add app/main/auth.ts app/main/auth.test.ts
git commit -m "feat(desktop): cred store on shared auth.json, drop safeStorage vault"
```

---

### Task 2: Stop injecting ANTHROPIC_API_KEY into the engine env

The engine reads the key from `auth.json` (Task 1) via `buildAuthEnv`; injecting
it as env did nothing useful and was stripped in subscription mode. Remove it.

**Files:**
- Modify: `app/main/engine.ts`
- Test: `app/main/engine.test.ts`

**Interfaces:**
- Produces (changed signatures):
  - `buildChildEnv(base: NodeJS.ProcessEnv, rojoDir: string | undefined, sep: string): NodeJS.ProcessEnv`
  - `EngineDeps` no longer has `loadKey`.

- [ ] **Step 1: Update the failing test** — in `app/main/engine.test.ts`, replace the entire `describe('buildChildEnv', ...)` block with:

```ts
describe('buildChildEnv', () => {
  it('prepends rojo dir to PATH and injects no key', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, '/opt/rojo', ':');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/opt/rojo:/usr/bin');
  });
  it('leaves PATH alone with no rojo dir', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, undefined, ':');
    expect(env.PATH).toBe('/usr/bin');
  });
});
```

Also in the same file, find the `createEngineHost.run` test's `createEngineHost({ ... })` call and remove its `loadKey: ...` property (the deps no longer take it).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd app && npm test -- engine`
Expected: FAIL — `buildChildEnv` still expects 4 args / `loadKey` type error.

- [ ] **Step 3: Write minimal implementation** — in `app/main/engine.ts`:

Replace `buildChildEnv`:

```ts
export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  rojoDir: string | undefined,
  sep: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (rojoDir) env.PATH = `${rojoDir}${sep}${base.PATH ?? ''}`;
  return env;
}
```

In `interface EngineDeps`, delete the line `loadKey: () => string | null;`.

In `createEngineHost`'s `spawn`, change the env line to:

```ts
    const env = buildChildEnv(process.env, deps.rojoDir, sep);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd app && npm test -- engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/main/engine.ts app/main/engine.test.ts
git commit -m "refactor(desktop): engine reads key from auth.json, not injected env"
```

---

### Task 3: Add IPC channels for subscription login, status, and run log

**Files:**
- Modify: `app/shared/ipc.ts`
- Modify: `app/main/preload.cjs`

**Interfaces:**
- Produces (new channel constants, identical strings in both files):
  - `authLoginSubscription: 'auth:loginSubscription'`
  - `authSubscriptionStatus: 'auth:subscriptionStatus'`
  - `runLog: 'run:log'`
- Produces (new preload bridge methods on `window.bloxSetup` / `window.blox`):
  - `bloxSetup.authLoginSubscription(): Promise<{ linked: boolean; detail?: string; error?: string }>`
  - `bloxSetup.authSubscriptionStatus(): Promise<{ linked: boolean; detail?: string; error?: string }>`
  - `blox.onRunLog(cb: (text: string) => void): void`

- [ ] **Step 1: Add channel constants** — in `app/shared/ipc.ts`, inside the `IPC` object after `authClear: 'auth:clear',` add:

```ts
  authLoginSubscription: 'auth:loginSubscription',
  authSubscriptionStatus: 'auth:subscriptionStatus',
  runLog: 'run:log',
```

- [ ] **Step 2: Mirror in preload + expose bridge** — in `app/main/preload.cjs`:

In the local `IPC = { ... }` object, after `authClear: 'auth:clear',` add the same three lines:

```js
  authLoginSubscription: 'auth:loginSubscription',
  authSubscriptionStatus: 'auth:subscriptionStatus',
  runLog: 'run:log',
```

In `exposeInMainWorld('blox', { ... })`, add after `onRunExited`:

```js
  onRunLog: (cb) => ipcRenderer.on(IPC.runLog, (_e, text) => cb(text)),
```

In `exposeInMainWorld('bloxSetup', { ... })`, add after `authStatus`:

```js
  authLoginSubscription: () => ipcRenderer.invoke(IPC.authLoginSubscription),
  authSubscriptionStatus: () => ipcRenderer.invoke(IPC.authSubscriptionStatus),
```

- [ ] **Step 3: Verify build** (no unit test — wiring only)

Run: `cd app && npm run build`
Expected: `tsc` succeeds, no type errors.

- [ ] **Step 4: Commit**

```bash
git add app/shared/ipc.ts app/main/preload.cjs
git commit -m "feat(desktop): IPC channels for subscription login, status, run log"
```

---

### Task 4: Wire main process — auth save, subscription login/status, auto-init

**Files:**
- Modify: `app/main/index.ts`

**Interfaces:**
- Consumes: `createCredStore`, `credStorePath`, `parseSubscriptionLinked` (Task 1); `host.runCli` (existing); new IPC channels (Task 3).
- Produces: the IPC handlers the renderer calls in Tasks 5–6.

- [ ] **Step 1: Swap the vault for the cred store.**

In `app/main/index.ts`, replace the import `import { createKeyVault } from './auth.js';` with:

```ts
import { createCredStore, parseSubscriptionLinked } from './auth.js';
```

Add to the node imports already present (`existsSync` needed for auto-init; `spawn` for the console):

```ts
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
```

(`writeFileSync` and `execFile` imports stay.)

Replace the `vault` block:

```ts
const vault = createKeyVault({
  storage: safeStorage,
  filePath: resolve(app.getPath('userData'), 'key.bin'),
});
```

with:

```ts
const cred = createCredStore();
```

Remove `safeStorage` from the `electron` import (it is no longer used).

In `createEngineHost({ ... })`, delete the `loadKey: () => vault.loadKey(),` line (Task 2 removed that dep).

- [ ] **Step 2: Replace the auth IPC handlers.**

Replace these three lines:

```ts
  ipcMain.handle(IPC.authSave, (_e, key: string) => { vault.saveKey(key); return true; });
  ipcMain.handle(IPC.authStatus, () => vault.hasKey());
  ipcMain.handle(IPC.authClear, () => { vault.clearKey(); return true; });
```

with:

```ts
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
    // app. Title has no spaces so it isn't mis-parsed as a quoted path. If no
    // window appears on the live box, try detached:true + windowsHide:false.
    spawn(process.env.ComSpec || 'cmd.exe',
      ['/c', 'start', 'blox-sign-in', 'cmd', '/k', 'claude', 'auth', 'login'],
      { windowsHide: false, detached: true, stdio: 'ignore' }).unref();

    const deadline = Date.now() + 3 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 2000));
      const { stdout } = await host.runCli(['auth', 'status']);
      const res = parseSubscriptionLinked(stdout);
      if (res.linked) { await host.runCli(['auth', 'use', 'subscription']); return res; }
      if (Date.now() > deadline) return { linked: false, error: 'timed out waiting for sign-in' };
    }
  });
```

- [ ] **Step 3: Auto-init in the run handler.**

Replace the existing `IPC.runStart` handler:

```ts
  ipcMain.handle(IPC.runStart, (_e, p: RunStartPayload) => {
    const handle = host.run(p.prompt, p.projectPath, {
      mode: p.mode, maxTurns: p.maxTurns, budgetUsd: p.budgetUsd, effort: p.effort,
    });
    current = handle;
    void handle.done.then((r) => win.webContents.send(IPC.runExited, r));
    return true;
  });
```

with:

```ts
  ipcMain.handle(IPC.runStart, async (_e, p: RunStartPayload) => {
    // A run needs a blox/Rojo project. Fresh folder → scaffold one first.
    // `blox init` pulls scripts from the open Studio place (step 4 verified it).
    if (!existsSync(resolve(p.projectPath, 'default.project.json'))) {
      win.webContents.send(IPC.runLog, 'initializing project (no default.project.json found)…');
      const init = await host.runCli(['init', '--project', p.projectPath]);
      win.webContents.send(IPC.runLog, init.stdout.trim());
      if (init.code !== 0) {
        win.webContents.send(IPC.runExited, { code: init.code });
        return false;
      }
    }
    const handle = host.run(p.prompt, p.projectPath, {
      mode: p.mode, maxTurns: p.maxTurns, budgetUsd: p.budgetUsd, effort: p.effort,
    });
    current = handle;
    void handle.done.then((r) => win.webContents.send(IPC.runExited, r));
    return true;
  });
```

- [ ] **Step 4: Verify build**

Run: `cd app && npm run build`
Expected: `tsc` succeeds. (No `safeStorage`/`createKeyVault`/`loadKey` references remain.)

- [ ] **Step 5: Run full unit suite (no regressions)**

Run: `cd app && npm test`
Expected: PASS (auth + engine + setup + onboardState).

- [ ] **Step 6: Commit**

```bash
git add app/main/index.ts
git commit -m "feat(desktop): subscription sign-in, status, and auto-init on run"
```

---

### Task 5: Strip wrapping quotes from the project path

**Files:**
- Modify: `app/renderer/console.ts`

**Interfaces:**
- Consumes: nothing new.

- [ ] **Step 1: Quote-strip the path.**

In `app/renderer/console.ts`, the run click handler currently reads:

```ts
  const projectPath = (document.getElementById('project') as HTMLInputElement).value.trim();
```

Replace with (strip one wrapping pair of `"` or `'` — Windows "Copy as path" wraps in quotes):

```ts
  const projectPath = (document.getElementById('project') as HTMLInputElement)
    .value.trim().replace(/^["']|["']$/g, '');
```

- [ ] **Step 2: Wire the run log into the console.**

In `app/renderer/console.ts`, after the existing line:

```ts
window.blox.onRunExited((r) => append(`run exited (${r.code})`));
```

add:

```ts
window.blox.onRunLog((text) => { if (text) append(text); });
```

Also update the `Window['blox']` `declare global` interface at the top of the file to include the new method, after `onRunExited`:

```ts
      onRunLog(cb: (text: string) => void): void;
```

- [ ] **Step 3: Verify build**

Run: `cd app && npm run build`
Expected: `tsc` succeeds.

- [ ] **Step 4: Commit**

```bash
git add app/renderer/console.ts
git commit -m "fix(desktop): strip wrapping quotes from project path; show run log"
```

---

### Task 6: Step 1 UI — sign in with Anthropic OR paste a key

**Files:**
- Modify: `app/renderer/onboard.ts`

**Interfaces:**
- Consumes: `window.bloxSetup.authLoginSubscription`, `window.bloxSetup.authSubscriptionStatus` (Task 3).

- [ ] **Step 1: Extend the bridge type.**

In `app/renderer/onboard.ts`, inside `interface bloxSetup`, after `authStatus(): Promise<boolean>;` add:

```ts
      authLoginSubscription(): Promise<{ linked: boolean; detail?: string; error?: string }>;
      authSubscriptionStatus(): Promise<{ linked: boolean; detail?: string; error?: string }>;
```

- [ ] **Step 2: Replace step 1 markup.**

In the `root.innerHTML` template, replace this block:

```ts
    <div>1. Paste your Anthropic API key (get one at console.anthropic.com):</div>
    <input id="key" style="width:70%" /> <button id="saveKey">Save</button>
```

with:

```ts
    <div>1. Connect Anthropic — either option works:</div>
    <div><button id="signin">Sign in with Anthropic (subscription)</button> <span id="signinOut"></span></div>
    <div>or paste an API key (console.anthropic.com): <input id="key" style="width:50%" /> <button id="saveKey">Save</button></div>
```

- [ ] **Step 3: Rename the gate var and add the sign-in handler.**

Replace:

```ts
  let keyOk = false, rojoOk = false, pluginOk = false, studioOk = false;
  const refresh = () => { ($('finish') as HTMLButtonElement).disabled = !(keyOk && rojoOk && pluginOk && studioOk); };
```

with:

```ts
  let authOk = false, rojoOk = false, pluginOk = false, studioOk = false;
  const refresh = () => { ($('finish') as HTMLButtonElement).disabled = !(authOk && rojoOk && pluginOk && studioOk); };

  // Already signed in from a prior session? Reflect it.
  void window.bloxSetup.authSubscriptionStatus().then((s) => {
    if (s.linked) { authOk = true; $('signinOut').textContent = `signed in${s.detail ? ` (${s.detail})` : ''} ✓`; refresh(); }
  });

  $('signin').addEventListener('click', async () => {
    const btn = $('signin') as HTMLButtonElement;
    btn.disabled = true; $('signinOut').textContent = 'opening sign-in window…';
    const s = await window.bloxSetup.authLoginSubscription();
    if (s.linked) { authOk = true; $('signinOut').textContent = `signed in${s.detail ? ` (${s.detail})` : ''} ✓`; }
    else { $('signinOut').textContent = s.error ?? 'sign-in not completed'; btn.disabled = false; }
    refresh();
  });
```

- [ ] **Step 4: Update the save-key handler to use the new gate var.**

Replace:

```ts
  $('saveKey').addEventListener('click', async () => {
    const k = ($('key') as HTMLInputElement).value.trim();
    if (k) { await window.bloxSetup.authSave(k); keyOk = true; ($('saveKey') as HTMLButtonElement).textContent = 'Saved ✓'; refresh(); }
  });
```

with:

```ts
  $('saveKey').addEventListener('click', async () => {
    const k = ($('key') as HTMLInputElement).value.trim();
    if (k) { await window.bloxSetup.authSave(k); authOk = true; ($('saveKey') as HTMLButtonElement).textContent = 'Saved ✓'; refresh(); }
  });
```

- [ ] **Step 5: Verify build + full suite**

Run: `cd app && npm run build && npm test`
Expected: build succeeds; all unit tests PASS.

- [ ] **Step 6: Commit**

```bash
git add app/renderer/onboard.ts
git commit -m "feat(desktop): step 1 offers subscription sign-in or API key"
```

---

### Task 7: Manual Windows smoke (no unit coverage possible)

**Files:** none (verification only).

- [ ] **Step 1:** `cd app && npm run build && npm start`.
- [ ] **Step 2:** Step 1 → "Sign in with Anthropic": a console window opens running `claude auth login`, browser OAuth completes, the wizard flips to `signed in (...)`. (If no window appears, switch the spawn to `detached:true` + `windowsHide:false` without `start`, per the comment in Task 4.)
- [ ] **Step 3:** Restart the app → step 1 shows `signed in` immediately (status pre-check).
- [ ] **Step 4:** Alternatively paste an API key → `Saved ✓`; confirm `~/.config/blox/auth.json` has `{ "mode":"apiKey", "apiKey":"…" }` at `0600`.
- [ ] **Step 5:** Finish onboarding. On the run screen, paste a *quoted* fresh path (e.g. `"C:\Users\matth\Downloads\test"`) and prompt "a dance floor". The log shows `initializing project…`, then init output, then the run proceeds (Studio must be open with a place loaded). The model now has working credentials.
- [ ] **Step 6:** Confirm an unquoted path to the same fresh folder behaves identically.

---

## Self-Review

- **Spec coverage:** single store (Tasks 1,2,4) ✓; subscription sign-in via console + poll (Tasks 3,4,6) ✓; API key → auth.json (Tasks 1,4) ✓; quote-strip (Task 5) ✓; auto-init (Task 4) ✓; step-1-OR gate (Task 6) ✓; error handling — claude missing / timeout / init fail (Task 4), surfaced in UI (Tasks 5,6) ✓; vault + env-injection removed (Tasks 1,2,4) ✓.
- **Placeholder scan:** none — every code step has full content.
- **Type consistency:** `authOk` used consistently in Task 6; `parseSubscriptionLinked` shape `{linked,detail?}` matches Tasks 1/4/6; `buildChildEnv(base,rojoDir,sep)` matches Task 2 test + caller; new IPC names identical in `ipc.ts` and `preload.cjs` (Task 3).
- **Deferred (per spec):** in-app OAuth, encrypted vault, stderr streaming, auth switching, multi-project picker.
