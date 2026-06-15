# blox Panel Control Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the run-scoped dock panel into a persistent control server so the Studio plugin can pick a model (from CCR config) and launch runs from the dock.

**Architecture:** A new `blox panel serve` daemon reuses `PanelServer` (events + gates) and adds `GET /api/v1/models`, `POST /api/v1/run`, `POST /api/v1/cancel`. The run pipeline is extracted from `cli.ts` into `runOnce` so both the CLI and the daemon share it. Model selection rides the `provider,model` request string (`openrouter,<slug>`), which CCR routes per-request — no CCR restart or config rewrite.

**Tech Stack:** TypeScript (Node 20, ESM), vitest, the existing `PanelServer` HTTP layer, `claude-code-router` (CCR), Roblox Luau plugin.

---

## File structure

- **Create** `src/ccr.ts` — read CCR config (`models[]`, provider, current); format the `provider,model` string. Pure, no I/O beyond one file read.
- **Create** `src/run.ts` — `runOnce()`: the shared run pipeline (options → runAgent → sync → commit → `RunReport`). Extracted from `cli.ts`.
- **Create** `src/panel/daemon.ts` — `createController()` (run-state machine, model validation) + `startDaemon()` (wires `PanelServer` + `runOnce` + CCR).
- **Modify** `src/panel/events.ts` — `PROTOCOL_VERSION = 4`; add `model` to `run_started`.
- **Modify** `src/panel/server.ts` — controller attach point, `setRunId`, three new routes, `state` in `/info`.
- **Modify** `src/cli.ts` — use `runOnce`; add `model` to its `run_started` emit; add `blox panel serve` subcommand.
- **Modify** `src/args.ts` — recognize `panel serve` (the `panel` command already exists; `serve` arrives as the prompt positional).
- **Modify** `plugin/src/Ui.luau` — model button, prompt box, Launch/Cancel buttons.
- **Modify** `plugin/src/init.server.luau` — `PROTOCOL = 4`; fetch `/models`, cycle model, post `/run` and `/cancel`, track run state.
- **Create** `tests/ccr.test.ts`, `tests/panel.control.test.ts`, `tests/daemon.test.ts`.

---

### Task 0: Pre-flight — verify CCR honors per-request `provider,model` routing

The whole model-plumbing approach assumes CCR routes by the request's `model` field when it's `provider,model`. Confirm before building anything that depends on it. **Blocking gate.**

- [ ] **Step 1: Ensure CCR is running with the OpenRouter provider configured**

Run: `ccr status; ss -ltnp | grep 3456`
Expected: a node process bound on `127.0.0.1:3456` (ignore a "Not Running" line — that status check is unreliable in CCR 2.0.0).

- [ ] **Step 2: Curl CCR with an explicit `provider,model` and a non-default model**

Run:
```bash
curl -s --max-time 60 http://127.0.0.1:3456/v1/messages \
  -H "content-type: application/json" -H "x-api-key: sk-ccr-local" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"openrouter,google/gemini-2.5-pro","max_tokens":20,"messages":[{"role":"user","content":"reply with the single word OK"}]}'
```
Expected: a `200` Anthropic-format message whose top-level `"model"` reflects a **gemini** id (not sonnet). That proves per-request routing.

- [ ] **Step 3: Record the outcome**

If gemini answered → proceed; the daemon sends `provider,slug` as the model. If it routed to `Router.default` (sonnet) instead → **stop and switch to the contingency**: the daemon rewrites `Router.default` + runs `ccr restart` on each `/run` (documented in spec §4.4). Note which path you're on at the top of `src/panel/daemon.ts` as a comment. No commit (verification only).

---

### Task 1: CCR config reader (`src/ccr.ts`)

**Files:**
- Create: `src/ccr.ts`
- Test: `tests/ccr.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/ccr.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readCcrModels, resolveModel } from '../src/ccr.js';

const tmp = join(tmpdir(), `ccr-test-${process.pid}.json`);
afterEach(() => { try { rmSync(tmp); } catch { /* ignore */ } });

describe('readCcrModels', () => {
  it('reads provider, models, and current slug from Router.default', () => {
    writeFileSync(tmp, JSON.stringify({
      Providers: [{ name: 'openrouter', models: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro'] }],
      Router: { default: 'openrouter,google/gemini-2.5-pro' },
    }));
    expect(readCcrModels(tmp)).toEqual({
      provider: 'openrouter',
      models: ['anthropic/claude-sonnet-4.5', 'google/gemini-2.5-pro'],
      current: 'google/gemini-2.5-pro',
    });
  });

  it('returns empties when the file is missing', () => {
    expect(readCcrModels(join(tmpdir(), 'does-not-exist-xyz.json')))
      .toEqual({ provider: null, models: [], current: null });
  });

  it('returns empties when the file is malformed', () => {
    writeFileSync(tmp, 'not json {');
    expect(readCcrModels(tmp)).toEqual({ provider: null, models: [], current: null });
  });
});

describe('resolveModel', () => {
  it('prefixes the provider', () => {
    expect(resolveModel('openrouter', 'google/gemini-2.5-pro')).toBe('openrouter,google/gemini-2.5-pro');
  });
  it('passes the slug through when there is no provider', () => {
    expect(resolveModel(null, 'claude-opus-4-8')).toBe('claude-opus-4-8');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ccr.test.ts`
