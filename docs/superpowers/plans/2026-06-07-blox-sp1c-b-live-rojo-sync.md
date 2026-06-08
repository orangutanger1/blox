# blox SP1c-b Live Rojo File Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove (and make diagnosable) that the agent's on-disk `.luau` edits reach the live Studio via `rojo serve` + the Rojo plugin — adding a `blox doctor` sync-channel check and a gated live propagation test.

**Architecture:** A new pure unit `src/sync/serveCheck.ts` probes `rojo serve`'s `/api/rojo` over an injected fetch. `src/doctor.ts` factors its attach-retry into a shared `execLuauWithRetry` reused by `runDoctor` and a new `probeExecuteLuau` (connect→retry→close). `blox doctor` prints both the MCP and sync channels; a gated test edits a fixture module and confirms Studio sees it via `execute_luau` reading `.Source`. blox does NOT manage the serve lifecycle (deferred).

**Tech Stack:** TypeScript v6 (ESM, native compiler), vitest, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, Node 20 global `fetch` / `AbortSignal.timeout`.

**Spec:** `docs/superpowers/specs/2026-06-07-blox-sp1c-b-live-rojo-sync-design.md`

---

## File Structure

- `src/sync/serveCheck.ts` — **create**: `ServeCheckReport`, `FetchFn`, `rojoServeUrl()`, `checkRojoServe()`, `formatServeCheck()`.
- `src/doctor.ts` — **modify**: extract `execLuauWithRetry()` (shared) + export `probeExecuteLuau()` and `LuauProbeResult`; `runDoctor` reuses the shared helper (report unchanged).
- `src/cli.ts` — **modify**: `doctor` subcommand also runs + prints the sync check.
- `tests/serveCheck.test.ts` — **create**: unit tests for `checkRojoServe`/`rojoServeUrl`/`formatServeCheck`.
- `tests/doctor.test.ts` — **modify**: add `probeExecuteLuau` tests; existing tests unchanged.
- `tests/e2e/live-sync.test.ts` — **create**: gated (`BLOX_LIVE_SYNC=1`) propagation test.
- `docs/reference/roblox-studio-mcp.md` — **modify**: propagation = serve+plugin (not sourcemap); `/api/rojo` shape; live-sync setup note.

---

## Task 1: `checkRojoServe` — probe rojo serve over injected fetch

**Files:**
- Create: `src/sync/serveCheck.ts`
- Test: `tests/serveCheck.test.ts`

