# blox Desktop Companion App v1 (DA + DB) — Design

**Date:** 2026-06-14
**Status:** Spec

## 1. Context

blox today is a Node CLI on `@anthropic-ai/claude-agent-sdk` with a Studio dock
plugin (P1/P2/P3). It serves Rojo+git developers comfortable in a terminal. The
prosumer→consumer expansion (see [[blox-pivot]]) needs a surface for
non-technical Roblox builders who will not run `npm i` or touch a shell.

This spec covers **blox Desktop v1**, scoped to two of the four "blox Desktop"
sub-projects:

- **DA — App shell + engine host.** A desktop window that bundles and supervises
  the existing Node engine and surfaces a run console — a build with no terminal.
- **DB — Onboarding wizard.** First-run flow that takes a fresh user from
  "downloaded the app" to "Studio connected, key set, first build running."

The two combine into one coherent goal: **download → first AI-built Roblox
change, no terminal.** The other sub-projects — **DC** project-management depth
and **DD** signing/auto-update/cross-platform packaging — are out of scope here.

The key architectural enabler already exists: the panel server is a localhost
HTTP API (`127.0.0.1:35768`) that the Studio plugin already consumes. The
desktop renderer becomes a second client of that same protocol, so the engine is
reused as a black box rather than rewritten.

## 2. Decisions (locked)

| Question | Decision |
|---|---|
| v1 scope | **DA + DB together** — a foundation-only shell would not actually serve a non-technical user, who cannot self-install rojo/key/plugin. |
| Platform | **Windows first.** Largest Roblox-dev base; matches the maintainer's machine; one signing regime; native MCP path (no WSL `cmd.exe` hop). Mac deferred to DD. |
| Framework | **Electron.** Bundles Node, so the existing Node engine runs as a child with no second runtime; all-JS matches the codebase; mature Windows packaging. Chromium's ~150 MB is moot beside the 235 MB SDK runtime already shipping. |
| Engine integration | **Fork the existing CLI as a child** (`utilityProcess.fork dist/cli.js`) for isolation + cancellation; the renderer drives it through the existing panel HTTP protocol. Not in-process (a runaway run must not take down the UI; the SDK spawns its own subprocess regardless). |
| Auth (v1) | **Key paste guaranteed** (stored in the OS credential vault via Electron `safeStorage`), passed to the engine child as `ANTHROPIC_API_KEY`. "Sign in with Claude" subscription OAuth is a **flagged feasibility spike** — v1 ships on key-paste regardless of its outcome. A blox-hosted trial key is **out** (drags in the relay backend; belongs to P5). |
| Packaging | **Lite only.** An unsigned `electron-builder` Windows installer sufficient to hand a tester. Code signing + auto-update are DD. |
| rojo / plugin / doctor / init | **Reuse existing CLI capabilities** by forking the CLI; do not reimplement. |

## 3. Architecture

Three processes plus the unchanged Studio plugin as a peer client.

```
┌─ Electron MAIN ─────────────┐     ┌─ Engine CHILD (utilityProcess.fork dist/cli.js) ─┐
│ app lifecycle, window       │────▶│ existing blox run flow → starts PanelServer       │
│ supervises engine child     │     │ (127.0.0.1:35768 HTTP: events/gates/image)        │
│ auth/key vault, rojo, plugin│     └───────────────────┬───────────────────────────────┘
│ install, doctor             │                         │ same HTTP panel protocol
└──────────┬──────────────────┘            ┌────────────┴───────────┐
           │ IPC                            │                        │
┌─ RENDERER (web UI) ─────────┐   polls ───▶│                  ◀──── Studio dock PLUGIN
│ onboarding wizard + run     │─────────────┘   (unchanged, peer client)
│ console (a panel HTTP client)│
└──────────────────────────────┘
```

**Why the renderer reuses the panel protocol.** The engine already emits run
status, log, diffs, and gate requests to the panel server, and accepts
gate/result/image decisions back. The renderer polling `/api/v1/events` and
posting to `/api/v1/gate/:id` and `/api/v1/image` is the same client the Luau
plugin is — the P1/P2/P3 event and gate rendering port from Luau to HTML/JS with
no protocol change. The Studio plugin and the desktop window are peers; a gate
can be answered in either (both stamp `lastPollAt`, so `isConnected()` stays true
whenever either polls; gating already tolerates this).

**Why fork rather than embed.** `utilityProcess.fork` runs the engine in a Node
child using Electron's bundled Node — no second Node runtime to ship. Forking
`dist/cli.js` with args reuses `cli.ts` verbatim as the entry: a run, `panel
install`, `doctor`, and `init` are all just different argv. Cancellation is a
child kill. A crash is contained.

## 4. Components

### 4.1 Electron main (`app/main/`)
- `engine.ts` — fork/supervise/cancel the engine child. Builds the child env:
  injects `ANTHROPIC_API_KEY` from the vault and prepends the bundled rojo
  directory to `PATH` (or sets `BLOX_ROJO_BIN`, see §6). Exposes
  `runBuild(prompt, projectPath, opts)`, `cancel()`, and surfaces stdout (the
  final report) + exit code to IPC.
- `auth.ts` — `saveKey`/`loadKey`/`clearKey` via Electron `safeStorage`
  (OS-backed encryption). Never writes the key to plaintext disk or logs.
- `setup.ts` — onboarding actions, each by forking the CLI: `detectRojo()`
  (PATH probe), `installRojo()` (download the pinned release into app data),
  `installPlugin()` (`blox panel install`), `checkStudio()` (`blox doctor`,
  interpreting exit code 0 = connected). Each returns a typed step result.