Expected: FAIL — `Cannot find module '../src/ccr.js'`.

- [ ] **Step 3: Write the implementation**

```typescript
// src/ccr.ts
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CcrModels {
  provider: string | null;
  models: string[];
  current: string | null;
}

export function ccrConfigPath(): string {
  return process.env.CCR_CONFIG ?? join(homedir(), '.claude-code-router', 'config.json');
}

// Read the first provider's model list + the Router.default slug. Any failure
// (missing file, bad JSON, unexpected shape) degrades to empties — the daemon
// surfaces "no models" rather than crashing.
export function readCcrModels(path: string = ccrConfigPath()): CcrModels {
  const empty: CcrModels = { provider: null, models: [], current: null };
  if (!existsSync(path)) return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return empty;
  }
  const cfg = raw as {
    Providers?: { name?: unknown; models?: unknown }[];
    Router?: { default?: unknown };
  };
  const p = cfg.Providers?.[0];
  const provider = typeof p?.name === 'string' ? p.name : null;
  const models = Array.isArray(p?.models)
    ? (p!.models as unknown[]).filter((m): m is string => typeof m === 'string')
    : [];
  const def = typeof cfg.Router?.default === 'string' ? cfg.Router.default : null;
  // Router.default is "provider,slug"; the slug is everything after the first comma.
  const current = def ? (def.includes(',') ? def.slice(def.indexOf(',') + 1) : def) : null;
  return { provider, models, current };
}

// The model string blox sends so CCR routes per-request (bypassing Router.default).
export function resolveModel(provider: string | null, slug: string): string {
  return provider ? `${provider},${slug}` : slug;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/ccr.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/ccr.ts tests/ccr.test.ts
git commit -m "feat(panel): CCR config reader + provider,model resolver"
```

---

### Task 2: Protocol v4 — add `model` to `run_started`

**Files:**
- Modify: `src/panel/events.ts:4` and the `run_started` union member

- [ ] **Step 1: Bump the protocol version**

In `src/panel/events.ts`, change:
```typescript
export const PROTOCOL_VERSION = 3;
```
to:
```typescript
export const PROTOCOL_VERSION = 4;
```

- [ ] **Step 2: Add `model` to the `run_started` event**

In `src/panel/events.ts`, change the `run_started` union member:
```typescript
  | { type: 'run_started'; runId: string; prompt: string; mode: 'auto' | 'ask'; maxTurns: number; maxBudgetUsd: number }
```
to:
```typescript
  | { type: 'run_started'; runId: string; prompt: string; mode: 'auto' | 'ask'; maxTurns: number; maxBudgetUsd: number; model: string }
```

- [ ] **Step 3: Verify the type breaks the existing emit site**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: error at `src/cli.ts` `run_started` emit — `model` is missing. (Fixed in Task 4.) This confirms the field is now required.

- [ ] **Step 4: Commit**

```bash
git add src/panel/events.ts
git commit -m "feat(panel): protocol v4 — model on run_started"
```

---

### Task 3: Extract `runOnce` (`src/run.ts`)

**Files:**
- Create: `src/run.ts`
- Modify: `src/cli.ts:197-231` (replace the inline run/sync/commit/report block; add `model` to the `run_started` emit)

- [ ] **Step 1: Create `src/run.ts`**

