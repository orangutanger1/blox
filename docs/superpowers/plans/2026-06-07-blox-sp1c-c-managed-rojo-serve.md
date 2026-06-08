# blox SP1c-c — blox-managed `rojo serve` lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make blox own the `rojo serve` long-running process — reuse a reachable serve, spawn its own only when none is up, and tear down only what it started.

**Architecture:** A new `src/sync/serve.ts` module adds a long-running-process seam (`ServeSpawnFn`/`ServeHandle`) distinct from the one-shot `SpawnFn`. `ensureServe` reuses a reachable serve (via the existing `checkRojoServe`) or spawns + readiness-polls a new one, returning a `mode`-tagged `ServeSession`. `stopServe` and `registerServeTeardown` tear down only `spawned` sessions. `cli.ts` adds a `blox serve` foreground command and wraps the run flow; mock runs skip serve entirely.

**Tech Stack:** TypeScript (native compiler v6, ESM, `node:` imports), vitest, zod, `node:child_process`. rojo at `~/.local/bin/rojo` (v7.6.1). Spec: `docs/superpowers/specs/2026-06-07-blox-sp1c-c-managed-rojo-serve-design.md`.

---

## File Structure

- **Create `src/sync/serve.ts`** — the serve seam + orchestrator. Owns: `ServeHandle`, `ServeSpawnFn`, `realServeSpawn`, `rojoServePort`, `serveUrl`, `ServeMode`, `ServeSession`, `EnsureServeOptions`, `ensureServe`, `stopServe`, `registerServeTeardown`.
- **Create `tests/serve.test.ts`** — unit tests for everything in `serve.ts` except `realServeSpawn` (real process — covered by the live test).
- **Modify `src/args.ts`** — extend the `command` union with `'serve'` and parse the token.
- **Modify `tests/args.test.ts`** — cover the `serve` token.
- **Modify `src/cli.ts`** — `blox serve` command + run-flow wiring (skip on `--mock`, non-fatal on serve failure).
- **Create `tests/e2e/live-serve.test.ts`** — gated (`BLOX_LIVE_SERVE=1`) real spawn→reachable→teardown.

Reused as-is: `checkRojoServe`/`FetchFn` (`src/sync/serveCheck.ts`), the `SpawnFn` pattern (`src/sync/rojo.ts`).

---

## Task 1: serve.ts core — types, `rojoServePort`, `serveUrl`, `realServeSpawn`

**Files:**
- Create: `src/sync/serve.ts`
- Test: `tests/serve.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/serve.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { rojoServePort, serveUrl } from '../src/sync/serve.js';

describe('rojoServePort', () => {
  it('defaults to 34872', () => {
    const prev = process.env.BLOX_ROJO_SERVE_PORT;
    delete process.env.BLOX_ROJO_SERVE_PORT;
    try { expect(rojoServePort()).toBe(34872); }
    finally { if (prev !== undefined) process.env.BLOX_ROJO_SERVE_PORT = prev; }
  });

  it('honors BLOX_ROJO_SERVE_PORT', () => {
    const prev = process.env.BLOX_ROJO_SERVE_PORT;
    process.env.BLOX_ROJO_SERVE_PORT = '40000';
    try { expect(rojoServePort()).toBe(40000); }
    finally { if (prev === undefined) delete process.env.BLOX_ROJO_SERVE_PORT; else process.env.BLOX_ROJO_SERVE_PORT = prev; }
  });
});

describe('serveUrl', () => {
  it('builds a localhost url from the port', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    delete process.env.BLOX_ROJO_SERVE_URL;
    try { expect(serveUrl(40000)).toBe('http://localhost:40000'); }
    finally { if (prev !== undefined) process.env.BLOX_ROJO_SERVE_URL = prev; }
  });

  it('honors BLOX_ROJO_SERVE_URL override regardless of port', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    process.env.BLOX_ROJO_SERVE_URL = 'http://172.30.12.182:34872';
    try { expect(serveUrl(40000)).toBe('http://172.30.12.182:34872'); }
    finally { if (prev === undefined) delete process.env.BLOX_ROJO_SERVE_URL; else process.env.BLOX_ROJO_SERVE_URL = prev; }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serve.test.ts`
Expected: FAIL — cannot resolve `../src/sync/serve.js`.

- [ ] **Step 3: Write minimal implementation**

Create `src/sync/serve.ts`:

