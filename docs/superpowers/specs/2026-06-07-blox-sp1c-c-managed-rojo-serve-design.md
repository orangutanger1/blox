# blox SP1c-c — blox-managed `rojo serve` lifecycle

**Date:** 2026-06-07
**Status:** Design approved → ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-06-06-blox-design.md` (§8 SP1 MVP)
**Predecessor:** SP1c-b (live Rojo file sync) — complete and merged to `main` (HEAD `19fab25`).
**Scope note:** Third SP1c slice. blox now *verifies* a `rojo serve` channel
(`checkRojoServe`, SP1c-b) but the developer must start `rojo serve` by hand. This
slice makes blox **own the serve process lifecycle**. Tier-2 play is a later slice.

## 1. Goal

blox owns the long-running `rojo serve` process so the file-sync channel exists
without the developer typing `rojo serve` for every session.

**Reuse-first model.** A reachable serve is reused and never torn down by blox. A
run that finds no serve spawns its own and tears it down on exit. blox never kills a
serve it did not start.

**Primary ergonomic path** (given the plugin needs a manual Connect each serve
session — see §3): the developer runs `blox serve` once, clicks **Connect** in
Studio's Rojo plugin once, then many `blox "<prompt>"` runs reuse that serve with no
further clicks.

## 2. The gap this closes

After SP1c-b:

- `rojo serve` + the Rojo Studio plugin is the real file→Studio push channel, but
  blox only **verifies** it (`checkRojoServe`, `blox doctor`). The developer starts
  `rojo serve <project>` manually in a separate terminal.
- Nothing manages the serve process: no readiness wait, no teardown, no reuse
  detection, no protection against orphaned `rojo` processes.

This slice adds the lifecycle layer on top of the verification layer SP1c-b shipped.

## 3. Grounding facts

- **Manual Connect is required each serve session.** The Rojo Studio plugin does not
  auto-reconnect; a human clicks **Connect** once per serve session. blox cannot
  observe the plugin connection — only serve **reachability** (`GET /api/rojo`).
  Consequence: tearing down serve every run would force a click every run, so the
  reuse-first model (click once, reuse many) is the ergonomic design.
- **Seam mismatch.** The existing `SpawnFn` (`src/sync/rojo.ts`) resolves a
  `Promise<SpawnResult>` *after* the child exits — correct for one-shot
  `rojo sourcemap`, wrong for a long-running daemon. A new seam is required.
- **Default port 34872.** Matches the existing `rojoServeUrl()` default in
  `src/sync/serveCheck.ts`; the two must stay consistent.
- **Readiness ≠ connected.** `checkRojoServe` proves the serve process is up and
  reachable; it does **not** prove the plugin connected or that files propagate.
  End-to-end proof remains the agent's `execute_luau` verify loop (SP1c-b).

## 4. Architecture

### 4.1 New module: `src/sync/serve.ts`

A long-running-process seam, distinct from the one-shot `SpawnFn`:

```ts
export interface ServeHandle {
  pid?: number;
  kill(): void;
  exited: Promise<number>;        // resolves with the exit code when the child dies
}
export type ServeSpawnFn = (projectPath: string, port: number) => ServeHandle;

// Spawns `rojo serve <project> --port <port>` as a long-running managed child
// (not detached — killable via the returned handle for clean teardown).
export const realServeSpawn: ServeSpawnFn;

export function rojoServePort(): number;   // env BLOX_ROJO_SERVE_PORT, default 34872
```

Orchestrator:

```ts
export type ServeMode = 'reused' | 'spawned';
export interface ServeSession {
  mode: ServeMode;
  url: string;
  port: number;
  handle: ServeHandle | null;     // null when reused
}

export interface EnsureServeOptions {
  spawn?: ServeSpawnFn;           // default realServeSpawn
  fetch?: FetchFn;                // default from serveCheck (injectable for tests)
  port?: number;                  // default rojoServePort()
  attempts?: number;              // readiness poll, default 10
  delayMs?: number;               // readiness poll, default 500
  sleep?: (ms: number) => Promise<void>;
}

