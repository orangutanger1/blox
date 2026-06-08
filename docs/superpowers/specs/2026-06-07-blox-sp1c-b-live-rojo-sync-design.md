# blox SP1c-b — Live Rojo File Sync

**Date:** 2026-06-07
**Status:** Design approved → ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-06-06-blox-design.md` (§8 SP1 MVP)
**Predecessor:** SP1c-a (live Studio bring-up) — complete and merged to `main` (HEAD `206b9ae`).
**Scope note:** Second SP1c slice. Proves the agent's on-disk `.luau` edits actually
reach the running Studio (the verify-loop's silent prerequisite). blox-managed
`rojo serve` lifecycle and tier-2 play are **later slices** (SP1c-c+).

## 1. Goal

Make edited `.luau` files run in the live Studio via `rojo serve` + the Rojo Studio
plugin, and **prove it with a live test**: an on-disk edit propagates into Studio
and `execute_luau` observes it. Add a `blox doctor` **sync-channel check** so the
file-sync path is diagnosable the same way the MCP hop is. This closes the gap that
SP1c-a's `return 1 + 1` live test could not expose.

## 2. The gap this closes

`syncProject()` runs **`rojo sourcemap`**, which writes `sourcemap.json` (metadata)
and exits. It does **not** push files into Studio. So before this slice:

- The PreToolUse "sync gate" refreshes a sourcemap but does **not** propagate edits.
- `execute_luau` (tier-1) and any future playtest (tier-2) run against whatever
  scripts Studio already has — **not** the agent's edits.
- The system prompt's claim "Rojo one-way syncs them into Roblox Studio" was
  aspirational, never wired. This slice makes it true.

## 3. Spike findings (observed live, 2026-06-07)

Verified against the running Studio (Rojo plugin installed + connected):

- **`rojo serve` works in WSL.** `rojo serve test-fixtures/game/default.project.json
  --port 34872` binds `localhost:34872`; `GET /api/rojo` returns
  `{ sessionId, serverVersion: "7.6.1", protocolVersion: 4, projectName:
  "blox-fixture", … }`.
- **The boundary is crossable.** The Windows Studio Rojo plugin connected to
  `localhost:34872` (WSL2 localhost-forwarding); WSL IP `172.30.12.182:34872` is the
  fallback host if localhost ever fails.
- **Propagation is real.** Editing `src/ReplicatedStorage/Greeter.luau` from WSL
  (adding a `SYNC-7Q2X9` marker) made the marker appear in Studio: reading
  `game.ReplicatedStorage.Greeter.Source` via MCP `execute_luau` returned the edited
  source including the marker. Chain: **WSL edit → rojo serve → Studio plugin →
  DataModel → MCP execute_luau.**
- **`.Source` is readable** from the Studio MCP `execute_luau` context — the clean
  propagation check (no `require` cache to confound).
- **Same MCP attach race as SP1c-a.** A single instant `execute_luau` returned
  "Unable to find an active Studio instance"; it succeeded on the 3rd attempt with
  500ms backoff. The live test must retry (reuse the doctor's retry). Rojo sync
  itself was near-instant — the retries absorbed the proxy→Studio attach, not sync
  lag.

## 4. Architecture (Minimal: prove + verify the channel)

blox does **not** manage the `rojo serve` lifecycle in this slice. The developer
runs `rojo serve` and connects the plugin once per Studio session; blox **verifies**
the channel and **proves propagation** in a gated test. (Auto-managing serve is
SP1c-c.) This mirrors SP1c-a: prove the boundary cheaply before automating it.

- **`blox doctor` becomes a two-channel preflight.** It already checks the MCP hop
  (proxy + Studio-attached). It now also checks the **sync channel**: `GET
  <serveUrl>/api/rojo` and report reachable + `projectName` + `protocolVersion`.
  The two checks are independent units; the CLI runs both and prints one report.
- **Propagation proof lives in a gated live test**, not in doctor — confirming a
  plugin is actually *connected* (not just that serve is up) requires an end-to-end
  edit→observe cycle, which needs Studio. `/api/rojo` only proves serve is
  reachable.
- **Reuse, don't duplicate:** extract a `probeExecuteLuau(launch, code, opts?)` from
  `src/doctor.ts` (connect → run one `execute_luau` with the existing attach-retry →
  return text/isError → close). `runDoctor` uses it for `return 1 + 1`; the live
  sync test uses it to read `<script>.Source`.

### Data flow (`blox doctor`, post-SP1c-b)

```
blox doctor
  ├─ MCP channel:  runDoctor(studioLauncher())      → proxy + Studio-attached
  └─ sync channel: checkRojoServe(rojoServeUrl())    → GET /api/rojo
  → combined report; exit 0 iff MCP proxy connected (sync = advisory line)
