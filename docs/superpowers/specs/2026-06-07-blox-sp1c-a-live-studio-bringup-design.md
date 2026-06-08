# blox SP1c-a — Live Studio Bring-Up

**Date:** 2026-06-07
**Status:** Design approved → ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-06-06-blox-design.md` (§8 SP1 MVP)
**Predecessor:** SP1b (verify/fix loop) — complete and merged to `main` (HEAD `ad669af`).
**Scope note:** SP1c was decomposed. This is the **first slice (SP1c-a)**: prove the
live WSL→Windows Studio MCP hop and ground the real tool/result envelopes. Tier-2
play, input simulation, and session/multi-Studio tools are **later SP1c slices**
that build on the foundation proven here.

## 1. Goal

Prove the WSL→Windows `cmd.exe → mcp.bat → StudioMCP.exe` stdio hop end-to-end,
ship a cheap **`blox doctor`** preflight that diagnoses it, un-gate a real live
e2e, and record the **actual** tool names + `execute_luau` result envelope. This
replaces guessed shapes (the reference doc and SP1b spec disagree with the live
server) with observed facts before any tier-2 code is written on top.

## 2. Spike findings (observed against live Studio, 2026-06-07)

A throwaway probe (`scripts/spike-handshake.mjs`, deleted at end of SP1c-a)
connected via the existing SP1b bridge launcher config. Verified facts:

- **The hop works.** `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat` launches; MCP
  `initialize` completes in ~120–800ms; `tools/list` returns. `mcp.bat` exists at
  `C:\Users\matth\AppData\Local\Roblox\mcp.bat`; `cmd.exe` is reachable from WSL.
- **Server identity:** `{ "name": "RobloxStudio", "version": "0.1.0" }`.
- **Two-layer architecture.** The launched process is a **proxy** (`StudioMCP.exe`,
  a `ws_server`). The MCP client talks to the proxy; the proxy brokers to a
  **running Studio** that attaches over a websocket when MCP-server mode is enabled
  in Assistant settings. The handshake/`tools/list` succeed **even with no Studio
  attached** — so a successful handshake does NOT imply a usable Studio. When no
  Studio is attached, the server logs `No studio available for proxy <uuid>` and
  tool calls return an `isError` envelope (see below).
- **Real tool surface (26 tools)** — differs from the reference doc:
  `http_get, character_navigation, search_game_tree, script_search, skill,
  search_creator_store, subagent, multi_edit, get_studio_state, generate_mesh,
  screen_capture, get_console_output, script_grep, wait_job_finished,
  generate_procedural_model, execute_luau, user_keyboard_input, user_mouse_input,
  generate_material, script_read, start_stop_play, insert_from_creator_store,
  store_image, inspect_instance, list_roblox_studios, set_active_studio`.
  - **All 10 SP1b `allowedTools` exist** in this list → the SP1b bridge tool set is
    valid as-is.
  - **Name corrections for later SP1c slices** (doc/spec were wrong): console is
    `get_console_output` (not `console_output`); input is `user_keyboard_input` /
    `user_mouse_input` (not `keyboard_input` / `mouse_input`); there is a generic
    `subagent` (no `explore_subagent` / `playtest_subagent`). `character_navigation`,
    `screen_capture`, `start_stop_play` confirmed. Undocumented extras observed:
    `http_get`, `skill`, `get_studio_state`, `wait_job_finished`, `store_image`,
    `search_creator_store`.
- **`execute_luau` argument is `code`** (a string), NOT `command`. Wrong arg →
  `-32603 "Missing required argument: code"`.
- **Result envelope is standard MCP `CallToolResult`:**
  ```json
  { "content": [ { "type": "text", "text": "<output|error>" } ], "isError": <bool> }
  ```
  `isError: true` carries the failure message as text (e.g. the "no active Studio
  instance" message). The success-path text shape (for `return 1 + 1`) is captured
  during the live e2e once a Studio is attached.
- **Two non-fatal warnings to harden:**
  1. cmd.exe emits `UNC paths are not supported. Defaulting to Windows directory.`
     because it inherits the WSL cwd (`\\wsl.localhost\…`). Launch the child with a
     Windows-side cwd to suppress it and avoid edge cases.
  2. `mcp.bat` writes batch-parse noise to **stderr** (`'else' is not recognized…`)
     from a dead conditional branch; the working branch still launches
     `StudioMCP.exe`. Cosmetic — must not be treated as a failure signal.

## 3. Architecture

No new long-lived component. SP1c-a adds one CLI subcommand and a small,
testable diagnostic unit, plus surgical bridge hardening.

- **`blox doctor` subcommand.** Reuses the SP1b bridge **launcher config** (same
  `command`/`args`, same `BLOX_STUDIO_MCP_CMD` / `_ARGS` overrides) so it tests the
  exact path a real run uses. It performs a **layered** check and reports each
  layer distinctly:
  1. **Proxy layer:** spawn + MCP `initialize` + `tools/list`. Report connected
     y/n, server name/version, advertised tool count, connect latency.
  2. **Studio-attached layer:** call `execute_luau` with `{ code: 'return 1 + 1' }`.
     If `isError` is true (or the text matches the "no active Studio" message),
     report **proxy-up-but-no-Studio** with the remediation hint (open a place +
     enable MCP server in Assistant settings). If `isError` is false, report
     **Studio attached** and echo the returned text + round-trip latency.
  - No agent, no Anthropic API call → free to run repeatedly during setup.
- **`doctor` core logic is a pure unit** (`src/doctor.ts`): it takes an injected
  **MCP-client factory** (default = real `@modelcontextprotocol/sdk` `Client` +
  `StdioClientTransport`) and returns a structured `DoctorReport`. The CLI formats
  the report; tests assert the report against a **fake in-memory client** (no live
  Studio, no child process). Same injection discipline as the SP1b `SpawnFn` seam.
- **Bridge hardening** (`src/bridge/mcpBridge.ts`): set a Windows-side `cwd` on the
  stdio launch to suppress the UNC warning. Keep the `Roblox_Studio` server key and
  tool set unchanged (SP1c-a does not add tier-2 tools).
- **Dependency:** promote `@modelcontextprotocol/sdk` from transitive to a direct
  dependency (already resolved at `1.29.0`).

### Data flow (`blox doctor`)

```
blox doctor
  → bridge.launcher() → { command, args }   (same as a real run)
  → MCP Client.connect(StdioClientTransport) over the cmd.exe→mcp.bat hop
  → initialize + tools/list           (proxy layer)
  → execute_luau { code: 'return 1+1' }  (Studio-attached layer)
  → DoctorReport { connected, serverName, toolCount, tools, latencyMs,
                   studioAttached, detail }
  → formatted to stdout; exit 0 if proxy up, nonzero if not connectable