- [ ] **Step 1: Write the failing tests** (`tests/serveCheck.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { checkRojoServe, rojoServeUrl, formatServeCheck, type FetchFn } from '../src/sync/serveCheck.js';

const okBody = { projectName: 'blox-fixture', protocolVersion: 4, serverVersion: '7.6.1' };
const okFetch: FetchFn = async () => ({ ok: true, status: 200, json: async () => okBody });

describe('checkRojoServe', () => {
  it('reports reachable with project info on 2xx + JSON', async () => {
    const r = await checkRojoServe('http://localhost:34872', okFetch);
    expect(r.reachable).toBe(true);
    expect(r.projectName).toBe('blox-fixture');
    expect(r.protocolVersion).toBe(4);
    expect(r.detail).toMatch(/blox-fixture/);
  });

  it('hits the /api/rojo endpoint of the given url', async () => {
    let seen = '';
    const spy: FetchFn = async (url) => { seen = url; return { ok: true, status: 200, json: async () => okBody }; };
    await checkRojoServe('http://localhost:34872/', spy);
    expect(seen).toBe('http://localhost:34872/api/rojo');
  });

  it('reports unreachable when fetch throws', async () => {
    const r = await checkRojoServe('http://localhost:34872', async () => { throw new Error('ECONNREFUSED'); });
    expect(r.reachable).toBe(false);
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });

  it('reports unreachable on non-2xx', async () => {
    const r = await checkRojoServe('http://localhost:34872', async () => ({ ok: false, status: 404, json: async () => ({}) }));
    expect(r.reachable).toBe(false);
    expect(r.detail).toMatch(/404/);
  });

  it('reports unreachable on bad json', async () => {
    const r = await checkRojoServe('http://localhost:34872', async () => ({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }));
    expect(r.reachable).toBe(false);
  });
});

describe('rojoServeUrl', () => {
  it('defaults to localhost:34872', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    delete process.env.BLOX_ROJO_SERVE_URL;
    try { expect(rojoServeUrl()).toBe('http://localhost:34872'); }
    finally { if (prev !== undefined) process.env.BLOX_ROJO_SERVE_URL = prev; }
  });

  it('honors BLOX_ROJO_SERVE_URL', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    process.env.BLOX_ROJO_SERVE_URL = 'http://172.30.12.182:34872';
    try { expect(rojoServeUrl()).toBe('http://172.30.12.182:34872'); }
    finally { if (prev === undefined) delete process.env.BLOX_ROJO_SERVE_URL; else process.env.BLOX_ROJO_SERVE_URL = prev; }
  });
});

describe('formatServeCheck', () => {
  it('renders reachable distinctly from not', () => {
    expect(formatServeCheck({ reachable: true, url: 'http://localhost:34872', projectName: 'blox-fixture', detail: 'ok' })).toMatch(/SERVE REACHABLE/);
    expect(formatServeCheck({ reachable: false, url: 'http://localhost:34872', detail: 'down' })).toMatch(/NO SERVE/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/serveCheck.test.ts`
Expected: FAIL — `src/sync/serveCheck.ts` does not exist.

- [ ] **Step 3: Implement `src/sync/serveCheck.ts`**

```typescript
export interface ServeCheckReport {
  reachable: boolean;
  url: string;
  projectName?: string;
  protocolVersion?: number;
  serverVersion?: string;
  detail: string;
}

export interface FetchLike {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchFn = (url: string) => Promise<FetchLike>;

// rojo serve's info endpoint. Default 3s timeout so a dead port fails fast.
const defaultFetch: FetchFn = (url) => fetch(url, { signal: AbortSignal.timeout(3000) });

export function rojoServeUrl(): string {
  return process.env.BLOX_ROJO_SERVE_URL ?? 'http://localhost:34872';
}

export async function checkRojoServe(url: string, fetchFn: FetchFn = defaultFetch): Promise<ServeCheckReport> {
  const api = `${url.replace(/\/$/, '')}/api/rojo`;
  try {
    const res = await fetchFn(api);
    if (!res.ok) {
      return { reachable: false, url, detail: `rojo serve returned HTTP ${res.status} at ${api}` };
    }
    const body = (await res.json()) as { projectName?: string; protocolVersion?: number; serverVersion?: string };
    return {
      reachable: true, url,
      projectName: body.projectName,
      protocolVersion: body.protocolVersion,
      serverVersion: body.serverVersion,
      detail: `rojo serve reachable: project '${body.projectName ?? '?'}' (protocol ${body.protocolVersion ?? '?'}, rojo ${body.serverVersion ?? '?'})`,
    };
  } catch (err) {
    return { reachable: false, url, detail: `no rojo serve at ${api}: ${(err as Error)?.message ?? String(err)}` };
  }
}

export function formatServeCheck(r: ServeCheckReport): string {
  if (r.reachable) {
    return [`  sync:    SERVE REACHABLE (${r.url})`, `  project: ${r.projectName ?? '?'}`, `  detail:  ${r.detail}`].join('\n');
  }
  return [`  sync:    NO SERVE (${r.url})`, `  detail:  ${r.detail}`].join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/serveCheck.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/sync/serveCheck.ts tests/serveCheck.test.ts
git commit -m "feat: add checkRojoServe sync-channel probe"
```

---

## Task 2: Extract `execLuauWithRetry` + `probeExecuteLuau` in doctor

**Files:**
- Modify: `src/doctor.ts`
- Test: `tests/doctor.test.ts`

- [ ] **Step 1: Write the failing tests** (append to `tests/doctor.test.ts`)

```typescript
import { probeExecuteLuau } from '../src/doctor.js';

describe('probeExecuteLuau', () => {
  it('returns the luau result text when attached first try', async () => {
    const r = await probeExecuteLuau(launch, 'return game.X.Source', fakeFactory({}), { probeAttempts: 3, probeDelayMs: 0 });
    expect(r.attached).toBe(true);
    expect(r.text).toBe('2');
    expect(r.attempts).toBe(1);
  });

  it('retries past "no active studio" then attaches', async () => {
    let n = 0;
    const r = await probeExecuteLuau(launch, 'return 1', fakeFactory({
      callTool: async () => {
        n += 1;
        return n < 2
          ? { content: [{ type: 'text', text: 'No active Studio instance' }], isError: true }
          : { content: [{ type: 'text', text: 'SYNCED' }], isError: false };
      },
    }), { probeAttempts: 4, probeDelayMs: 0 });
    expect(r.attached).toBe(true);
    expect(r.text).toBe('SYNCED');
  });

  it('returns not-attached when no execute_luau tool is advertised', async () => {
    const r = await probeExecuteLuau(launch, 'return 1', fakeFactory({
      listTools: async () => ({ tools: [{ name: 'mcp__Roblox_Studio__script_read' }] }),
    }), { probeAttempts: 2, probeDelayMs: 0 });
    expect(r.attached).toBe(false);
  });
});
```

(The `launch` const and `fakeFactory` helper already exist at the top of `tests/doctor.test.ts` from SP1c-a; reuse them.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/doctor.test.ts`
Expected: FAIL — `probeExecuteLuau` is not exported.

- [ ] **Step 3: Add the shared helper + export** (`src/doctor.ts`)

Add this interface near `DoctorReport`:

```typescript
export interface LuauProbeResult {
  text: string;
  isError: boolean;
  attempts: number;
  attached: boolean;
}
```

Add the shared retry helper (place it just above `runDoctor`, after `withTimeout`/`NO_STUDIO`):

```typescript
async function execLuauWithRetry(
  client: DoctorClient,
  luauTool: string,
  code: string,
  timeoutMs: number,
  probeAttempts: number,
  probeDelayMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<LuauProbeResult> {
  let text = '';
  let isError = false;
  let attached = false;
  let attempt = 0;
  for (attempt = 1; attempt <= probeAttempts; attempt++) {
    const res = await withTimeout(
      client.callTool({ name: luauTool, arguments: { code } }),
      timeoutMs, 'execute_luau',
    );
    text = (res.content ?? []).map((c) => c.text ?? '').join('').trim();
    isError = res.isError === true;
    attached = !isError && !NO_STUDIO.test(text);
    if (attached) break;
    if (attempt < probeAttempts) await sleep(probeDelayMs);
  }
  return { text, isError, attempts: attached ? attempt : probeAttempts, attached };
}

export async function probeExecuteLuau(
  launch: StudioLaunch,
  code: string,
  factory: McpClientFactory = defaultClientFactory,
  opts: DoctorOptions = {},
): Promise<LuauProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const probeAttempts = opts.probeAttempts ?? 8;
  const probeDelayMs = opts.probeDelayMs ?? 500;
  const sleep = opts.sleep ?? defaultSleep;
  let client: DoctorClient | undefined;
  try {
    client = await withTimeout(factory(launch), timeoutMs, 'connect');
    const listed = await withTimeout(client.listTools(), timeoutMs, 'listTools');
    const luau = listed.tools.map((t) => t.name).find((n) => n.endsWith('execute_luau'));
    if (!luau) return { text: 'no execute_luau tool advertised', isError: true, attempts: 0, attached: false };
    return await execLuauWithRetry(client, luau, code, timeoutMs, probeAttempts, probeDelayMs, sleep);
  } catch (err) {
    return { text: `connect failed: ${(err as Error)?.message ?? String(err)}`, isError: true, attempts: 0, attached: false };
  } finally {
    await client?.close().catch(() => {});
  }
}
```

- [ ] **Step 4: Make `runDoctor` reuse the helper**

In `runDoctor`, replace the inline probe loop (the `const t1 = Date.now();` block through the `detail` assignment) with:

```typescript
    const t1 = Date.now();
    const probe = await execLuauWithRetry(client, luau, 'return 1 + 1', timeoutMs, probeAttempts, probeDelayMs, sleep);
    const probeLatencyMs = Date.now() - t1;
    const studioAttached = probe.attached;
    const detail = studioAttached
      ? `Studio attached; execute_luau -> ${probe.text}`
      : `proxy up but no Studio attached after ${probe.attempts} probe(s): ${probe.text || '(isError)'}`;
```

(The surrounding `return { connected: true, …, studioAttached, probeLatencyMs, detail }` is unchanged.)

- [ ] **Step 5: Run the doctor tests to verify all pass**

Run: `npx vitest run tests/doctor.test.ts`
Expected: PASS (existing 7 + 3 new `probeExecuteLuau` tests = 10).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/doctor.ts tests/doctor.test.ts
git commit -m "refactor: share execLuauWithRetry; add probeExecuteLuau helper"
```

---

## Task 3: Add the sync channel to `blox doctor`

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Import the sync check** (`src/cli.ts`, with the other imports)

```typescript
import { checkRojoServe, rojoServeUrl, formatServeCheck } from './sync/serveCheck.js';
```

- [ ] **Step 2: Print the sync check in the doctor branch**

Replace the existing `doctor` branch body with:

```typescript
  if (command === 'doctor') {
    const report = await runDoctor(studioLauncher());
    console.log(formatDoctorReport(report));
    const serve = await checkRojoServe(rojoServeUrl());
    console.log(formatServeCheck(serve));
    process.exit(report.connected ? 0 : 1);
  }
```

- [ ] **Step 3: Run the unit suite + typecheck + build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all unit tests PASS; tsc clean; `dist/cli.js` produced.

- [ ] **Step 4: Offline smoke — sync line shows NO SERVE when serve is down**

Run: `BLOX_STUDIO_MCP_CMD=/bin/false BLOX_STUDIO_MCP_ARGS= BLOX_ROJO_SERVE_URL=http://localhost:1 node dist/cli.js doctor; echo "exit=$?"`
Expected: MCP `NOT CONNECTED`, a `sync: NO SERVE` line, `exit=1`.

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat: report rojo serve sync channel in blox doctor"
```

---

## Task 4: Gated live propagation test

**Files:**
- Create: `tests/e2e/live-sync.test.ts`

- [ ] **Step 1: Write the gated test**

```typescript
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { probeExecuteLuau } from '../../src/doctor.js';

// Requires: rojo serve running on the fixture + Rojo plugin connected + live Studio.
const enabled = process.env.BLOX_LIVE_SYNC === '1';
const greeter = resolve(__dirname, '../../test-fixtures/game/src/ReplicatedStorage/Greeter.luau');

describe.skipIf(!enabled)('live Rojo file sync', () => {
  it('propagates a WSL edit into Studio (execute_luau reads .Source)', async () => {
    const original = readFileSync(greeter, 'utf8');
    const marker = `SYNC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    try {
      writeFileSync(greeter, original.replace('return Greeter', `-- ${marker}\nreturn Greeter`));
      // Retry absorbs both the MCP attach race and the Rojo sync settle.
      let found = false;
      for (let i = 0; i < 6 && !found; i++) {
        const r = await probeExecuteLuau(
          studioLauncher(),
          'return game.ReplicatedStorage.Greeter.Source',
          undefined,
          { probeAttempts: 10, probeDelayMs: 500 },
        );
        found = r.attached && r.text.includes(marker);
        if (!found) await new Promise((res) => setTimeout(res, 1000));
      }
      expect(found).toBe(true);
    } finally {
      writeFileSync(greeter, original);
    }
  }, 60_000);
});
```

- [ ] **Step 2: Verify it self-skips without the gate**

Run: `npx vitest run tests/e2e/live-sync.test.ts`
Expected: 1 test SKIPPED.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/live-sync.test.ts
git commit -m "test: add gated live Rojo sync propagation e2e"
```

- [ ] **Step 4 (manual, requires serve + plugin + Studio): run it for real**

Run: `BLOX_LIVE_SYNC=1 npx vitest run tests/e2e/live-sync.test.ts`
Expected: 1 test PASS (the marker written from WSL is observed in Studio). If it reports not found, confirm `rojo serve` is running on the fixture and the plugin is Connected, then re-run.

---

## Task 5: Docs

**Files:**
- Modify: `docs/reference/roblox-studio-mcp.md`

- [ ] **Step 1: Document propagation + setup**

Under "Transport & connection", add a "File sync (Rojo)" note: file propagation into Studio is done by **`rojo serve` + the Rojo Studio plugin (Connect)**, NOT by `rojo sourcemap` (which only writes `sourcemap.json` metadata). Record the `GET /api/rojo` response shape (`{ sessionId, serverVersion, protocolVersion, projectName }`) used by `blox doctor`'s sync check, and the boundary fact: the Windows plugin reaches WSL `rojo serve` on `localhost:34872` via WSL2 localhost-forwarding (fallback host = the WSL IP). Add a short "Live sync setup": run `rojo serve <project>`; in Studio click the Rojo plugin → Connect to `localhost:34872`.

- [ ] **Step 2: Commit**

```bash
git add docs/reference/roblox-studio-mcp.md
git commit -m "docs: record Rojo serve propagation + live-sync setup"
```

---

## Task 6: Final verification

- [ ] **Step 1: Full suite green**

Run: `npx vitest run`
Expected: all unit tests + real-rojo integration PASS; the live e2e tests SKIPPED (gates off).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `dist/cli.js` produced.

- [ ] **Step 3: Offline doctor smoke (both channels down)**

Run: `BLOX_STUDIO_MCP_CMD=/bin/false BLOX_STUDIO_MCP_ARGS= BLOX_ROJO_SERVE_URL=http://localhost:1 node dist/cli.js doctor; echo "exit=$?"`
Expected: `NOT CONNECTED` + `NO SERVE`, `exit=1`.

- [ ] **Step 4 (with live Studio + serve + plugin): full doctor + live sync**

Run: `node dist/cli.js doctor` then `BLOX_LIVE_SYNC=1 npx vitest run tests/e2e/live-sync.test.ts`
Expected: doctor shows `studio: ATTACHED` and `sync: SERVE REACHABLE (… blox-fixture)`; live-sync test PASSES.

---

## Self-Review

- **Spec coverage:** §5.1 serveCheck → Task 1; §5.2 probeExecuteLuau extraction → Task 2; §5.3 cli combined report → Task 3; §5.4 live-sync test → Task 4; §5.5 docs → Task 5; testing/DoD §6 → Tasks 1–6. All covered.
- **Placeholder scan:** every code step shows full code; no TBD/TODO.
- **Type consistency:** `FetchFn`/`ServeCheckReport`/`rojoServeUrl`/`checkRojoServe`/`formatServeCheck` identical across `src/sync/serveCheck.ts` and `tests/serveCheck.test.ts`; `LuauProbeResult`/`probeExecuteLuau` identical across `src/doctor.ts` and `tests/doctor.test.ts` and consumed in `tests/e2e/live-sync.test.ts`; `studioLauncher` reused from SP1c-a. `runDoctor`'s public report shape is unchanged (only its internal probe is delegated to `execLuauWithRetry`).