- `ipc.ts` — typed IPC surface between main and renderer (run control,
  onboarding actions, auth, state).

### 4.2 Renderer (`app/renderer/`)
- Onboarding wizard: `Welcome → Auth → Rojo → Plugin → Studio check → Done`
  screens, driven by `setup.ts` over IPC.
- Run console: project picker, prompt input, autonomy controls (mode/budget/
  effort), and the promoted panel view — a panel HTTP client that streams
  status/log/diffs and renders + answers gate, result-gate, and image-request
  cards (the P1/P2/P3 UI, in HTML/JS).
- `panelClient.ts` — the HTTP client (`GET /info`, long-poll `GET /events`,
  `POST /gate/:id`, `POST /image`), mirroring the plugin's poll loop and cursor
  reset on a new `runId`.

### 4.3 Bundled assets
The engine (`dist/` + `node_modules`, including the 235 MB SDK runtime), the
pinned `rojo.exe`, and the Studio dock plugin files, all packed into the Electron
app resources.

## 5. Flows

### 5.1 Onboarding (DB) — first-run step machine
A persisted state machine; once `Done`, subsequent launches skip to the run
console.

1. **Welcome** — what blox is; "Get started."
2. **Auth** — paste API key (deep-link to console.anthropic.com with guidance)
   → vault. *Spike:* offer "Sign in with Claude" if the OAuth path proves out.
3. **Rojo** — `detectRojo()`; if missing, `installRojo()` downloads the pinned
   binary into app data. Green when a usable rojo is available to the engine.
4. **Plugin** — `installPlugin()` copies the dock plugin into Studio; instruct
   the user to enable it and the Rojo plugin in Studio.
5. **Studio check** — `checkStudio()` runs `doctor`; green on connected, else a
   red card with the specific failed channel (MCP vs serve) and a fix hint +
   retry.
6. **Done** — persist completion; advance to the run console.

### 5.2 Run (DA)
The user picks an existing project or creates one (drives `blox init`), types a
prompt, sets autonomy controls, and clicks Run. Main forks the engine with those
args + the vault key in env. The renderer reads `runId`/`project` from
`/api/v1/info`, then streams events, renders and answers gates, and shows the
final report when `run_finished` arrives (or the child exits). Cancel kills the
child.

## 6. Engine touch-points (kept minimal)

- **Mandatory engine changes: none.** Run, `panel install`, `doctor`, and `init`
  are reached by forking `dist/cli.js` with argv. The key reaches the engine via
  the child's `ANTHROPIC_API_KEY` env.
- **rojo path:** the engine invokes `rojo` by bare name in `src/sync/rojo.ts`
  and `src/sync/serve.ts`. The app makes the bundled rojo reachable by prepending
  its directory to the engine child's `PATH` — **no engine change**.
- **Optional hardening (recommended):** add a `BLOX_ROJO_BIN` absolute-path
  override honored by `rojo.ts`/`serve.ts`, so the app need not munge `PATH`.
  Small, isolated, and the only proposed engine edit. Decide during planning.

## 7. Error handling

- **No key set** → engine run fails fast; the renderer routes the user back to
  the Auth step rather than showing a raw SDK error.
- **rojo missing/unreachable** → onboarding blocks at the Rojo step; a run warns
  and degrades exactly as the CLI does today (sync may be stale), surfaced in the
  console.
- **Studio not connected** → `doctor` red card names the failed channel; runs are
  still permitted (mock/headless) but flagged.
- **Engine child crash** → main reports the exit code + captured stderr to the
  renderer; the app stays alive; the user can retry.
- **Port 35768 already bound** (a second app/CLI run) → the engine already
  warns-and-continues; the renderer shows "another run owns the panel port."

## 8. Testing

- **Main unit tests:** engine supervisor with a mocked fork (correct argv, env
  carries the key + rojo path, cancel kills the child, exit code surfaced); auth
  vault round-trip; each `setup.ts` action drives the expected CLI argv and maps
  exit codes to step results.
- **Renderer panel-client tests:** `panelClient.ts` against the existing
  `PanelServer` in tests (reuse `tests/panel.server.test.ts` harness) — streams
  events, posts a gate decision, resets cursor on a new `runId`.
- **Manual live smoke (real Windows + Studio):** full onboarding (key → rojo →
  plugin → doctor green) then a first build end-to-end; the §10(a) and §10(c)
  spikes are exercised here first.

## 9. Out of scope (YAGNI / deferred)

- DC: deep project management, multi-project dashboards, full config editing.
- DD: code signing, notarization, auto-update, Mac/Linux builds.
- blox-hosted trial key + relay/metering (P5).
- Multi-provider models (conflicts with the Agent SDK; separate strategic track).
- Running the engine in-process.
- Re-skinning the Studio plugin (it stays as-is, a peer client).

## 10. Risks & feasibility spikes

Resolve these early in implementation — they gate the rest.

- **(a) Native-Windows engine run.** The engine has only been live-tested
  WSL→Windows, never as a native-Windows process. The native MCP launcher path
  (`%LOCALAPPDATA%\Roblox\mcp.bat` directly, no `cmd.exe` hop) needs a real run
  before the shell is built on top of it.
- **(b) "Sign in with Claude" OAuth** through the bundled SDK is unverified;
  treat as a spike, not a commitment. Key-paste carries v1.
- **(c) Packaged fork of the 235 MB SDK.** `utilityProcess.fork` running the
  engine — which itself spawns the SDK subprocess — from inside a packaged
  Electron app is the highest-risk integration. Spike a minimal
  "Electron forks the CLI and a real run completes" end-to-end before building
  UI on it.