```

## 5. Components (changes)

### 5.1 `src/sync/serveCheck.ts` (new)
- `type ServeCheckReport = { reachable: boolean; url: string; projectName?: string;
  protocolVersion?: number; serverVersion?: string; detail: string }`.
- `type FetchFn = (url: string) => Promise<{ ok: boolean; status: number;
  json(): Promise<unknown> }>` (matches the global `fetch` subset used).
- `async function checkRojoServe(url: string, fetchFn?: FetchFn,
  timeoutMs?: number): Promise<ServeCheckReport>` — GET `${url}/api/rojo`; on a 2xx
  with parseable JSON, fill `projectName`/`protocolVersion`/`serverVersion`; on any
  error/timeout, `reachable: false` with detail. Never throws.
- `function rojoServeUrl(): string` — default `http://localhost:34872`, override
  `BLOX_ROJO_SERVE_URL`.
- `function formatServeCheck(r: ServeCheckReport): string` — pure formatter.

### 5.2 `src/doctor.ts`
- Extract `export async function probeExecuteLuau(launch: StudioLaunch, code: string,
  factory?: McpClientFactory, opts?: DoctorOptions): Promise<{ text: string;
  isError: boolean; attempts: number; attached: boolean }>` containing the
  connect + attach-retry + single `execute_luau` logic. `runDoctor` calls it with
  `return 1 + 1`. No behavior change to `runDoctor`'s report.

### 5.3 `src/cli.ts`
- The `doctor` subcommand also calls `checkRojoServe(rojoServeUrl())` and prints
  `formatServeCheck` beneath the MCP report. Exit code still keyed to MCP proxy
  connectivity (sync is an advisory line — a missing serve is a warning, not a hard
  failure of the command).

### 5.4 `tests/e2e/live-sync.test.ts` (new, gated)
- Gated by `BLOX_LIVE_SYNC=1` (requires `rojo serve` running + plugin connected +
  live Studio). Steps: append a unique marker (e.g. `SYNC-<random>`) to
  `test-fixtures/game/src/ReplicatedStorage/Greeter.luau`; poll
  `probeExecuteLuau(studioLauncher(), 'return game.ReplicatedStorage.Greeter.Source')`
  until the marker appears (bounded retries for attach + sync); assert present;
  **always restore the file** in a `finally`.

### 5.5 docs
- `docs/reference/roblox-studio-mcp.md`: note that file propagation is `rojo serve`
  + plugin, **not** `rojo sourcemap` (sourcemap is metadata only); record the
  `/api/rojo` shape and the localhost-forwarding boundary fact.
- Add a short "Live sync setup" note (run `rojo serve <project>`; Studio Rojo plugin
  → Connect to `localhost:34872`, fallback WSL IP).

## 6. Testing & definition of done

- **Unit (injected seams, no live anything):**
  - `checkRojoServe`: reachable (2xx+JSON → fields), unreachable (fetch throws →
    `reachable:false`), non-2xx, and bad-JSON paths — via an injected `FetchFn`.
  - `rojoServeUrl`: default + `BLOX_ROJO_SERVE_URL` override.
  - `formatServeCheck`: reachable vs not rendered distinctly.
  - `probeExecuteLuau`: attaches first try; retries past "no active studio"; returns
    text — via the fake `McpClientFactory` (reuse the doctor test fake).
  - `runDoctor` unchanged: existing doctor tests still pass after the extraction.
- **Existing suite stays green:** all current unit tests + real-rojo integration;
  `tsc` clean; `npm run build` → `dist/cli.js`.
- **Gated live (requires serve + plugin + Studio):**
  - `blox doctor` prints the sync channel as reachable with `projectName`.
  - `tests/e2e/live-sync.test.ts` passes: WSL edit observed in Studio via
    `execute_luau` reading `.Source`.

## 7. Out of scope (later slices)

- **blox-managed `rojo serve` lifecycle** (start/stop per run, fixed port, teardown
  on signals) — SP1c-c.
- **Tier-2 play** (`start_stop_play` + `get_console_output`, agent-driven
  pass-through; `wait_job_finished` is asset-gen, not playtest) — after sync
  lifecycle.
- Input simulation; session/multi-Studio; visual verify (SP2); auto-connecting the
  Studio plugin (no Rojo API for it — stays a manual once-per-session Connect).

## 8. Risks & mitigations

- **WSL→Windows serve reachability** was the top risk — **retired by the spike**
  (localhost-forwarding works; WSL-IP fallback documented).
- **Plugin not connected but serve up** → doctor reports serve reachable yet edits
  don't propagate. Mitigation: doctor's sync line is explicitly "serve reachable",
  not "connected"; the gated live test is the connected-end-to-end proof.
- **MCP attach race** in the live test → reuse the doctor's bounded retry
  (`probeExecuteLuau`).
- **Live test must not dirty the fixture** → marker write/restore wrapped in
  `finally`; marker is unique per run.