export function ensureServe(projectPath: string, opts?: EnsureServeOptions): Promise<ServeSession>;
export function stopServe(session: ServeSession): Promise<void>;
```

Behavior:

1. `ensureServe` calls `checkRojoServe(url)`. **Reachable ⇒** `{ mode: 'reused',
   handle: null }` — no spawn, no ownership.
2. **Not reachable ⇒** spawn via `ServeSpawnFn`, then poll `checkRojoServe` until
   reachable (`attempts`×`delayMs`, same retry shape as the doctor probe) ⇒
   `{ mode: 'spawned', handle }`.
3. If the child exits before becoming reachable, or the poll exhausts, throw an error
   carrying the child's stderr/exit detail.
4. `stopServe` kills the child and awaits `exited` **only when `mode === 'spawned'`**;
   a no-op for `reused`.

### 4.2 Wiring (`src/args.ts`, `src/cli.ts`)

- **`args.ts`**: extend the `command` union to `'doctor' | 'serve' | null`; parse the
  `serve` positional the same way `doctor` is parsed.
- **`blox serve`** (new): `ensureServe`.
  - `spawned` ⇒ print readiness + a loud **Connect reminder**
    (`rojo serve up on :PORT — click Connect in Studio's Rojo plugin`), then stay
    foreground until SIGINT/SIGTERM ⇒ `stopServe` ⇒ exit 0.
  - `reused` ⇒ print "serve already running (reuse) — nothing to manage" ⇒ exit 0.
- **`blox "<prompt>"`**: `ensureServe` before `runAgent`.
  - `spawned` ⇒ register teardown (§4.3) + print Connect reminder.
  - `finally` ⇒ `stopServe(session)` (no-op when reused).
  - A reused serve is left running across the run.

### 4.3 Signal teardown

A small cleanup registry kills any blox-spawned serve child on `SIGINT`,
`SIGTERM`, and normal `process` exit, so an interrupted run never orphans a `rojo`
process. Only `spawned` sessions are registered; `reused` sessions are never killed.

## 5. Components & responsibilities

| Unit | Does | Depends on |
|------|------|------------|
| `realServeSpawn` | spawn long-running `rojo serve --port` child, expose kill/exited | `node:child_process` |
| `rojoServePort` | resolve port from env, default 34872 | `process.env` |
| `ensureServe` | reuse-or-spawn + readiness poll, return tagged session | `checkRojoServe`, `ServeSpawnFn` |
| `stopServe` | tear down only spawned sessions | `ServeHandle` |
| signal registry | kill spawned children on exit/signals | `process` |
| `blox serve` cmd | foreground-manage a spawned serve; report a reused one | `ensureServe`/`stopServe` |
| run wiring | ensure serve around `runAgent`, teardown spawned in `finally` | `ensureServe`/`stopServe` |

## 6. Testing

### 6.1 Unit (no live Studio, no real rojo)

Fake `ServeSpawnFn` + injectable `FetchFn` (`checkRojoServe` already takes one):

- **reuse path** — fetch reachable ⇒ `mode==='reused'`, spawn fn **not** called,
  `stopServe` is a no-op.
- **spawn path** — fetch unreachable then reachable after N polls ⇒ `mode==='spawned'`,
  handle returned, poll count bounded.
- **spawn-dies path** — child `exited` resolves before reachable ⇒ `ensureServe`
  throws with the detail.
- **poll-exhaust path** — never reachable within `attempts` ⇒ throws.
- **teardown** — `stopServe` on a spawned session calls `kill` and awaits `exited`;
  on a reused session does nothing.
- **port resolution** — `BLOX_ROJO_SERVE_PORT` honored, default 34872.

### 6.2 Gated live test (`BLOX_LIVE_SERVE=1`)

`tests/e2e/live-serve.test.ts`, self-skips when the env flag is unset:

- `ensureServe(fixture)` with no serve up ⇒ really spawns `rojo serve`, becomes
  reachable, `mode==='spawned'`.
- `stopServe` ⇒ child dies, port free afterward (a follow-up `checkRojoServe` fails).

## 7. Out of scope

- Detecting the plugin Connect state (blox observes reachability only).
- Removing or replacing the PreToolUse `rojo sourcemap` hook (`src/agent/hooks.ts`) —
  left unchanged.
- Propagation-race gating between an edit and a subsequent `execute_luau`.
- Tier-2 play (`start_stop_play`, `get_console_output`) — a later slice.

## 8. Success criteria

- `blox serve` starts a serve, prints the Connect reminder, and tears it down cleanly
  on Ctrl-C with no orphaned `rojo` process.
- `blox "<prompt>"` reuses a running serve (started by `blox serve` or the developer)
  without killing it, and spawns + tears down its own only when none is up.
- All new units covered by unit tests via the `ServeSpawnFn`/`FetchFn` seams; the full
  suite plus `tsc` and `npm run build` stay green.
- Gated live test proves a real spawn→reachable→teardown cycle.
