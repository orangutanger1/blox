# blox Desktop Companion App v1 (DA + DB) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Windows Electron app that takes a non-technical user from download to their first AI-built Roblox change with no terminal, by supervising the existing blox CLI engine and reusing the panel HTTP protocol.

**Architecture:** Electron **main** forks the existing `dist/cli.js` as a supervised child (`utilityProcess`) and injects the API key + bundled-rojo PATH; the **renderer** is a second client of the panel HTTP API (`127.0.0.1:35768`) the Studio plugin already speaks. An onboarding wizard drives the engine's existing `panel install` / `doctor` / `init` subcommands plus rojo bundling. Engine code changes are near-zero.

**Tech Stack:** Electron + electron-builder, TypeScript (Node ESM), vitest. Engine = the existing blox CLI (`@anthropic-ai/claude-agent-sdk`). All new app logic lives under `app/` with electron dependencies injected, so the core modules unit-test headless on any OS.

**Spec:** `docs/superpowers/specs/2026-06-14-blox-desktop-companion-app-design.md`

### Environment reality (read before executing)

- **Phases 1–2 core modules** (`app/main/engine.ts`, `auth.ts`, `setup.ts`, `app/shared/panelClient.ts`) take their Electron/OS dependencies by injection and are tested with `vitest` — these run on Linux/WSL **and** Windows.
- **Electron app launch, Windows packaging, native-Windows MCP, and Studio** steps are **Windows-only and manual** (verify by launching, not by automated test). They are tagged **[WINDOWS-MANUAL]**.
- **Phase 0 spikes** are **[WINDOWS-MANUAL]** and gate everything after them.

### Phasing

- **Phase 0 — Spikes (throwaway, GO/NO-GO).** Prove the three §10 risks before building anything real.
- **Phase 1 — App shell + engine host (DA).** Supervisor, panel client, IPC, window, run console.
- **Phase 2 — Onboarding wizard (DB).** Auth vault, setup actions, rojo bundling, wizard.
- **Phase 3 — Packaging-lite.** Unsigned Windows installer + install smoke.

---

## File Structure

| File | Responsibility | Phase |
|---|---|---|
| `docs/superpowers/notes/desktop-spike-findings.md` | Spike results + GO/NO-GO + chosen auth path | 0 |
| `app/package.json`, `app/tsconfig.json`, `app/vitest.config.ts` | App sub-package (electron deps isolated from the engine) | 1 |
| `app/shared/panelClient.ts` | Pure HTTP client for the panel protocol (info/poll/gate/image) | 1 |
| `app/shared/ipc.ts` | Typed IPC channel + payload definitions shared by main/preload/renderer | 1 |
| `app/main/engine.ts` | Fork/supervise/cancel the engine child; build run argv + child env; `runCli` for subcommands | 1 |
| `app/main/index.ts` | Electron entry: window, preload wiring, IPC handlers | 1 |
| `app/main/preload.ts` | contextBridge surface to the renderer | 1 |
| `app/renderer/*` | Run console + onboarding wizard UI (panel client + IPC) | 1–2 |
| `app/main/auth.ts` | Secure key vault (injected `safeStorage`-like storage) | 2 |
| `app/main/setup.ts` | Onboarding actions: detectRojo / installRojo / installPlugin / checkStudio | 2 |
| `src/sync/rojo.ts`, `src/sync/serve.ts` | Optional `BLOX_ROJO_BIN` override (only engine edit) | 2 |
| `app/electron-builder.yml` | Bundle engine + rojo + plugin into an unsigned installer | 3 |

---

## Phase 0 — Spikes (throwaway, GO/NO-GO)

> Do these on a **discardable** branch `spike/desktop`. Code here is exploratory and is NOT merged. The only durable deliverable is the findings doc. After the gate, delete the branch.

### Task 0.1: Spike A — native-Windows engine run **[WINDOWS-MANUAL]**

**Goal:** confirm the engine runs as a native-Windows process (not WSL), and the MCP launcher reaches Studio without the `cmd.exe` hop.

- [ ] **Step 1: Build the engine on Windows**

On a Windows machine with Node ≥20 + the repo checked out:
Run: `npm install && npm run build`
Expected: `dist/cli.js` exists.

- [ ] **Step 2: Run doctor natively**