```ts
import { spawn as nodeSpawn } from 'node:child_process';

// A long-running serve process. Distinct from rojo.ts's one-shot SpawnFn, which
// resolves only AFTER the child exits — wrong shape for a daemon we must keep
// alive and later kill.
export interface ServeHandle {
  pid?: number;
  kill(): void;
  exited: Promise<number>; // resolves with the exit code when the child dies
}
export type ServeSpawnFn = (projectPath: string, port: number) => ServeHandle;

export function rojoServePort(): number {
  const raw = process.env.BLOX_ROJO_SERVE_PORT;
  const n = raw ? Number(raw) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 34872;
}

// Kept consistent with serveCheck.rojoServeUrl(): an explicit URL override wins;
// otherwise localhost on the chosen port.
export function serveUrl(port: number): string {
  return process.env.BLOX_ROJO_SERVE_URL ?? `http://localhost:${port}`;
}

// Spawns `rojo serve --port <port>` in the project dir (cwd → default.project.json,
// mirroring syncProject). Not detached — killable via the handle for clean teardown.
export const realServeSpawn: ServeSpawnFn = (projectPath, port) => {
  const child = nodeSpawn('rojo', ['serve', '--port', String(port)], { cwd: projectPath });
  const exited = new Promise<number>((res) => {
    child.on('error', () => res(1));
    child.on('close', (code) => res(code ?? 1));
  });
  return { pid: child.pid, kill: () => { child.kill('SIGTERM'); }, exited };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/serve.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/serve.ts tests/serve.test.ts
git commit -m "feat: serve seam — ServeHandle/ServeSpawnFn, rojoServePort, serveUrl, realServeSpawn"
```

---

## Task 2: `ensureServe` + `stopServe`

**Files:**
- Modify: `src/sync/serve.ts`
- Test: `tests/serve.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/serve.test.ts`:

```ts
import { ensureServe, stopServe, type ServeHandle, type ServeSpawnFn } from '../src/sync/serve.js';
import type { FetchFn } from '../src/sync/serveCheck.js';

const okBody = { projectName: 'blox-fixture', protocolVersion: 4, serverVersion: '7.6.1' };
const reachable: FetchFn = async () => ({ ok: true, status: 200, json: async () => okBody });
const down: FetchFn = async () => { throw new Error('ECONNREFUSED'); };
const noSleep = async () => {};

function fakeHandle(): ServeHandle & { killed: boolean } {
  let resolveExit!: (code: number) => void;
  const h: any = {
    pid: 4242,
    killed: false,
    kill() { h.killed = true; resolveExit(0); },
    exited: new Promise<number>((r) => { resolveExit = r; }),
  };
  return h;
}

describe('ensureServe', () => {
  it('reuses a reachable serve without spawning', async () => {
    let spawned = false;
    const spawn: ServeSpawnFn = () => { spawned = true; return fakeHandle(); };
    const s = await ensureServe('/proj', { fetch: reachable, spawn, sleep: noSleep });
    expect(s.mode).toBe('reused');
    expect(s.handle).toBeNull();
    expect(spawned).toBe(false);
  });

  it('spawns and returns once the new serve becomes reachable', async () => {
    const handle = fakeHandle();
    const spawn: ServeSpawnFn = () => handle;
    let calls = 0;
    const flaky: FetchFn = async () => {
      calls++;
      if (calls < 3) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => okBody };
    };
    const s = await ensureServe('/proj', { fetch: flaky, spawn, sleep: noSleep, attempts: 10, delayMs: 1 });
    expect(s.mode).toBe('spawned');
    expect(s.handle).toBe(handle);
  });

  it('throws if the child exits before becoming reachable', async () => {
    const handle = fakeHandle();
    const spawn: ServeSpawnFn = () => { handle.kill(); return handle; }; // exits immediately
    await expect(
      ensureServe('/proj', { fetch: down, spawn, sleep: noSleep, attempts: 5, delayMs: 1 }),
    ).rejects.toThrow(/exited/);
  });

  it('throws and kills the child if it never becomes reachable', async () => {
    const handle = fakeHandle();
    const spawn: ServeSpawnFn = () => handle;
    await expect(
      ensureServe('/proj', { fetch: down, spawn, sleep: noSleep, attempts: 3, delayMs: 1 }),
    ).rejects.toThrow(/did not become reachable/);
    expect(handle.killed).toBe(true);
  });
});