```typescript
// src/run.ts
import type { BloxConfig } from './config.js';
import type { StudioBridge } from './bridge/types.js';
import type { ProjectDigest } from './context/digest.js';
import type { ImageInput } from './agent/imageInput.js';
import type { EventSink } from './panel/events.js';
import type { PanelGateChannel } from './agent/buildOptions.js';
import type { ResultRecord } from './panel/gates.js';
import { buildQueryOptions } from './agent/buildOptions.js';
import { runAgent } from './agent/runAgent.js';
import { syncProject } from './sync/rojo.js';
import { commitChanges } from './git/commit.js';
import type { RunReport } from './report.js';

export interface RunOnceDeps {
  bridge: StudioBridge;
  digest: ProjectDigest;
  gate?: PanelGateChannel;
  sink?: EventSink;
  image?: ImageInput;
  verify?: boolean;
  dockDeniedTools?: () => string[];
  resultDecisions?: () => ResultRecord[];
}

// The shared run pipeline: build options → run the agent → sync to disk →
// commit → assemble the report. Callers own everything around it (digest,
// bridge, rojo serve, panel lifecycle, run_started/run_finished emits, exit
// codes). Used by both the CLI one-shot and the panel daemon.
export async function runOnce(config: BloxConfig, prompt: string, deps: RunOnceDeps): Promise<RunReport> {
  const options = buildQueryOptions(config, deps.bridge, deps.digest, deps.gate, {
    image: !!deps.image,
    verify: deps.verify,
  });
  const agent = await runAgent(prompt, options, {
    sink: deps.sink,
    dockDeniedTools: deps.dockDeniedTools,
    image: deps.image,
  });
  const sync = await syncProject(config.projectPath);
  const commit = sync.ok
    ? await commitChanges(config.projectPath, `blox: ${prompt}`.slice(0, 72))
    : { sha: null, files: [] };
  return {
    prompt,
    changedFiles: commit.files,
    commitSha: commit.sha,
    numTurns: agent.numTurns,
    costUsd: agent.costUsd,
    status: agent.status === 'success' && sync.ok ? 'success' : 'error',
    stopReason: agent.stopReason,
    detail: sync.ok ? agent.detail : sync.detail,
    mode: config.mode,
    effort: config.effort,
    sessionId: agent.sessionId,
    gatedActions: agent.gatedActions,
    deniedByUser: agent.deniedByUser,
    assetDecisions: deps.resultDecisions?.(),
  };
}
```

- [ ] **Step 2: Rewrite the `cli.ts` run block to call `runOnce`**

In `src/cli.ts`, add the import near the other agent imports (after line 10):
```typescript
import { runOnce } from './run.js';
```
Replace the `try { … } finally { … }` body at `src/cli.ts:197-244` with:
```typescript
  try {
    panel?.emit({
      type: 'run_started',
      runId,
      prompt,
      mode: config.mode,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      model: config.model,
    });
    const report = await runOnce(config, prompt, {
      bridge,
      digest,
      gate,
      sink: panel ?? undefined,
      image,
      verify: args.verify,
      dockDeniedTools: panel ? () => panel!.gates.dockDeniedTools() : undefined,
      resultDecisions: panel ? () => panel!.gates.resultDecisions() : undefined,
    });
    panel?.emit({
      type: 'run_finished',
      status: report.status,
      stopReason: report.stopReason,
      turns: report.numTurns,
      costUsd: report.costUsd,
    });
    console.log(formatReport(report));
    process.exitCode = report.status === 'success' ? 0 : 1;
  } finally {
    if (session) await stopServe(session);
    if (panel) await panel.stop();
  }
```
Then delete the now-unused imports in `cli.ts` that moved into `run.ts` **only if no longer referenced**: check `buildQueryOptions`, `runAgent`, `syncProject`, `commitChanges`. `buildQueryOptions` is no longer used in `cli.ts` (runOnce builds options) — remove its import (line 9). `runAgent` (line 10) — remove. `syncProject` (line 5) and `commitChanges` (line 6) — remove. Keep `formatReport`/`RunReport` (line 15) — still used.

- [ ] **Step 3: Typecheck**

Run: `npx tsc -p tsconfig.json --noEmit`
Expected: PASS (the Task 2 `run_started` error is now resolved; no unused-import or missing-symbol errors).

- [ ] **Step 4: Run the full suite (refactor safety net)**

Run: `npm test`
Expected: PASS — same count as before the refactor (no behavior change). If anything fails, the extraction dropped or reordered a step — diff against the original `cli.ts:197-244`.

- [ ] **Step 5: Mock smoke (no network model call needed to prove wiring compiles/runs to the model call)**

Run: `node dist/cli.js --project /home/myen/blox-playground --mock "noop"` after `npm run build`.
Expected: it reaches the agent call (mock Studio bridge); a model/network error is acceptable here — we're confirming the refactored path executes up to `runAgent`, not a full run.

- [ ] **Step 6: Commit**

```bash
git add src/run.ts src/cli.ts
git commit -m "refactor(cli): extract run pipeline into runOnce; emit model on run_started"
```

---

### Task 4: Controller interface + new routes in `PanelServer`

**Files:**
- Modify: `src/panel/server.ts`
- Test: `tests/panel.control.test.ts`

- [ ] **Step 1: Write the failing test (routes with a fake controller)**

```typescript
// tests/panel.control.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { PanelServer, type PanelController } from '../src/panel/server.js';

let server: PanelServer | null = null;
afterEach(async () => { if (server) await server.stop(); server = null; });

function fakeController(over: Partial<PanelController> = {}): PanelController {
  return {
    listModels: () => ({ provider: 'openrouter', models: ['google/gemini-2.5-pro'], current: 'google/gemini-2.5-pro' }),
    launch: () => ({ ok: true, runId: 'run-1' }),
    cancel: () => ({ ok: false }),
    state: () => 'idle',
    ...over,
  };
}

async function start(controller?: PanelController): Promise<string> {
  server = new PanelServer({ runId: 'idle', project: 'g', port: 0, holdMs: 50 });
  if (controller) server.attachController(controller);
  const port = await server.start();
  return `http://127.0.0.1:${port}/api/v1`;
}