Run: `node dist/cli.js doctor`
Expected: prints the MCP + serve report. Note whether `studio: ATTACHED` appears with Studio open and "Enable Studio as MCP server" on. Record the exact launcher command the engine used (the bridge's `studioLauncher()` on `win32`).

- [ ] **Step 3: Run a real native build**

With a Rojo project + `rojo serve` connected in Studio:
Run: `node dist/cli.js "add a comment to a script" --ask --project <your-project>`
Expected: a run completes and a report prints. Record any native-Windows-specific failure (path separators, `mcp.bat` invocation, spawn errors).

- [ ] **Step 4: Record findings**

Append to `docs/superpowers/notes/desktop-spike-findings.md` under "Spike A": does the engine run natively on Windows? What launcher path worked? Any engine change required? GO/NO-GO for native Windows.

### Task 0.2: Spike B — Electron forks the CLI, real build completes **[WINDOWS-MANUAL]**

**Goal:** prove `utilityProcess.fork` can run the engine (which itself spawns the 235 MB SDK subprocess) and that a renderer `fetch` reaches the panel server.

- [ ] **Step 1: Minimal Electron harness**

On the `spike/desktop` branch create a throwaway `spike/` dir: a bare Electron app whose main process does:

```js
const { app, utilityProcess } = require('electron');
const path = require('node:path');
app.whenReady().then(() => {
  const child = utilityProcess.fork(
    path.resolve(__dirname, '../dist/cli.js'),
    ['add a comment', '--ask', '--project', process.env.SPIKE_PROJECT],
    { env: { ...process.env, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout.on('data', (d) => console.log('[engine]', d.toString()));
  child.on('exit', (code) => console.log('engine exited', code));
});
```

Run: `npx electron spike/main.js` (with `SPIKE_PROJECT` + `ANTHROPIC_API_KEY` set, Studio + rojo connected).
Expected: engine output streams; the run completes; exit code logged.

- [ ] **Step 2: Renderer reaches the panel server**

While the run is mid-flight, from a renderer window (or a second `node` process) `fetch('http://127.0.0.1:35768/api/v1/info')`.
Expected: `{ protocol: 3, runId, project }`. Confirms the renderer can be a panel client while the forked engine runs.

- [ ] **Step 3: Record findings**

Append "Spike B" to the findings doc: did `utilityProcess.fork` run the SDK-spawning engine? Did the panel server bind and answer from the renderer? Any packaging concern observed (path resolution to `dist/cli.js`)? GO/NO-GO.

### Task 0.3: Spike C — "Sign in with Claude" OAuth feasibility (time-boxed 1 day) **[WINDOWS-MANUAL]**

**Goal:** determine whether a non-key subscription login is reachable through the bundled SDK/CLI.

- [ ] **Step 1: Probe the SDK/CLI login surface**

Investigate whether the bundled `@anthropic-ai/claude-agent-sdk` runtime exposes a programmatic login (e.g. a `claude login`-style device/OAuth flow) that yields a credential the engine child can then use with `apiProvider: 'firstParty'` + `apiKeySource: 'oauth'` (see `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` around `ApiKeySource`). Try driving it once manually.

- [ ] **Step 2: Record findings + decide the v1 auth path**

Append "Spike C" to the findings doc. **Decision rule:** if a clean programmatic login exists within the time box → v1 offers "Sign in with Claude" in addition to key-paste; otherwise → v1 ships **key-paste only** and the login button is cut. Record the decision; Phase 2 Task 2.4 follows it.

### Task 0.4: GO/NO-GO gate

- [ ] **Step 1: Decide**

Review `docs/superpowers/notes/desktop-spike-findings.md`. Proceed to Phase 1 only if Spike A and Spike B are GO. If A or B is NO-GO, stop and revisit the spec (the desktop approach or the fork model needs rethinking). Spike C only sets the auth path, never blocks.

- [ ] **Step 2: Clean up**

```bash
git checkout main
git branch -D spike/desktop   # throwaway code discarded; findings doc was committed separately on main
```

Commit the findings doc to main:

```bash
git add docs/superpowers/notes/desktop-spike-findings.md
git commit -m "docs(desktop): spike findings + GO/NO-GO"
```

---

## Phase 1 — App shell + engine host (DA)

### Task 1.1: App sub-package scaffold

**Files:**
- Create: `app/package.json`, `app/tsconfig.json`, `app/vitest.config.ts`, `app/.gitignore`

- [ ] **Step 1: Create `app/package.json`**

```json
{
  "name": "blox-desktop",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "dist/main/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "start": "electron .",
    "pack": "electron-builder --win --dir",
    "dist": "electron-builder --win"
  },
  "engines": { "node": ">=20" },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "typescript": "^6.0.3",
    "vitest": "^4.1.8",
    "@types/node": "^25.9.2"
  }
}
```

- [ ] **Step 2: Create `app/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2023", "DOM"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmitOnError": true
  },
  "include": ["main", "shared", "renderer"]
}
```

- [ ] **Step 3: Create `app/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['**/*.test.ts'] } });
```

- [ ] **Step 4: Create `app/.gitignore`**

```
node_modules/
dist/
release/
```

- [ ] **Step 5: Install + verify the toolchain**

Run: `cd app && npm install && npx tsc -p tsconfig.json --noEmit`
Expected: install succeeds; tsc reports no errors (no source files yet → clean).

- [ ] **Step 6: Commit**

```bash
git add app/package.json app/tsconfig.json app/vitest.config.ts app/.gitignore
git commit -m "feat(desktop): app sub-package scaffold"
```

### Task 1.2: Panel client (`app/shared/panelClient.ts`)

**Files:**
- Create: `app/shared/panelClient.ts`
- Test: `app/shared/panelClient.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createPanelClient } from './panelClient.js';

let server: Server | null = null;
afterEach(() => { server?.close(); server = null; });

// Minimal stand-in for the engine's panel server: the 4 routes the client uses.
function stub(handlers: Record<string, (body: string) => { status: number; json: unknown }>): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const h = handlers[`${req.method} ${req.url?.split('?')[0]}`];
        const r = h ? h(body) : { status: 404, json: { error: 'nf' } };
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const a = server!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`);
    });
  });
}