```

## 4. Components (changes)

### 4.1 `src/doctor.ts` (new)
- `type DoctorReport = { connected: boolean; serverName?: string;
  serverVersion?: string; toolCount?: number; tools?: string[];
  connectLatencyMs?: number; studioAttached?: boolean; probeLatencyMs?: number;
  detail: string }`.
- `type McpClientFactory = (launch: { command: string; args: string[] }) =>
  Promise<DoctorClient>` where `DoctorClient` exposes the minimal surface used
  (`serverInfo()`, `listTools()`, `callTool()`, `close()`). Default factory wraps
  the real SDK `Client` + `StdioClientTransport`.
- `async function runDoctor(launch, factory?): Promise<DoctorReport>` — performs
  the layered check with a bounded timeout; never throws (failures become a report
  with `connected: false`).
- `function formatDoctorReport(r: DoctorReport): string` — pure formatter.

### 4.2 `src/cli.ts`
- Dispatch a `doctor` subcommand **before** the prompt-required path: if
  `argv[0] === 'doctor'`, build the real bridge launcher, run `runDoctor`, print
  `formatDoctorReport`, exit 0 when `connected` else 1. The normal run path is
  unchanged.

### 4.3 `src/args.ts`
- Recognize the `doctor` subcommand (and pass through `--project` / env overrides
  used to locate the launcher). Minimal: enough for `cli.ts` to branch.

### 4.4 `src/bridge/mcpBridge.ts`
- Add a Windows-side `cwd` to the stdio server config (e.g. the `%LOCALAPPDATA%`
  parent, or a fixed Windows path) to suppress the UNC-cwd warning. No tool-set
  change.

### 4.5 `tests/e2e/live-studio.test.ts` (new, gated)
- Gated by `BLOX_LIVE_STUDIO=1`. Uses the **real** bridge launcher (not `--mock`).
- Asserts: `runDoctor` reports `connected: true`, the real tool list contains the
  10 SP1b tools, and — with a Studio attached — `execute_luau { code:'return 1+1' }`
  returns `isError: false` with output text containing `2`. Records the success
  envelope in the test as the canonical reference.

### 4.6 `docs/reference/roblox-studio-mcp.md`
- Correct the tool table to the observed 26-tool surface and names; note the
  two-layer proxy architecture, the `execute_luau` `code` arg, and the standard
  `CallToolResult` envelope. Mark the prior doc names that were wrong.

### 4.7 cleanup
- Delete `scripts/spike-handshake.mjs` once `doctor` + the live e2e supersede it.

## 5. Testing & definition of done

- **Unit (fake MCP client, no live Studio):**
  - `runDoctor` → `connected:false` + detail when connect throws/times out.
  - `runDoctor` → proxy-up + `studioAttached:false` when `execute_luau` returns
    `isError:true` ("no active Studio" path).
  - `runDoctor` → proxy-up + `studioAttached:true` when the probe returns
    `isError:false`.
  - `formatDoctorReport` renders each state distinctly.
  - `cli` routes `doctor` to `runDoctor` and maps connected→exit 0 / not→exit 1.
- **Existing suite stays green:** the SP1b 35 unit tests + real-rojo integration;
  `tsc` clean; `npm run build` → `dist/cli.js`.
- **Manual / gated (requires live Studio with a place open + MCP enabled):**
  - `blox doctor` prints **Studio attached** with the tool list + latencies.
  - `tests/e2e/live-studio.test.ts` un-skipped and passing; success envelope
    recorded.
- **§10 carry-overs answered:** real `execute_luau` envelope = standard
  `CallToolResult`; WSL→Windows connect latency ≈ sub-second.

## 6. Out of scope (later SP1c slices / later)

- **Tier-2 play:** `start_stop_play`, `get_console_output`, `screen_capture`,
  `subagent`, `wait_job_finished` — the play-session loop is the next SP1c slice,
  now grounded by the real names here.
- **Input simulation:** `character_navigation`, `user_keyboard_input`,
  `user_mouse_input`.
- **Session/multi-Studio:** `list_roblox_studios`, `set_active_studio`.
- Exposing the undocumented tools (`http_get`, `skill`, `get_studio_state`,
  `store_image`, `search_creator_store`) — out until a slice needs them.
- Visual verify (SP2); heavy asset pipeline (SP3).

## 7. Risks & mitigations

- **Setup-state confusion** (proxy up but no Studio) wasted the first probe.
  Mitigation: `doctor`'s layered report names exactly which layer is down and how
  to fix it — that is the feature, not an aside.
- **Live Studio unavailable at build time.** Mitigation: all `doctor` logic is
  unit-tested against a fake client; only the final live pass needs Studio. SP1c-a
  still ships `doctor` + gated e2e + recorded findings if Studio can't attach this
  session.
- **mcp.bat stderr noise / cmd.exe UNC warning** misread as failure. Mitigation:
  `doctor` keys off the MCP handshake + `isError`, never stderr; bridge sets a
  Windows cwd.
- **Tool surface drift** (Roblox ships fast). Mitigation: `doctor` prints the live
  list every run, so drift is visible immediately; the reference doc is dated.