describe('panel control routes', () => {
  it('GET /models returns the controller list', async () => {
    const base = await start(fakeController());
    const r = await fetch(`${base}/models`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ provider: 'openrouter', models: ['google/gemini-2.5-pro'], current: 'google/gemini-2.5-pro' });
  });

  it('POST /run returns 202 and the runId on success', async () => {
    const base = await start(fakeController());
    const r = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi', model: 'google/gemini-2.5-pro' }) });
    expect(r.status).toBe(202);
    expect(await r.json()).toEqual({ runId: 'run-1' });
  });

  it('POST /run with empty prompt is 400', async () => {
    const base = await start(fakeController());
    const r = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: '  ', model: 'google/gemini-2.5-pro' }) });
    expect(r.status).toBe(400);
  });

  it('POST /run surfaces a controller rejection (busy → 409)', async () => {
    const base = await start(fakeController({ launch: () => ({ ok: false, status: 409, error: 'busy' }) }));
    const r = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'hi', model: 'x' }) });
    expect(r.status).toBe(409);
  });

  it('GET /info includes state when a controller is attached', async () => {
    const base = await start(fakeController({ state: () => 'running' }));
    expect((await (await fetch(`${base}/info`)).json()).state).toBe('running');
  });

  it('control routes 404 without a controller (one-shot mode)', async () => {
    const base = await start();
    expect((await fetch(`${base}/models`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/panel.control.test.ts`
Expected: FAIL — `attachController` is not a function / `PanelController` not exported.

- [ ] **Step 3: Add the controller type, attach point, runId setter, and routes**

In `src/panel/server.ts`, after the `PanelServerOptions` interface, add:
```typescript
export interface PanelController {
  listModels(): { provider: string | null; models: string[]; current: string | null };
  launch(prompt: string, model: string): { ok: true; runId: string } | { ok: false; status: number; error: string };
  cancel(): { ok: boolean };
  state(): 'idle' | 'running';
}
```
Inside the `PanelServer` class, add fields (near `private lastPollAt = 0;`):
```typescript
  private controller: PanelController | null = null;
  private currentRunId: string;
```
In the constructor, after `this.opts = { … }`, add:
```typescript
    this.currentRunId = this.opts.runId;
```
Add two public methods (after `emit`):
```typescript
  attachController(controller: PanelController): void {
    this.controller = controller;
  }

  setRunId(runId: string): void {
    this.currentRunId = runId;
  }
```
In `route()`, change the `/info` handler to include `state` and the live runId:
```typescript
      if (req.method === 'GET' && url.pathname === '/api/v1/info') {
        return json(res, 200, {
          protocol: PROTOCOL_VERSION,
          runId: this.currentRunId,
          project: this.opts.project,
          ...(this.controller ? { state: this.controller.state() } : {}),
        });
      }
```
Then, immediately before the final `return json(res, 404, { error: 'not found' });`, add:
```typescript
      if (req.method === 'GET' && url.pathname === '/api/v1/models') {
        if (!this.controller) return json(res, 404, { error: 'not found' });
        return json(res, 200, this.controller.listModels());
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/run') {
        if (!this.controller) return json(res, 404, { error: 'not found' });
        const body = (await readJson(req)) as { prompt?: unknown; model?: unknown } | null;
        const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
        const model = typeof body?.model === 'string' ? body.model : '';
        if (!prompt) return json(res, 400, { error: 'prompt required' });
        if (!model) return json(res, 400, { error: 'model required' });
        const r = this.controller.launch(prompt, model);
        return r.ok ? json(res, 202, { runId: r.runId }) : json(res, r.status, { error: r.error });
      }
      if (req.method === 'POST' && url.pathname === '/api/v1/cancel') {
        if (!this.controller) return json(res, 404, { error: 'not found' });
        const r = this.controller.cancel();
        return r.ok ? json(res, 200, { ok: true }) : json(res, 409, { error: 'no run active' });
      }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/panel.control.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck + full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npm test`
Expected: PASS (existing tests unaffected — `/info` still returns `runId`/`project`/`protocol`; the new fields are additive).

- [ ] **Step 6: Commit**

```bash
git add src/panel/server.ts tests/panel.control.test.ts
git commit -m "feat(panel): control routes (models/run/cancel) + controller hook"
```

---

### Task 5: Daemon controller state machine (`src/panel/daemon.ts`)

**Files:**
- Create: `src/panel/daemon.ts` (controller factory only in this task; wiring in Task 6)
- Test: `tests/daemon.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/daemon.test.ts
import { describe, it, expect, vi } from 'vitest';
import { createController, type RunFn } from '../src/panel/daemon.js';

const models = { provider: 'openrouter', models: ['google/gemini-2.5-pro'], current: 'google/gemini-2.5-pro' };
const server = () => ({ setRunId: vi.fn() });

describe('createController', () => {
  it('launches when idle and flips to running, then back to idle when the run resolves', async () => {
    let release!: () => void;
    const run: RunFn = () => new Promise<void>((r) => { release = r; });
    const srv = server();
    const c = createController(srv as never, { listModels: () => models, run, newRunId: () => 'run-1' });

    expect(c.state()).toBe('idle');
    const r = c.launch('build a frame', 'google/gemini-2.5-pro');
    expect(r).toEqual({ ok: true, runId: 'run-1' });
    expect(srv.setRunId).toHaveBeenCalledWith('run-1');
    expect(c.state()).toBe('running');

    release();
    await new Promise((res) => setTimeout(res, 0));
    expect(c.state()).toBe('idle');
  });

  it('rejects a second launch while running (409)', () => {
    const run: RunFn = () => new Promise<void>(() => {});
    const c = createController(server() as never, { listModels: () => models, run, newRunId: () => 'x' });
    c.launch('a', 'google/gemini-2.5-pro');
    expect(c.launch('b', 'google/gemini-2.5-pro')).toEqual({ ok: false, status: 409, error: 'a run is already in progress' });
  });

  it('rejects an unknown model (400)', () => {
    const run: RunFn = vi.fn(() => Promise.resolve());
    const c = createController(server() as never, { listModels: () => models, run });
    const r = c.launch('a', 'mistral/whatever');
    expect(r).toEqual({ ok: false, status: 400, error: 'unknown model: mistral/whatever' });
    expect(run).not.toHaveBeenCalled();
  });

  it('returns to idle even when the run rejects', async () => {
    const run: RunFn = () => Promise.reject(new Error('boom'));
    const c = createController(server() as never, { listModels: () => models, run, newRunId: () => 'x' });
    c.launch('a', 'google/gemini-2.5-pro');
    await new Promise((res) => setTimeout(res, 0));
    expect(c.state()).toBe('idle');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/daemon.test.ts`
Expected: FAIL — `Cannot find module '../src/panel/daemon.js'`.

- [ ] **Step 3: Write the controller factory**

```typescript
// src/panel/daemon.ts
import { randomUUID } from 'node:crypto';
import type { PanelServer, PanelController } from './server.js';
import type { CcrModels } from '../ccr.js';

// The daemon's run launcher: emits run_started/run_finished around runOnce.
// Injected so the state machine is unit-testable without a real run.
export interface RunFn {
  (prompt: string, slug: string, runId: string): Promise<void>;
}

export interface ControllerDeps {
  listModels: () => CcrModels;
  run: RunFn;
  newRunId?: () => string;
}

// One run at a time. launch() validates the model against the live CCR list,
// flips state to running, assigns a fresh runId (so the dock resets its event
// cursor), and kicks the injected run — returning to idle when it settles,
// success or failure.
export function createController(
  server: Pick<PanelServer, 'setRunId'>,
  deps: ControllerDeps,
): PanelController {
  let state: 'idle' | 'running' = 'idle';
  const newRunId = deps.newRunId ?? (() => randomUUID());
  return {
    listModels: deps.listModels,
    state: () => state,
    cancel: () => ({ ok: false }), // Phase-1 stretch — see Task 8
    launch(prompt, slug) {
      if (state === 'running') {
        return { ok: false, status: 409, error: 'a run is already in progress' };
      }
      if (!deps.listModels().models.includes(slug)) {
        return { ok: false, status: 400, error: `unknown model: ${slug}` };
      }
      const runId = newRunId();
      state = 'running';
      server.setRunId(runId);
      void deps
        .run(prompt, slug, runId)
        .catch(() => {
          /* run failure is reported via run_finished in the RunFn; swallow here */
        })
        .finally(() => {
          state = 'idle';
        });
      return { ok: true, runId };
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/daemon.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/panel/daemon.ts tests/daemon.test.ts
git commit -m "feat(panel): daemon controller state machine"
```

---

### Task 6: Daemon wiring + `blox panel serve`

**Files:**
- Modify: `src/panel/daemon.ts` (add `startDaemon`)
- Modify: `src/cli.ts` (the `panel` command branch)

- [ ] **Step 1: Add `startDaemon` to `src/panel/daemon.ts`**

Add these imports at the top:
```typescript
import { PanelServer } from './server.js';
import { readCcrModels, resolveModel } from '../ccr.js';
import { runOnce } from '../run.js';
import { buildDigest } from '../context/digest.js';
import { createStudioMcpBridge } from '../bridge/mcpBridge.js';
import { ensureServe } from '../sync/serve.js';
import type { BloxConfig } from '../config.js';
```
Append:
```typescript
// Persistent control server. Builds the digest once, then serves the dock and
// launches a run per POST /api/v1/run. rojo serve is reuse-first per run; CCR
// config is read fresh each time so dropdown + routing reflect edits.
export async function startDaemon(config: BloxConfig): Promise<PanelServer> {
  const digest = buildDigest(config.projectPath);
  const server = new PanelServer({
    runId: 'idle',
    project: digest.name,
    port: config.panel.port,
    gateTimeoutMs: config.panel.gateTimeoutSeconds * 1000,
  });
  await server.start();

  const run: RunFn = async (prompt, slug, runId) => {
    const ccr = readCcrModels();
    const modelString = resolveModel(ccr.provider, slug);
    const runConfig: BloxConfig = { ...config, model: modelString };
    const bridge = createStudioMcpBridge();
    try {
      await ensureServe(config.projectPath);
    } catch {
      /* serve is non-fatal; the verify loop may see stale files */
    }
    const gate = {
      isConnected: () => server.isConnected(),
      request: (tool: string, input: Record<string, unknown>) => server.gates.request(tool, input),
      requestResult: (tool: string, tag: string | null, inputSummary: string) =>
        server.gates.requestResult(tool, tag, inputSummary),
    };
    server.emit({
      type: 'run_started',
      runId,
      prompt,
      mode: runConfig.mode,
      maxTurns: runConfig.maxTurns,
      maxBudgetUsd: runConfig.maxBudgetUsd,
      model: modelString,
    });
    let report;
    try {
      report = await runOnce(runConfig, prompt, {
        bridge,
        digest,
        gate,
        sink: server,
        dockDeniedTools: () => server.gates.dockDeniedTools(),
        resultDecisions: () => server.gates.resultDecisions(),
      });
    } finally {
      // Always close the run on the dock, even on a thrown runOnce.
      server.emit({
        type: 'run_finished',
        status: report ? report.status : 'error',
        stopReason: report ? report.stopReason : 'error',
        turns: report ? report.numTurns : 0,
        costUsd: report ? report.costUsd : 0,
      });
    }
  };

  const controller = createController(server, { listModels: () => readCcrModels(), run });
  server.attachController(controller);
  return server;
}
```

- [ ] **Step 2: Wire `blox panel serve` in `cli.ts`**

In `src/cli.ts`, add the import:
```typescript
import { startDaemon } from './panel/daemon.js';
```
In the `if (command === 'panel') { … }` branch, change the guard so `serve` is handled. Replace the branch body's top with:
```typescript
  if (command === 'panel') {
    if (prompt === 'serve') {
      const cwd = projectPath ?? process.cwd();
      const config = loadConfig(cwd, projectPath ? { projectPath } : {});
      const server = await startDaemon(config);
      console.log(`blox panel daemon on :${config.panel.port} — open the blox dock in Studio`);
      console.log('   (Ctrl-C to stop)');
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        process.on('SIGINT', done);
        process.on('SIGTERM', done);
      });
      await server.stop();
      process.exit(0);
    }
    if (prompt !== 'install') {
      console.error('usage: blox panel install | blox panel serve');
      process.exit(2);
    }
    // …existing install logic unchanged…
```
Update the existing `panel install` usage string and the top-level usage line (line 111) to mention `blox panel serve`.

- [ ] **Step 3: Typecheck + full suite**

Run: `npx tsc -p tsconfig.json --noEmit && npm test`
Expected: PASS.

- [ ] **Step 4: Smoke — daemon boots and serves /models**

Run: `npm run build && (node dist/cli.js panel serve --project /home/myen/blox-playground &) && sleep 2 && curl -s http://127.0.0.1:35768/api/v1/models && curl -s http://127.0.0.1:35768/api/v1/info`
Expected: `/models` returns the CCR models JSON; `/info` shows `"state":"idle"` and `"protocol":4`. Then `kill %1` (or the daemon pid).

- [ ] **Step 5: Commit**

```bash
git add src/panel/daemon.ts src/cli.ts
git commit -m "feat(panel): blox panel serve daemon — dock-launched runs + model routing"
```

---

### Task 7: Plugin UI — model picker, prompt box, Launch/Cancel

No Luau unit harness in this repo; verify by load + manual smoke (Task 8). Keep `Ui.luau` logic-free (it returns refs); wire behavior in `init.server.luau`.

**Files:**
- Modify: `plugin/src/Ui.luau`
- Modify: `plugin/src/init.server.luau`

- [ ] **Step 1: Add a Controls card to `Ui.luau`**

In `Ui.build`, after the `status` label (line 32) and before the ImageGate frame, insert:
```lua
	-- Controls card: model picker + prompt + launch/cancel (protocol v4).
	local controls = Instance.new("Frame")
	controls.Name = "Controls"
	controls.LayoutOrder = 1.5
	controls.Size = UDim2.new(1, -8, 0, 96)
	controls.BackgroundColor3 = Color3.fromRGB(30, 36, 46)
	controls.Parent = root

	local modelButton = Instance.new("TextButton")
	modelButton.Name = "Model"
	modelButton.Text = "model: (loading…)"
	modelButton.Position = UDim2.fromOffset(4, 4)
	modelButton.Size = UDim2.new(1, -8, 0, 22)
	modelButton.BackgroundColor3 = Color3.fromRGB(50, 50, 60)
	modelButton.TextColor3 = Color3.fromRGB(220, 220, 220)
	modelButton.TextXAlignment = Enum.TextXAlignment.Left
	modelButton.Font = Enum.Font.Code
	modelButton.TextSize = 14
	modelButton.Parent = controls

	local promptBox = Instance.new("TextBox")
	promptBox.Name = "Prompt"
	promptBox.PlaceholderText = "what should blox build?"
	promptBox.Text = ""
	promptBox.Position = UDim2.fromOffset(4, 30)
	promptBox.Size = UDim2.new(1, -8, 0, 30)
	promptBox.TextWrapped = true
	promptBox.ClearTextOnFocus = false
	promptBox.BackgroundColor3 = Color3.fromRGB(50, 50, 50)
	promptBox.TextColor3 = Color3.fromRGB(220, 220, 220)
	promptBox.TextXAlignment = Enum.TextXAlignment.Left
	promptBox.Parent = controls

	local launchButton = Instance.new("TextButton")
	launchButton.Name = "Launch"
	launchButton.Text = "Launch"
	launchButton.Position = UDim2.new(0, 4, 1, -28)
	launchButton.Size = UDim2.fromOffset(100, 24)
	launchButton.BackgroundColor3 = Color3.fromRGB(40, 120, 40)
	launchButton.TextColor3 = Color3.fromRGB(255, 255, 255)
	launchButton.Parent = controls

	local cancelButton = Instance.new("TextButton")
	cancelButton.Name = "Cancel"
	cancelButton.Text = "Cancel"
	cancelButton.Position = UDim2.new(0, 112, 1, -28)
	cancelButton.Size = UDim2.fromOffset(80, 24)
	cancelButton.BackgroundColor3 = Color3.fromRGB(90, 70, 30)
	cancelButton.TextColor3 = Color3.fromRGB(255, 255, 255)
	cancelButton.Parent = controls
```
Add these four refs to the returned table:
```lua
		modelButton = modelButton,
		promptBox = promptBox,
		launchButton = launchButton,
		cancelButton = cancelButton,
```

- [ ] **Step 2: Bump protocol + add model state in `init.server.luau`**

Change line 12: `local PROTOCOL = 3` → `local PROTOCOL = 4`.
After the `local activeResultInstance` declarations (line 76), add:
```lua
local models: { string } = {}
local modelIndex = 1

local function currentModel(): string?
	return models[modelIndex]
end

local function refreshModelButton()
	local m = currentModel()
	ui.modelButton.Text = if m then "model: " .. m else "model: (none — check CCR)"
end
```

- [ ] **Step 3: Fetch models on connect**

In the poll loop, inside the `if info then` block (after the protocol check, ~line 298), add:
```lua
				local ml = request("GET", "/models")
				if ml and ml.models then
					models = ml.models
					if ml.current then
						for i, name in models do
							if name == ml.current then
								modelIndex = i
								break
							end
						end
					end
					refreshModelButton()
				end
```

- [ ] **Step 4: Wire the model cycle, Launch, and Cancel buttons**

After the existing `ui.imageButton.MouseButton1Click:Connect(...)` block (~line 273), add:
```lua
ui.modelButton.MouseButton1Click:Connect(function()
	if #models == 0 then
		return
	end
	modelIndex = (modelIndex % #models) + 1
	refreshModelButton()
end)

ui.launchButton.MouseButton1Click:Connect(function()
	local prompt = ui.promptBox.Text
	local model = currentModel()
	if prompt == "" or not model then
		ui.status.Text = "enter a prompt and pick a model"
		return
	end
	ui.launchButton.Active = false
	ui.launchButton.BackgroundColor3 = Color3.fromRGB(60, 60, 60)
	local res = request("POST", "/run", { prompt = prompt, model = model })
	if not res then
		ui.status.Text = "launch failed — is blox panel serve running?"
		ui.launchButton.Active = true
		ui.launchButton.BackgroundColor3 = Color3.fromRGB(40, 120, 40)
	end
end)

ui.cancelButton.MouseButton1Click:Connect(function()
	request("POST", "/cancel", nil)
end)
```

- [ ] **Step 5: Re-enable Launch on run end + show model on run start**

In `handleEvent`, change the `run_started` branch to display the model:
```lua
	if e.type == "run_started" then
		ui.status.Text = ("run %s — %s — %s"):format(e.runId:sub(1, 8), e.model or "?", e.mode)
		ui.status.TextColor3 = Color3.fromRGB(120, 200, 120)
		addLog("▶ " .. e.prompt)
```
In the `run_finished` branch, re-enable Launch (append after the existing status lines):
```lua
		ui.launchButton.Active = true
		ui.launchButton.BackgroundColor3 = Color3.fromRGB(40, 120, 40)
```

- [ ] **Step 6: Reinstall the plugin and commit**

Run: `node dist/cli.js panel install` (so Studio picks up the new plugin source).
```bash
git add plugin/src/Ui.luau plugin/src/init.server.luau
git commit -m "feat(plugin): model picker + prompt + launch/cancel (protocol v4)"
```

---

### Task 8: Cancel (stretch) — probe the SDK for an interrupt path

**Files:**
- Modify: `src/agent/runAgent.ts`, `src/run.ts`, `src/panel/daemon.ts` (only if the SDK supports interrupt)

- [ ] **Step 1: Probe whether `query()` exposes interrupt/abort**

Run: `node -e "const {query}=require('@anthropic-ai/claude-agent-sdk'); const q=query({prompt:'hi',options:{}}); console.log('interrupt:', typeof q.interrupt, 'return:', typeof q.return)"`
Expected: prints whether `interrupt` and/or `return` exist on the query object.

- [ ] **Step 2: Decide**

- If `q.interrupt` (or an `AbortController` option) exists → implement cancel: thread an abort handle from `runOnce` up to the controller, have `controller.cancel()` call it and return `{ ok: true }`. Add a test in `tests/daemon.test.ts` asserting `cancel()` invokes the injected abort and returns `{ ok: true }`.
- If neither exists → leave `cancel()` returning `{ ok: false }` (the route already 409s), and note "cancel deferred — SDK exposes no interrupt as of `@anthropic-ai/claude-agent-sdk` <version>" in `src/panel/daemon.ts`. Move on; this is a stretch goal.

- [ ] **Step 3: Commit (whichever path)**

```bash
git add -A
git commit -m "feat(panel): wire run cancel via SDK interrupt"   # or: "docs(panel): note cancel deferred — no SDK interrupt"
```

---

### Task 9: Live smoke (manual)

- [ ] **Step 1: Start CCR and the daemon**

`ccr restart` (key already in `~/.claude-code-router/config.json`), then `node dist/cli.js panel serve --project /home/myen/blox-playground`.

- [ ] **Step 2: In Studio**

Open the blox dock. Confirm the model button shows the CCR `current` model. Click it to cycle to `google/gemini-2.5-pro`. Type a prompt ("build a simple red frame UI"), click Launch.

- [ ] **Step 3: Observe**

Status shows `run … — openrouter,google/gemini-2.5-pro — auto`. Watch the log/diffs stream. **Confirm the routed model emits valid `execute_luau` tool calls** (the real test of non-Claude routing). On finish, Launch re-enables.

- [ ] **Step 4: Record findings**

Note tool-call reliability per model in the run-routing memory (`[[blox-byo-model-routing]]`): which models drive the Studio tools cleanly vs. flail.

---

## Self-review

**Spec coverage:**
- §2 persistent daemon → Task 6 (`blox panel serve`). ✓
- §2 `GET /models` → Task 4 route + Task 1 reader. ✓
- §2 `POST /run` + model plumbing → Tasks 4/5/6 + Task 0 verification + Task 1 `resolveModel`. ✓
- §2 plugin dropdown/prompt/Launch + protocol v4 → Tasks 2 + 7. ✓
- §2/§10 cancel stretch → Task 8. ✓
- §4.1 runOnce extraction → Task 3. ✓
- §4.2 CCR reader → Task 1. ✓
- §7 error handling (409 busy, 400 bad model, CCR-missing empties, run-throw → idle) → Tasks 1, 4, 5, 6. ✓
- §9 testing (unit + curl verification + live smoke) → Tasks 0–6, 9. ✓

**Placeholder scan:** No TBD/"add error handling"/bare "write tests". Cancel (Task 8) is explicitly conditional on an SDK probe, with both branches specified — not a placeholder.

**Type consistency:** `PanelController` (server.ts) is implemented by `createController` (daemon.ts) and the test fake — methods `listModels`/`launch`/`cancel`/`state` match. `RunFn(prompt, slug, runId)` consistent across daemon.ts + test. `runOnce(config, prompt, RunOnceDeps)` consistent between run.ts, cli.ts (Task 3), and daemon.ts (Task 6). `run_started` gains `model` in events.ts (Task 2) and both emit sites set it (Tasks 3, 6). `CcrModels` shape (`provider`/`models`/`current`) consistent across ccr.ts, server route, controller, plugin.