describe('createPanelClient', () => {
  it('reads /info', async () => {
    const base = await stub({ 'GET /api/v1/info': () => ({ status: 200, json: { protocol: 3, runId: 'r1', project: 'g' } }) });
    const c = createPanelClient(base);
    expect(await c.info()).toEqual({ protocol: 3, runId: 'r1', project: 'g' });
  });

  it('polls events and returns the envelope', async () => {
    const base = await stub({ 'GET /api/v1/events': () => ({ status: 200, json: { events: [{ type: 'log', text: 'hi' }], cursor: 1 } }) });
    const c = createPanelClient(base);
    expect(await c.poll(0)).toEqual({ events: [{ type: 'log', text: 'hi' }], cursor: 1 });
  });

  it('posts a gate decision and returns ok', async () => {
    const base = await stub({ 'POST /api/v1/gate/abc': () => ({ status: 200, json: { ok: true } }) });
    const c = createPanelClient(base);
    expect(await c.resolveGate('abc', 'allow')).toBe(true);
  });

  it('returns null on a network error (server down)', async () => {
    const c = createPanelClient('http://127.0.0.1:1'); // nothing listening
    expect(await c.info()).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd app && npx vitest run shared/panelClient.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/shared/panelClient.ts
export interface PanelInfo { protocol: number; runId: string; project: string }
export interface EventEnvelope { events: unknown[]; cursor: number }

// Mirrors the engine's panel HTTP API (src/panel/server.ts). All methods
// resolve to null/false on any network error so the UI degrades gracefully —
// the engine is "observability, never control flow".
export function createPanelClient(base: string) {
  const url = (p: string) => `${base}/api/v1${p}`;
  async function getJson<T>(p: string): Promise<T | null> {
    try {
      const res = await fetch(url(p));
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    }
  }
  async function post(p: string, body: BodyInit, contentType: string): Promise<boolean> {
    try {
      const res = await fetch(url(p), { method: 'POST', headers: { 'content-type': contentType }, body });
      return res.ok;
    } catch {
      return false;
    }
  }
  return {
    info: () => getJson<PanelInfo>('/info'),
    poll: (cursor: number) => getJson<EventEnvelope>(`/events?cursor=${cursor}`),
    resolveGate: (gateId: string, decision: 'allow' | 'deny' | 'approve' | 'reject', feedback?: string) =>
      post(`/gate/${gateId}`, JSON.stringify(feedback ? { decision, feedback } : { decision }), 'application/json'),
    uploadImage: (bytes: Uint8Array, contentType: 'image/png' | 'image/jpeg') =>
      post('/image', bytes, contentType),
  };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `cd app && npx vitest run shared/panelClient.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/shared/panelClient.ts app/shared/panelClient.test.ts
git commit -m "feat(desktop): panel HTTP client"
```

### Task 1.3: Engine host supervisor (`app/main/engine.ts`)

**Files:**
- Create: `app/main/engine.ts`
- Test: `app/main/engine.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { buildRunArgs, buildChildEnv, createEngineHost, type EngineChild } from './engine.js';

describe('buildRunArgs', () => {
  it('builds prompt + project + autonomy flags', () => {
    expect(buildRunArgs('make a door', '/p', { mode: 'ask', maxTurns: 8, budgetUsd: 2, effort: 'high' }))
      .toEqual(['make a door', '--project', '/p', '--ask', '--max-turns', '8', '--budget', '2', '--effort', 'high']);
  });
  it('defaults to --auto with no extras', () => {
    expect(buildRunArgs('x', '/p')).toEqual(['x', '--project', '/p', '--auto']);
  });
  it('adds --image when given', () => {
    expect(buildRunArgs('x', '/p', { image: '/ref.png' })).toContain('--image');
  });
});

describe('buildChildEnv', () => {
  it('injects the key and prepends rojo dir to PATH', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, 'sk-123', '/opt/rojo', ':');
    expect(env.ANTHROPIC_API_KEY).toBe('sk-123');
    expect(env.PATH).toBe('/opt/rojo:/usr/bin');
  });
  it('omits the key when null and leaves PATH alone with no rojo dir', () => {
    const env = buildChildEnv({ PATH: '/usr/bin' }, null, undefined, ':');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.PATH).toBe('/usr/bin');
  });
});

describe('createEngineHost.run', () => {
  it('forks the engine, resolves done on exit, and cancel kills the child', async () => {
    let killed = false;
    const calls: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let exitCb: (code: number | null) => void = () => {};
    const fakeChild: EngineChild = {
      on: (_e, cb) => { exitCb = cb; },
      kill: () => { killed = true; },
    };
    const host = createEngineHost({
      enginePath: '/app/dist/cli.js',
      rojoDir: '/opt/rojo',
      loadKey: () => 'sk-9',
      fork: (entry, args, env) => { calls.push({ args, env }); expect(entry).toBe('/app/dist/cli.js'); return fakeChild; },
      pathSep: ':',
    });
    const handle = host.run('build it', '/proj', { mode: 'auto' });
    expect(calls[0].args).toEqual(['build it', '--project', '/proj', '--auto']);
    expect(calls[0].env.ANTHROPIC_API_KEY).toBe('sk-9');
    handle.cancel();
    expect(killed).toBe(true);
    exitCb(0);
    expect(await handle.done).toEqual({ code: 0 });
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd app && npx vitest run main/engine.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/main/engine.ts
// Supervises the existing blox CLI as a child. All Electron/OS specifics
// (the fork fn, the engine path, the key loader) are injected so this unit
// tests headless. In production `fork` wraps Electron's utilityProcess.fork.

export interface EngineChild {
  on(event: 'exit', cb: (code: number | null) => void): void;
  kill(): void;
  stdout?: { on(event: 'data', cb: (chunk: Buffer) => void): void };
}

export interface RunOptions {
  mode?: 'auto' | 'ask';
  maxTurns?: number;
  budgetUsd?: number;
  effort?: 'high' | 'xhigh';
  image?: string;
}

export interface EngineDeps {
  enginePath: string;
  loadKey: () => string | null;
  fork: (entry: string, args: string[], env: NodeJS.ProcessEnv) => EngineChild;
  rojoDir?: string;
  pathSep?: string; // injectable for tests; defaults to the OS delimiter
}

export interface RunHandle {
  cancel(): void;
  done: Promise<{ code: number | null }>;
}

export function buildRunArgs(prompt: string, projectPath: string, o: RunOptions = {}): string[] {
  const args = [prompt, '--project', projectPath, o.mode === 'ask' ? '--ask' : '--auto'];
  if (o.maxTurns != null) args.push('--max-turns', String(o.maxTurns));
  if (o.budgetUsd != null) args.push('--budget', String(o.budgetUsd));
  if (o.effort) args.push('--effort', o.effort);
  if (o.image) args.push('--image', o.image);
  return args;
}

export function buildChildEnv(
  base: NodeJS.ProcessEnv,
  key: string | null,
  rojoDir: string | undefined,
  sep: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  if (key) env.ANTHROPIC_API_KEY = key;
  if (rojoDir) env.PATH = `${rojoDir}${sep}${base.PATH ?? ''}`;
  return env;
}

export function createEngineHost(deps: EngineDeps) {
  const sep = deps.pathSep ?? (process.platform === 'win32' ? ';' : ':');
  function spawn(args: string[], collectStdout?: (s: string) => void): RunHandle {
    const env = buildChildEnv(process.env, deps.loadKey(), deps.rojoDir, sep);
    const child = deps.fork(deps.enginePath, args, env);
    if (collectStdout && child.stdout) child.stdout.on('data', (c) => collectStdout(c.toString()));
    const done = new Promise<{ code: number | null }>((resolve) => {
      child.on('exit', (code) => resolve({ code }));
    });
    return { cancel: () => child.kill(), done };
  }
  return {
    run(prompt: string, projectPath: string, opts: RunOptions = {}): RunHandle {
      return spawn(buildRunArgs(prompt, projectPath, opts));
    },
    // Drive a subcommand (doctor / panel install / init) and collect stdout.
    async runCli(args: string[]): Promise<{ code: number | null; stdout: string }> {
      let out = '';
      const handle = spawn(args, (s) => (out += s));
      const { code } = await handle.done;
      return { code, stdout: out };
    },
  };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `cd app && npx vitest run main/engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/main/engine.ts app/main/engine.test.ts
git commit -m "feat(desktop): engine host supervisor (fork/cancel/runCli)"
```

### Task 1.4: IPC contract (`app/shared/ipc.ts`)

**Files:**
- Create: `app/shared/ipc.ts`
- Test: `app/shared/ipc.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { IPC } from './ipc.js';

describe('IPC channel names', () => {
  it('are unique and stable', () => {
    const names = Object.values(IPC);
    expect(new Set(names).size).toBe(names.length);
    expect(IPC.runStart).toBe('run:start');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd app && npx vitest run shared/ipc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/shared/ipc.ts
// Single source of truth for IPC channel names + payload types shared by
// main, preload, and renderer.
export const IPC = {
  runStart: 'run:start',
  runCancel: 'run:cancel',
  runExited: 'run:exited',
  panelBase: 'panel:base',
  authSave: 'auth:save',
  authStatus: 'auth:status',
  authClear: 'auth:clear',
  setupDetectRojo: 'setup:detectRojo',
  setupInstallRojo: 'setup:installRojo',
  setupInstallPlugin: 'setup:installPlugin',
  setupCheckStudio: 'setup:checkStudio',
  onboardState: 'onboard:state',
  onboardComplete: 'onboard:complete',
} as const;

export interface RunStartPayload {
  prompt: string;
  projectPath: string;
  mode: 'auto' | 'ask';
  maxTurns?: number;
  budgetUsd?: number;
  effort?: 'high' | 'xhigh';
}
export interface StepResult { status: 'ok' | 'missing' | 'error'; detail: string }
```

- [ ] **Step 4: Run, verify it passes**

Run: `cd app && npx vitest run shared/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/shared/ipc.ts app/shared/ipc.test.ts
git commit -m "feat(desktop): typed IPC contract"
```

### Task 1.5: Electron main + preload + window **[WINDOWS-MANUAL]**

**Files:**
- Create: `app/main/index.ts`, `app/main/preload.ts`, `app/renderer/index.html`

- [ ] **Step 1: Implement the main process**

```ts
// app/main/index.ts
import { app, BrowserWindow, ipcMain, utilityProcess } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createEngineHost, type EngineChild } from './engine.js';
import { IPC, type RunStartPayload } from '../shared/ipc.js';

const here = dirname(fileURLToPath(import.meta.url));
// In a packaged app the engine lives next to the app resources; in dev it is
// the repo root's dist/cli.js. Resolve both.
const enginePath = process.env.BLOX_ENGINE_PATH ?? resolve(here, '../../../dist/cli.js');
const PANEL_BASE = 'http://127.0.0.1:35768';

const host = createEngineHost({
  enginePath,
  loadKey: () => process.env.ANTHROPIC_API_KEY ?? null, // replaced by the vault in Phase 2
  rojoDir: process.env.BLOX_ROJO_DIR,
  fork: (entry, args, env) =>
    utilityProcess.fork(entry, args, { env, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as EngineChild,
});

let current: { cancel(): void } | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: { preload: resolve(here, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  void win.loadFile(resolve(here, '../renderer/index.html'));

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
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
```

- [ ] **Step 2: Implement the preload bridge**

```ts
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
```

- [ ] **Step 3: Minimal renderer shell**

```html
<!-- app/renderer/index.html -->
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>blox</title></head>
  <body>
    <h1>blox</h1>
    <div id="app">loading…</div>
    <script type="module" src="./console.js"></script>
  </body>
</html>
```

- [ ] **Step 4: Build + launch (manual)**

Run: `cd app && npm run build && npm start`
Expected: an Electron window opens showing "blox". (No run console yet — Task 1.6.) Record any preload/path issues.

- [ ] **Step 5: Commit**

```bash
git add app/main/index.ts app/main/preload.ts app/renderer/index.html
git commit -m "feat(desktop): electron main, preload, window shell"
```

### Task 1.6: Run console renderer **[WINDOWS-MANUAL for launch; logic via panelClient]**

**Files:**
- Create: `app/renderer/console.ts` (compiled to `console.js`)

- [ ] **Step 1: Implement the run console**

```ts
// app/renderer/console.ts
import { createPanelClient } from '../shared/panelClient.js';

declare global {
  interface Window {
    blox: {
      panelBase(): Promise<string>;
      runStart(p: unknown): Promise<boolean>;
      runCancel(): Promise<boolean>;
      onRunExited(cb: (r: { code: number | null }) => void): void;
    };
  }
}

const app = document.getElementById('app')!;
app.innerHTML = `
  <input id="project" placeholder="project folder path" style="width:60%" />
  <div><textarea id="prompt" placeholder="describe what to build" rows="3" style="width:80%"></textarea></div>
  <button id="run">Run</button> <button id="cancel">Cancel</button>
  <pre id="log" style="height:360px;overflow:auto;background:#111;color:#ddd;padding:8px"></pre>
`;
const log = document.getElementById('log')!;
const append = (s: string) => { log.textContent += s + '\n'; log.scrollTop = log.scrollHeight; };

let cursor = 0;
let runId: string | null = null;
let polling = false;

async function pollLoop(base: string): Promise<void> {
  if (polling) return;
  polling = true;
  const client = createPanelClient(base);
  // Reset the cursor on a new runId — same rule as the Studio plugin.
  for (;;) {
    const info = await client.info();
    if (info && info.runId !== runId) { runId = info.runId; cursor = 0; }
    const data = await client.poll(cursor);
    if (data) {
      cursor = data.cursor;
      for (const e of data.events as { type: string; text?: string; path?: string }[]) {
        if (e.type === 'log') append(e.text ?? '');
        else if (e.type === 'file_diff') append(`Δ ${e.path}`);
        else append(`· ${e.type}`);
      }
    } else {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

document.getElementById('run')!.addEventListener('click', async () => {
  const projectPath = (document.getElementById('project') as HTMLInputElement).value.trim();
  const prompt = (document.getElementById('prompt') as HTMLTextAreaElement).value.trim();
  if (!projectPath || !prompt) { append('need a project path and a prompt'); return; }
  append('▶ starting run…');
  await window.blox.runStart({ prompt, projectPath, mode: 'ask' });
  void pollLoop(await window.blox.panelBase());
});
document.getElementById('cancel')!.addEventListener('click', () => window.blox.runCancel());
window.blox.onRunExited((r) => append(`run exited (${r.code})`));
```

- [ ] **Step 2: Build + manual end-to-end (Windows + Studio)**

Run: `cd app && npm run build && npm start`
Set the API key in the launch env for now (`ANTHROPIC_API_KEY`). Enter a project path + prompt, click Run.
Expected: log streams engine events; "run exited (0)". This is the DA milestone — a build with no terminal. Record gaps (gate cards not yet rendered — acceptable for DA; gates can still time out or be answered in Studio).

- [ ] **Step 3: Commit**

```bash
git add app/renderer/console.ts
git commit -m "feat(desktop): run console (panel client streaming)"
```

### Task 1.7: Phase 1 checkpoint

- [ ] **Step 1: Run the headless app tests**

Run: `cd app && npm test`
Expected: panelClient + engine + ipc tests all pass.

- [ ] **Step 2: Record the DA milestone** in `docs/superpowers/notes/desktop-spike-findings.md` under "Phase 1": confirm a no-terminal run worked end-to-end on Windows, with any caveats.

---

## Phase 2 — Onboarding wizard (DB)

### Task 2.1: Secure key vault (`app/main/auth.ts`)

**Files:**
- Create: `app/main/auth.ts`
- Test: `app/main/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createKeyVault, type SecureStorage } from './auth.js';

// Fake of Electron safeStorage: reversible (base64) so the round-trip is real
// without an OS keychain.
const fakeStorage: SecureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(s, 'utf8').toString('base64') as unknown as Buffer,
  decryptString: (b) => Buffer.from(String(b), 'base64').toString('utf8'),
};

const file = join(tmpdir(), `blox-vault-${Date.now()}.bin`);
afterEach(() => rmSync(file, { force: true }));

describe('createKeyVault', () => {
  it('round-trips a saved key', () => {
    const v = createKeyVault({ storage: fakeStorage, filePath: file });
    expect(v.loadKey()).toBeNull();
    v.saveKey('sk-abc');
    expect(v.loadKey()).toBe('sk-abc');
  });

  it('clears a key', () => {
    const v = createKeyVault({ storage: fakeStorage, filePath: file });
    v.saveKey('sk-abc');
    v.clearKey();
    expect(v.loadKey()).toBeNull();
  });

  it('reports status', () => {
    const v = createKeyVault({ storage: fakeStorage, filePath: file });
    expect(v.hasKey()).toBe(false);
    v.saveKey('sk-x');
    expect(v.hasKey()).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd app && npx vitest run main/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/main/auth.ts
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';

// The subset of Electron's safeStorage we use; injected so tests run headless.
export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

export interface VaultDeps {
  storage: SecureStorage;
  filePath: string; // app.getPath('userData') + '/key.bin' in production
}

// Stores the API key encrypted at rest via the OS credential backend. The key
// never touches plaintext disk or logs.
export function createKeyVault(deps: VaultDeps) {
  return {
    hasKey: () => existsSync(deps.filePath),
    saveKey(key: string): void {
      if (!deps.storage.isEncryptionAvailable()) throw new Error('OS secure storage unavailable');
      writeFileSync(deps.filePath, deps.storage.encryptString(key));
    },
    loadKey(): string | null {
      if (!existsSync(deps.filePath)) return null;
      try {
        return deps.storage.decryptString(readFileSync(deps.filePath));
      } catch {
        return null;
      }
    },
    clearKey(): void {
      rmSync(deps.filePath, { force: true });
    },
  };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `cd app && npx vitest run main/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the vault into main**

In `app/main/index.ts`, replace the `loadKey` line and import. Change:

```ts
import { createEngineHost, type EngineChild } from './engine.js';
```

to add:

```ts
import { createEngineHost, type EngineChild } from './engine.js';
import { createKeyVault } from './auth.js';
import { safeStorage } from 'electron';
```

and replace:

```ts
  loadKey: () => process.env.ANTHROPIC_API_KEY ?? null, // replaced by the vault in Phase 2
```

with:

```ts
  loadKey: () => vault.loadKey(),
```

adding above `createEngineHost`:

```ts
const vault = createKeyVault({ storage: safeStorage, filePath: resolve(app.getPath('userData'), 'key.bin') });
```

- [ ] **Step 6: Commit**

```bash
git add app/main/auth.ts app/main/auth.test.ts app/main/index.ts
git commit -m "feat(desktop): secure API-key vault + main wiring"
```

### Task 2.2: Setup actions (`app/main/setup.ts`)

**Files:**
- Create: `app/main/setup.ts`
- Test: `app/main/setup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { createSetup, type SetupDeps } from './setup.js';

function deps(over: Partial<SetupDeps> = {}): SetupDeps {
  return {
    runCli: async () => ({ code: 0, stdout: '' }),
    which: async () => '/usr/bin/rojo',
    download: async () => {},
    rojoBinPath: '/opt/rojo/rojo',
    ...over,
  };
}

describe('detectRojo', () => {
  it('ok when rojo is on PATH', async () => {
    expect((await createSetup(deps()).detectRojo()).status).toBe('ok');
  });
  it('missing when not found', async () => {
    expect((await createSetup(deps({ which: async () => null })).detectRojo()).status).toBe('missing');
  });
});

describe('installRojo', () => {
  it('ok after a successful download', async () => {
    expect((await createSetup(deps()).installRojo()).status).toBe('ok');
  });
  it('error when download throws', async () => {
    const r = await createSetup(deps({ download: async () => { throw new Error('net'); } })).installRojo();
    expect(r.status).toBe('error');
    expect(r.detail).toMatch(/net/);
  });
});

describe('installPlugin', () => {
  it('ok when `panel install` exits 0', async () => {
    const calls: string[][] = [];
    const r = await createSetup(deps({ runCli: async (a) => { calls.push(a); return { code: 0, stdout: 'installed' }; } })).installPlugin();
    expect(calls[0]).toEqual(['panel', 'install']);
    expect(r.status).toBe('ok');
  });
  it('error when it exits nonzero', async () => {
    expect((await createSetup(deps({ runCli: async () => ({ code: 1, stdout: 'fail' }) })).installPlugin()).status).toBe('error');
  });
});

describe('checkStudio', () => {
  it('ok when doctor exits 0', async () => {
    const r = await createSetup(deps({ runCli: async (a) => ({ code: a[0] === 'doctor' ? 0 : 1, stdout: '' }) })).checkStudio();
    expect(r.status).toBe('ok');
  });
  it('missing when doctor exits nonzero', async () => {
    expect((await createSetup(deps({ runCli: async () => ({ code: 1, stdout: 'not attached' }) })).checkStudio()).status).toBe('missing');
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd app && npx vitest run main/setup.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// app/main/setup.ts
import type { StepResult } from '../shared/ipc.js';

export interface SetupDeps {
  // Forks the engine CLI with args → exit code + stdout (engine.runCli).
  runCli: (args: string[]) => Promise<{ code: number | null; stdout: string }>;
  // Resolve a binary on PATH (null = not found).
  which: (bin: string) => Promise<string | null>;
  // Download a URL to a destination path.
  download: (url: string, dest: string) => Promise<void>;
  // Where the bundled/downloaded rojo binary should live.
  rojoBinPath: string;
}

// Pinned rojo release the app installs when rojo is absent (matches the
// version the engine was validated against).
export const ROJO_VERSION = '7.6.1';
export const ROJO_WIN_URL = `https://github.com/rojo-rbx/rojo/releases/download/v${ROJO_VERSION}/rojo-${ROJO_VERSION}-windows-x86_64.zip`;

export function createSetup(deps: SetupDeps) {
  return {
    async detectRojo(): Promise<StepResult> {
      const found = await deps.which('rojo');
      return found
        ? { status: 'ok', detail: `rojo found at ${found}` }
        : { status: 'missing', detail: 'rojo not on PATH' };
    },
    async installRojo(): Promise<StepResult> {
      try {
        await deps.download(ROJO_WIN_URL, deps.rojoBinPath);
        return { status: 'ok', detail: `rojo ${ROJO_VERSION} installed` };
      } catch (e) {
        return { status: 'error', detail: (e as Error).message };
      }
    },
    async installPlugin(): Promise<StepResult> {
      const { code, stdout } = await deps.runCli(['panel', 'install']);
      return code === 0
        ? { status: 'ok', detail: 'dock plugin installed into Studio' }
        : { status: 'error', detail: stdout || 'panel install failed' };
    },
    async checkStudio(): Promise<StepResult> {
      const { code, stdout } = await deps.runCli(['doctor']);
      return code === 0
        ? { status: 'ok', detail: 'Studio connected' }
        : { status: 'missing', detail: stdout || 'Studio not attached' };
    },
  };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `cd app && npx vitest run main/setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/main/setup.ts app/main/setup.test.ts
git commit -m "feat(desktop): onboarding setup actions"
```

### Task 2.3: Engine `BLOX_ROJO_BIN` override (the only engine edit)

**Files:**
- Modify: `src/sync/rojo.ts`, `src/sync/serve.ts`
- Test: `tests/rojo.test.ts` (existing)

- [ ] **Step 1: Write the failing test**

Append to `tests/rojo.test.ts`:

```ts
import { rojoBin } from '../src/sync/rojo.js';

describe('rojoBin', () => {
  it('defaults to "rojo"', () => {
    delete process.env.BLOX_ROJO_BIN;
    expect(rojoBin()).toBe('rojo');
  });
  it('honors BLOX_ROJO_BIN', () => {
    process.env.BLOX_ROJO_BIN = '/opt/rojo/rojo';
    expect(rojoBin()).toBe('/opt/rojo/rojo');
    delete process.env.BLOX_ROJO_BIN;
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `npx vitest run tests/rojo.test.ts`
Expected: FAIL — `rojoBin` not exported.

- [ ] **Step 3: Implement**

In `src/sync/rojo.ts`, add near the top (after imports):

```ts
// The rojo binary to invoke. The desktop app sets BLOX_ROJO_BIN to a bundled
// absolute path so it need not mutate PATH; the CLI default stays "rojo".
export function rojoBin(): string {
  return process.env.BLOX_ROJO_BIN || 'rojo';
}
```

Change the `spawn('rojo', ...)` call in `src/sync/rojo.ts` to `spawn(rojoBin(), ...)`.

In `src/sync/serve.ts`, import and use it. Change:

```ts
const child = nodeSpawn('rojo', ['serve', '--port', String(port)], { cwd: projectPath });
```

to:

```ts
const child = nodeSpawn(rojoBin(), ['serve', '--port', String(port)], { cwd: projectPath });
```

and add the import at the top of `src/sync/serve.ts`:

```ts
import { rojoBin } from './rojo.js';
```

- [ ] **Step 4: Run, verify it passes**

Run: `npx vitest run tests/rojo.test.ts && npm run build`
Expected: PASS; build clean.

- [ ] **Step 5: Commit**

```bash
git add src/sync/rojo.ts src/sync/serve.ts tests/rojo.test.ts
git commit -m "feat(engine): BLOX_ROJO_BIN override for bundled rojo"
```

### Task 2.4: Onboarding wizard renderer + state **[WINDOWS-MANUAL for launch]**

**Files:**
- Create: `app/renderer/onboard.ts`, `app/main/onboardState.ts`
- Test: `app/main/onboardState.test.ts`
- Modify: `app/main/index.ts`, `app/main/preload.ts`

- [ ] **Step 1: Write the failing test for persisted state**

```ts
// app/main/onboardState.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOnboardState } from './onboardState.js';

const file = join(tmpdir(), `blox-onboard-${Date.now()}.json`);
afterEach(() => rmSync(file, { force: true }));

describe('createOnboardState', () => {
  it('starts incomplete and persists completion', () => {
    const s = createOnboardState(file);
    expect(s.isComplete()).toBe(false);
    s.markComplete();
    expect(createOnboardState(file).isComplete()).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify it fails**

Run: `cd app && npx vitest run main/onboardState.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the state module**

```ts
// app/main/onboardState.ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export function createOnboardState(filePath: string) {
  const read = (): { complete: boolean } => {
    if (!existsSync(filePath)) return { complete: false };
    try { return JSON.parse(readFileSync(filePath, 'utf8')); } catch { return { complete: false }; }
  };
  return {
    isComplete: () => read().complete === true,
    markComplete: () => writeFileSync(filePath, JSON.stringify({ complete: true })),
  };
}
```

- [ ] **Step 4: Run, verify it passes**

Run: `cd app && npx vitest run main/onboardState.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire setup + auth + onboarding IPC into main**

In `app/main/index.ts` add the imports + handlers (after the existing `ipcMain.handle` calls in `createWindow`):

```ts
import { createSetup } from './setup.js';
import { createOnboardState } from './onboardState.js';
import { IPC, type RunStartPayload } from '../shared/ipc.js';
// ... inside createWindow, after run handlers:
const setup = createSetup({
  runCli: (args) => host.runCli(args),
  which: async (bin) => (await host.runCli(['--which-shim', bin])).code === 0 ? bin : null, // see note
  download: async (url, dest) => { const r = await fetch(url); const buf = Buffer.from(await r.arrayBuffer()); (await import('node:fs')).writeFileSync(dest, buf); },
  rojoBinPath: resolve(app.getPath('userData'), 'rojo.exe'),
});
const onboard = createOnboardState(resolve(app.getPath('userData'), 'onboard.json'));
ipcMain.handle(IPC.authSave, (_e, key: string) => { vault.saveKey(key); return true; });
ipcMain.handle(IPC.authStatus, () => vault.hasKey());
ipcMain.handle(IPC.setupDetectRojo, () => setup.detectRojo());
ipcMain.handle(IPC.setupInstallRojo, () => setup.installRojo());
ipcMain.handle(IPC.setupInstallPlugin, () => setup.installPlugin());
ipcMain.handle(IPC.setupCheckStudio, () => setup.checkStudio());
ipcMain.handle(IPC.onboardState, () => onboard.isComplete());
ipcMain.handle(IPC.onboardComplete, () => { onboard.markComplete(); return true; });
```

> **Note on `which`:** a PATH probe for rojo. Simplest robust implementation: `which` resolves by running `rojo --version` through `host.runCli` is wrong (that runs the engine, not rojo). Instead implement `which` in main directly with `node:child_process` `execFile('rojo', ['--version'])` wrapped in try/catch returning the bin path or null. Replace the placeholder line above with a small local `whichRojo()` helper:
>
> ```ts
> import { execFile } from 'node:child_process';
> const whichRojo = () => new Promise<string | null>((res) => execFile('rojo', ['--version'], (err) => res(err ? null : 'rojo')));
> ```
> and pass `which: () => whichRojo()`.

Add the matching preload methods in `app/main/preload.ts`:

```ts
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
```

- [ ] **Step 6: Implement the wizard renderer**

```ts
// app/renderer/onboard.ts
type Step = { status: 'ok' | 'missing' | 'error'; detail: string };
declare global {
  interface Window {
    bloxSetup: {
      authSave(k: string): Promise<boolean>;
      authStatus(): Promise<boolean>;
      detectRojo(): Promise<Step>;
      installRojo(): Promise<Step>;
      installPlugin(): Promise<Step>;
      checkStudio(): Promise<Step>;
      onboardState(): Promise<boolean>;
      onboardComplete(): Promise<boolean>;
    };
  }
}

const root = document.getElementById('app')!;
function line(label: string, r: Step) { return `<div>${r.status === 'ok' ? '✓' : '✗'} ${label}: ${r.detail}</div>`; }

export async function runOnboarding(onDone: () => void): Promise<void> {
  if (await window.bloxSetup.onboardState()) return onDone();
  root.innerHTML = `
    <h2>Set up blox</h2>
    <div>1. Paste your Anthropic API key (get one at console.anthropic.com):</div>
    <input id="key" style="width:70%" /> <button id="saveKey">Save</button>
    <div><button id="rojo">2. Set up Rojo</button> <span id="rojoOut"></span></div>
    <div><button id="plugin">3. Install Studio plugin</button> <span id="pluginOut"></span></div>
    <div><button id="studio">4. Check Studio connection</button> <span id="studioOut"></span></div>
    <div><button id="finish" disabled>Finish</button></div>
  `;
  const $ = (id: string) => document.getElementById(id)!;
  let keyOk = false, rojoOk = false, pluginOk = false, studioOk = false;
  const refresh = () => { ($('finish') as HTMLButtonElement).disabled = !(keyOk && rojoOk && pluginOk && studioOk); };

  $('saveKey').addEventListener('click', async () => {
    const k = ($('key') as HTMLInputElement).value.trim();
    if (k) { await window.bloxSetup.authSave(k); keyOk = true; ($('saveKey') as HTMLButtonElement).textContent = 'Saved ✓'; refresh(); }
  });
  $('rojo').addEventListener('click', async () => {
    let r = await window.bloxSetup.detectRojo();
    if (r.status !== 'ok') r = await window.bloxSetup.installRojo();
    $('rojoOut').innerHTML = line('rojo', r); rojoOk = r.status === 'ok'; refresh();
  });
  $('plugin').addEventListener('click', async () => {
    const r = await window.bloxSetup.installPlugin();
    $('pluginOut').innerHTML = line('plugin', r); pluginOk = r.status === 'ok'; refresh();
  });
  $('studio').addEventListener('click', async () => {
    const r = await window.bloxSetup.checkStudio();
    $('studioOut').innerHTML = line('studio', r); studioOk = r.status === 'ok'; refresh();
  });
  $('finish').addEventListener('click', async () => { await window.bloxSetup.onboardComplete(); onDone(); });
}
```

Wire it from the renderer entry: in `app/renderer/index.html` change the script to load a small bootstrap that runs onboarding then the console — create `app/renderer/boot.ts`:

```ts
// app/renderer/boot.ts
import { runOnboarding } from './onboard.js';
runOnboarding(() => { import('./console.js'); });
```

and point `index.html`'s `<script>` at `./boot.js`.

- [ ] **Step 7: Build + manual onboarding smoke (Windows + Studio)**

Run: `cd app && npm run build && npm start`
Expected: the wizard appears on first launch; key save, rojo, plugin install, Studio check each go green; Finish advances to the run console. Relaunch → onboarding skipped (state persisted).

- [ ] **Step 8: Commit**

```bash
git add app/main/onboardState.ts app/main/onboardState.test.ts app/main/index.ts app/main/preload.ts app/renderer/onboard.ts app/renderer/boot.ts app/renderer/index.html
git commit -m "feat(desktop): onboarding wizard + persisted state"
```

### Task 2.5: Phase 2 checkpoint + full live smoke **[WINDOWS-MANUAL]**

- [ ] **Step 1: Headless tests**

Run: `cd app && npm test` and (repo root) `npm test`
Expected: all app tests + engine tests (incl. the new `rojoBin`) pass.

- [ ] **Step 2: Full download→first-build smoke**

On a clean Windows user profile: launch the app, complete onboarding (key → rojo → plugin → Studio green), then run a real build from the console. Record the result in `docs/superpowers/notes/desktop-spike-findings.md` under "Phase 2".

---

## Phase 3 — Packaging-lite

### Task 3.1: electron-builder config **[WINDOWS-MANUAL]**

**Files:**
- Create: `app/electron-builder.yml`

- [ ] **Step 1: Implement the config**

```yaml
# app/electron-builder.yml — unsigned Windows installer for testing.
appId: gg.blox.desktop
productName: blox
directories:
  output: release
files:
  - dist/**/*
  - renderer/**/*
extraResources:
  # Bundle the engine (built dist + node_modules incl. the SDK runtime),
  # the pinned rojo binary, and the Studio plugin source.
  - from: ../dist
    to: engine/dist
  - from: ../node_modules
    to: engine/node_modules
  - from: ../plugin
    to: engine/plugin
win:
  target: nsis
  signAndEditExecutable: false
nsis:
  oneClick: true
  perMachine: false
```

> **Engine path at runtime:** in a packaged build the engine is at
> `process.resourcesPath + '/engine/dist/cli.js'`. Update the `enginePath`
> resolution in `app/main/index.ts` to prefer `BLOX_ENGINE_PATH`, then
> `resolve(process.resourcesPath, 'engine/dist/cli.js')` when packaged
> (`app.isPackaged`), else the dev path. Make that edit here.

- [ ] **Step 2: Make `enginePath` packaging-aware**

In `app/main/index.ts` replace the `enginePath` line with:

```ts
const enginePath =
  process.env.BLOX_ENGINE_PATH ??
  (app.isPackaged ? resolve(process.resourcesPath, 'engine/dist/cli.js') : resolve(here, '../../../dist/cli.js'));
```

and set `BLOX_ROJO_BIN` for the packaged engine — where `createEngineHost` is built, add to the child env by setting `rojoDir`/override. Simplest: before `createEngineHost`, compute:

```ts
const packagedRojo = app.isPackaged ? resolve(process.resourcesPath, 'engine/rojo.exe') : undefined;
if (packagedRojo) process.env.BLOX_ROJO_BIN = packagedRojo;
```

(Place the bundled `rojo.exe` under `extraResources` `from: ../<path-to-rojo>` once Task 2.2's download or a checked-in binary provides it.)

- [ ] **Step 3: Commit**

```bash
git add app/electron-builder.yml app/main/index.ts
git commit -m "feat(desktop): electron-builder packaging config"
```

### Task 3.2: Build + install smoke **[WINDOWS-MANUAL]**

- [ ] **Step 1: Build the engine, then the installer**

Run (repo root): `npm run build`
Run (app): `cd app && npm run build && npm run dist`
Expected: `app/release/` contains an `.exe` installer.

- [ ] **Step 2: Install + run on a clean profile**

Install the produced `.exe`, launch, complete onboarding, run a build.
Expected: works without a dev checkout present — the bundled engine + rojo + plugin are used. Record results in the findings doc under "Phase 3". This is the v1 deliverable: a handable installer.

---

## Self-Review Notes

- **Spec coverage:** §1 goal → whole plan; §2 decisions (DA+DB, Windows, Electron, fork integration, key-paste auth, packaging-lite, reuse) → Phases 0–3; §3 architecture (3 processes + plugin peer) → Tasks 1.2/1.3/1.5/1.6; §4 components → 4.1 (engine 1.3, auth 2.1, setup 2.2, ipc 1.4), 4.2 (console 1.6, onboard 2.4, panelClient 1.2); §5 flows → 1.6 (run) + 2.4 (onboarding step machine); §6 engine touch-points → 2.3 (`BLOX_ROJO_BIN`, the only edit); §7 error handling → panelClient null-degrade (1.2), no-key routing (2.4 finish-gating), doctor red (2.2), child crash (1.5 onRunExited); §8 testing → headless module tests + manual smokes; §9 out of scope → respected; §10 risks → Phase 0 spikes A/B/C with a gate.
- **One deliberate scope trim vs spec §5.2:** the run console (Task 1.6) accepts an **existing** project path only. GUI "create a new project" (wrapping `blox init`) is reachable via `host.runCli(['init', ...])` but is **not** a task in this plan — it is a small follow-up after the v1 download→first-build path lands. Flagged so it is not mistaken for an omission.
- **Placeholder scan:** the only non-literal spot is the `which` probe in Task 2.4 Step 5, which includes the concrete `whichRojo()` replacement code in the same step — no unresolved TODO.
- **Type consistency:** `StepResult` defined in `ipc.ts` (1.4) and reused by `setup.ts` (2.2) and `onboard.ts` (2.4). `EngineChild`/`RunOptions`/`RunHandle` defined in `engine.ts` (1.3) and used by main (1.5). `SecureStorage` defined in `auth.ts` (2.1). Panel client method names (`info`/`poll`/`resolveGate`/`uploadImage`) used consistently in 1.2 and 1.6. `IPC` channel constants shared across 1.4/1.5/2.4.

## Note on size

This plan spans a throwaway spike phase + three build phases and is large. If you prefer, execute it **one phase per session** with a checkpoint between phases (Phase 0 gate is mandatory before Phase 1). The headless module tasks (1.2–1.4, 2.1–2.3) are the safe, OS-independent core; the **[WINDOWS-MANUAL]** tasks need a Windows machine with Studio.