describe('stopServe', () => {
  it('kills and awaits a spawned session', async () => {
    const handle = fakeHandle();
    await stopServe({ mode: 'spawned', url: 'u', port: 1, handle });
    expect(handle.killed).toBe(true);
  });

  it('is a no-op for a reused session', async () => {
    await expect(stopServe({ mode: 'reused', url: 'u', port: 1, handle: null })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serve.test.ts`
Expected: FAIL — `ensureServe`/`stopServe` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/sync/serve.ts`:

```ts
import { checkRojoServe, type FetchFn } from './serveCheck.js';

export type ServeMode = 'reused' | 'spawned';
export interface ServeSession {
  mode: ServeMode;
  url: string;
  port: number;
  handle: ServeHandle | null; // null when reused
}

export interface EnsureServeOptions {
  spawn?: ServeSpawnFn;            // default realServeSpawn
  fetch?: FetchFn;                 // default checkRojoServe's own default
  port?: number;                   // default rojoServePort()
  attempts?: number;               // readiness poll, default 10
  delayMs?: number;                // readiness poll, default 500
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function ensureServe(projectPath: string, opts: EnsureServeOptions = {}): Promise<ServeSession> {
  const port = opts.port ?? rojoServePort();
  const url = serveUrl(port);
  const spawn = opts.spawn ?? realServeSpawn;
  const attempts = opts.attempts ?? 10;
  const delayMs = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;

  const first = await checkRojoServe(url, opts.fetch);
  if (first.reachable) return { mode: 'reused', url, port, handle: null };

  const handle = spawn(projectPath, port);
  let exitCode: number | null = null;
  void handle.exited.then((c) => { exitCode = c; });

  for (let i = 0; i < attempts; i++) {
    if (exitCode !== null) {
      throw new Error(`rojo serve exited with code ${exitCode} before becoming reachable`);
    }
    const r = await checkRojoServe(url, opts.fetch);
    if (r.reachable) return { mode: 'spawned', url, port, handle };
    await sleep(delayMs);
  }
  handle.kill();
  throw new Error(`rojo serve did not become reachable at ${url} after ${attempts} attempts`);
}

export async function stopServe(session: ServeSession): Promise<void> {
  if (session.mode !== 'spawned' || !session.handle) return;
  session.handle.kill();
  await session.handle.exited;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/serve.test.ts`
Expected: PASS (all serve tests).

Note: the "exits before reachable" test relies on the spawn callback calling `kill()` (which resolves `exited`) synchronously, so `exitCode` is set before the first poll's `await` resumes. The implementation checks `exitCode` at the top of each loop iteration.

- [ ] **Step 5: Commit**

```bash
git add src/sync/serve.ts tests/serve.test.ts
git commit -m "feat: ensureServe (reuse-or-spawn + readiness poll) and stopServe"
```

---

## Task 3: `registerServeTeardown`

**Files:**
- Modify: `src/sync/serve.ts`
- Test: `tests/serve.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/serve.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { registerServeTeardown } from '../src/sync/serve.js';

describe('registerServeTeardown', () => {
  it('kills the spawned child and exits on SIGINT', () => {
    const handle = fakeHandle();
    const proc = new EventEmitter();
    let exitCode: number | undefined;
    registerServeTeardown(
      { mode: 'spawned', url: 'u', port: 1, handle },
      { proc, exit: (c) => { exitCode = c; } },
    );
    proc.emit('SIGINT');
    expect(handle.killed).toBe(true);
    expect(exitCode).toBe(130);
  });

  it('kills the spawned child on process exit (no exit() call)', () => {
    const handle = fakeHandle();
    const proc = new EventEmitter();
    let exitCalled = false;
    registerServeTeardown(
      { mode: 'spawned', url: 'u', port: 1, handle },
      { proc, exit: () => { exitCalled = true; } },
    );
    proc.emit('exit');
    expect(handle.killed).toBe(true);
    expect(exitCalled).toBe(false);
  });

  it('registers nothing for a reused session', () => {
    const proc = new EventEmitter();
    registerServeTeardown({ mode: 'reused', url: 'u', port: 1, handle: null }, { proc, exit: () => {} });
    expect(proc.listenerCount('SIGINT')).toBe(0);
    expect(proc.listenerCount('exit')).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/serve.test.ts`
Expected: FAIL — `registerServeTeardown` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `src/sync/serve.ts`:

```ts
export interface SignalLike {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}
export interface TeardownOptions {
  proc?: SignalLike;
  exit?: (code: number) => void;
}

// Safety net so an interrupted run never orphans a rojo process. Only spawned
// sessions are registered; reused serves are never touched. 'exit' kills sync
// (Node forbids async work there); signals kill then exit 130 (adding a signal
// listener suppresses Node's default exit-on-signal, so we exit explicitly).
export function registerServeTeardown(session: ServeSession, opts: TeardownOptions = {}): void {
  if (session.mode !== 'spawned' || !session.handle) return;
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const handle = session.handle;
  proc.on('exit', () => { handle.kill(); });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    proc.on(sig, () => { handle.kill(); exit(130); });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/serve.test.ts`
Expected: PASS (all serve tests).

- [ ] **Step 5: Commit**

```bash
git add src/sync/serve.ts tests/serve.test.ts
git commit -m "feat: registerServeTeardown — kill spawned serve on signals/exit"
```

---

## Task 4: `args.ts` — `serve` command

**Files:**
- Modify: `src/args.ts`
- Test: `tests/args.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/args.test.ts`:

```ts
describe('serve subcommand', () => {
  it('parses a leading serve token into command', () => {
    const a = parseArgs(['serve']);
    expect(a.command).toBe('serve');
    expect(a.prompt).toBeNull();
  });

  it('honors --project with serve', () => {
    const a = parseArgs(['serve', '--project', '/game']);
    expect(a.command).toBe('serve');
    expect(a.projectPath).toBe('/game');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/args.test.ts`
Expected: FAIL — `command` is `null` (or `'serve'` not assignable), `serve` lands in the prompt.

- [ ] **Step 3: Write minimal implementation**

In `src/args.ts`, change the `command` type in both `ParsedArgs` and the local variable, and add the parse branch:

```ts
export interface ParsedArgs {
  command: 'doctor' | 'serve' | null;
  prompt: string | null;
  mock: boolean;
  projectPath: string | null;
}
```

```ts
  let command: 'doctor' | 'serve' | null = null;
```

```ts
    else if (a === 'doctor' && command === null && positional.length === 0) command = 'doctor';
    else if (a === 'serve' && command === null && positional.length === 0) command = 'serve';
    else positional.push(a);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/args.ts tests/args.test.ts
git commit -m "feat: parse 'serve' subcommand in args"
```

---

## Task 5: `cli.ts` wiring — `blox serve` + run-flow

**Files:**
- Modify: `src/cli.ts`

No unit test (the CLI calls `process.exit`; it is covered by the existing `--mock` smoke e2e plus `tsc`/build). The serve units are tested in Tasks 1–4.

- [ ] **Step 1: Add imports**

In `src/cli.ts`, add to the import block:

```ts
import { ensureServe, stopServe, registerServeTeardown, type ServeSession } from './sync/serve.js';
```

- [ ] **Step 2: Add the `serve` command branch**

In `main()`, after the `doctor` branch and before the `if (!prompt)` check, add:

```ts
  if (command === 'serve') {
    const cwd = projectPath ?? process.cwd();
    const config = loadConfig(cwd, projectPath ? { projectPath } : {});
    const session = await ensureServe(config.projectPath);
    if (session.mode === 'reused') {
      console.log(`rojo serve already running at ${session.url} — nothing to manage`);
      process.exit(0);
    }
    console.log(`rojo serve up on :${session.port} (${session.url})`);
    console.log("→ click Connect in Studio's Rojo plugin to start syncing");
    console.log('   (Ctrl-C to stop)');
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      process.on('SIGINT', done);
      process.on('SIGTERM', done);
    });
    await stopServe(session);
    process.exit(0);
  }
```

- [ ] **Step 3: Wire serve into the run flow**

Replace the run body (from `const bridge = ...` through the final `process.exit(...)`) with:

```ts
  const bridge = mock ? createMockStudioBridge() : createStudioMcpBridge();
  const options = buildQueryOptions(config, bridge, digest);

  // Mock runs never touch real Studio/serve. Real runs ensure the rojo serve
  // sync channel is up (reuse-first); a serve failure is non-fatal — the run
  // proceeds but the agent's verify loop may see stale files.
  let session: ServeSession | null = null;
  if (!mock) {
    try {
      session = await ensureServe(config.projectPath);
      if (session.mode === 'spawned') {
        registerServeTeardown(session);
        console.log(`rojo serve up on :${session.port} — click Connect in Studio's Rojo plugin`);
      }
    } catch (e) {
      console.error(`warning: could not start rojo serve: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  try {
    const agent = await runAgent(prompt, options);
    const sync = await syncProject(config.projectPath);
    const commit = sync.ok
      ? await commitChanges(config.projectPath, `blox: ${prompt}`.slice(0, 72))
      : { sha: null, files: [] };

    const report: RunReport = {
      prompt,
      changedFiles: commit.files,
      commitSha: commit.sha,
      numTurns: agent.numTurns,
      costUsd: agent.costUsd,
      status: agent.status === 'success' && sync.ok ? 'success' : 'error',
      stopReason: agent.stopReason,
      detail: sync.ok ? agent.detail : sync.detail,
    };
    console.log(formatReport(report));
    process.exitCode = report.status === 'success' ? 0 : 1;
  } finally {
    if (session) await stopServe(session);
  }
```

Note: this switches the final exit from `process.exit(...)` to `process.exitCode = ...` so the `finally` (`stopServe`) runs before the process ends. Verify the `RunReport` / `formatReport` import is still present (it is).

- [ ] **Step 4: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: no type errors; `dist/cli.js` rebuilt.

- [ ] **Step 5: Verify mock smoke path still skips serve**

Run: `BLOX_E2E=0 npx vitest run tests/e2e/smoke.test.ts` (stays skipped without keys) then confirm a manual mock run does not spawn rojo:

Run: `node dist/cli.js --mock --project test-fixtures/game "Add a one-line comment to Greeter.luau" ; pgrep -af "rojo serve" || echo "no orphan serve"`
Expected: run exits; `no orphan serve` printed (mock skips `ensureServe`).

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat: blox serve command + run-flow serve lifecycle (skip on mock, non-fatal, teardown)"
```

---

## Task 6: Gated live test

**Files:**
- Create: `tests/e2e/live-serve.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/e2e/live-serve.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { ensureServe, stopServe, serveUrl, rojoServePort } from '../../src/sync/serve.js';
import { checkRojoServe } from '../../src/sync/serveCheck.js';

// Requires: real rojo on PATH, NO serve already on the port. No Studio/plugin needed.
const enabled = process.env.BLOX_LIVE_SERVE === '1';
const project = resolve(__dirname, '../../test-fixtures/game');

describe.skipIf(!enabled)('blox-managed rojo serve lifecycle', () => {
  it('spawns a real serve, becomes reachable, then tears it down', async () => {
    const url = serveUrl(rojoServePort());
    const pre = await checkRojoServe(url);
    expect(pre.reachable).toBe(false); // test requires no pre-existing serve

    const session = await ensureServe(project, { attempts: 20, delayMs: 500 });
    try {
      expect(session.mode).toBe('spawned');
      const up = await checkRojoServe(url);
      expect(up.reachable).toBe(true);
    } finally {
      await stopServe(session);
    }

    // Port is free again after teardown (retry a few times for OS release).
    let down = false;
    for (let i = 0; i < 6 && !down; i++) {
      down = !(await checkRojoServe(url)).reachable;
      if (!down) await new Promise((r) => setTimeout(r, 500));
    }
    expect(down).toBe(true);
  }, 60_000);
});
```

- [ ] **Step 2: Verify it skips without the flag**

Run: `npx vitest run tests/e2e/live-serve.test.ts`
Expected: 1 skipped.

- [ ] **Step 3: Run it live (manual gate)**

Ensure no serve is running, then:
Run: `BLOX_LIVE_SERVE=1 npx vitest run tests/e2e/live-serve.test.ts`
Expected: PASS — spawns rojo serve, reachable, torn down, port free.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/live-serve.test.ts
git commit -m "test: gated live test for blox-managed rojo serve lifecycle"
```

---

## Task 7: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole unit suite**

Run: `npx vitest run`
Expected: all prior tests + new serve/args tests PASS; gated e2e (live-studio, live-sync, live-serve, smoke) SKIPPED.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `dist/cli.js` present.

- [ ] **Step 3: Doctor sanity (optional, live)**

Run: `node dist/cli.js doctor`
Expected: unchanged doctor output (this slice does not modify doctor).

- [ ] **Step 4: Final commit if anything was adjusted**

```bash
git add -A
git commit -m "chore: SP1c-c verification pass" || echo "nothing to commit"
```

---

## Self-Review Notes

- **Spec coverage:** seam (§4.1 → T1), `ensureServe`/`stopServe` (§4.2 → T2), signal teardown (§4.3 → T3), `serve` arg (§4.2 → T4), `blox serve` + run wiring + mock-skip (§4.2 → T5), unit matrix (§6.1 → T2/T3), gated live (§6.2 → T6), port config (§3 → T1).
- **Reuse-first invariant:** `stopServe`/`registerServeTeardown` both early-return on `mode !== 'spawned'` — a reused serve is never killed (success criteria §8).
- **Out of scope (untouched):** plugin-connect detection, the PreToolUse sourcemap hook (`src/agent/hooks.ts`), tier-2 play.
- **Type consistency:** `ServeSession { mode, url, port, handle }`, `ensureServe(projectPath, opts)`, `stopServe(session)`, `registerServeTeardown(session, {proc, exit})` used identically across tasks and the live test.
