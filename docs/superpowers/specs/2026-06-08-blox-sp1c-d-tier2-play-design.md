# blox SP1c-d — tier-2 play (`start_stop_play` + `get_console_output`)

**Date:** 2026-06-08
**Status:** Design approved → ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-06-06-blox-design.md` (§8 SP1 MVP, tool tiers)
**Predecessor:** SP1c-c (blox-managed `rojo serve` lifecycle) — complete and merged to `main` (HEAD `45c0a01`).
**Scope note:** Fourth SP1c slice. The SP1c-a/b/c slices made the live Studio loop
real (MCP bring-up, file→Studio propagation, managed `rojo serve`). With files now
syncing continuously into a running Studio, this slice exposes **tier-2 play** so
the agent can verify *runtime* behavior, not just module logic. Input simulation,
`screen_capture`, and session/multi-Studio are later slices.

## 1. Goal

Let the agent play-test its changes. Expose two Studio MCP tools to the agent and
guide their use:

- `start_stop_play` — start or stop a Studio play session (`is_start: boolean`).
- `get_console_output` — read the Studio output/console log (no args).

This upgrades the verify loop from **module-logic only** (edit-mode `execute_luau`,
shipped in SP1b) to **runtime/gameplay verification** (start play → exercise →
read console → stop) when the task's behavior only manifests while the game runs.

## 2. The gap this closes

SP1b/SP1c gave the agent edit-mode `execute_luau`: it can load a module and assert
return values, but it cannot observe behavior that only happens when the game is
*running* — `RunService` lifecycle, event wiring, player/character spawning,
client/server runtime state, anything driven by the game loop. Without play, the
agent's verification is blind to a whole class of bugs. This slice gives it the
start/stop and console-read primitives to close that gap.

## 3. Grounding facts (live-probed 2026-06-08)

Probed directly against Windows Studio v0.1.0 over the WSL `cmd.exe → mcp.bat` hop,
using the SP1c-a MCP client. All three behaviors confirmed:

- **`start_stop_play` works.** `{is_start: true}` → `"Game Started"` (~4s);
  `{is_start: false}` → `"Game Stopped"` (~5s). Start/stop are multi-second.
- **`execute_luau` runs DURING play.** Immediately after start it returned
  `IsRunning=true IsServer=false IsClient=true IsEdit=false` → it executes in the
  **client context** of the running game. After stop, `IsRunning=false`.
- **`get_console_output` works during play.** Returned both the game's own prints
  (`Hello, world!`) and an injected `print("BLOX_PROBE_PLAY_MARKER ...")`.

Consequences baked into this design:

- The play-verify loop is **active** (inject test code + read console at runtime),
  not console-read-only.
- **In-play `execute_luau` is client-context only.** Server-only state (server
  `Script`s, `ServerStorage`) is not directly readable from it; verifying server
  behavior needs indirection (a `RemoteEvent`, an attribute, or other
  client-visible state). The system prompt must say so.
- Start/stop latency is multi-second; any test or guidance that waits must allow
  ~5s.
- Edit-mode `execute_luau` can transiently return "previously active Studio
  disconnected" on a Studio rebind; existing retry (doctor) covers it. No new
  handling needed here.

## 4. Architecture

**Agent-driven pass-through.** No new blox module, no new orchestration. blox
exposes the two tools, fakes them in the mock bridge, and steers their use via the
system prompt — the same shape used for `execute_luau` and the asset tools in SP1b.

### 4.1 Real bridge (`src/bridge/mcpBridge.ts`)

Add `start_stop_play` and `get_console_output` to the `TOOLS` array (10 → 12).
`allowedTools()` already maps every entry to `mcp__Roblox_Studio__<tool>`, so both
become allowed automatically. No other change — both tools are already advertised
by the live proxy's static catalog (26 tools).

### 4.2 Mock bridge (`src/bridge/mockBridge.ts`)

Add two in-process fakes and one option, mirroring the existing `luauResults`
pattern:

- `start_stop_play({ is_start: boolean })` → returns `"[mock] Game Started"` when
  `is_start` is true, else `"[mock] Game Stopped"`. No state machine (YAGNI).
- `get_console_output({})` → returns the next entry from a new
  `consoleResults?: string[]` option via `sequenceResponder` (last repeats), so a
  gated/dev run can script a console-driven fix loop. Default a single canned line.
- Add both tool names to the mock's `allowedTools()` list so it stays at full
  parity with the real surface (the parity test guards this).

### 4.3 System prompt (`src/agent/systemPrompt.ts`)

Add a **conditional** play-verify section to the existing verify-loop guidance:

- Default: verify module/unit logic with edit-mode `execute_luau` (fast, cheap) —
  unchanged.
- Use `start_stop_play` only when the change's behavior is **runtime/gameplay** and
  doesn't show up in edit mode (events, lifecycle, player interaction, the game
  loop).
- While play is running, `execute_luau` runs in **client context**; to check
  server-side behavior, surface it to the client (RemoteEvent/attribute) first.
- Read runtime output with `get_console_output`.
- **Always stop play (`start_stop_play {is_start:false}`) when verification is
  done** — blox does not stop it for you.

## 5. Components & responsibilities

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `mcpBridge.TOOLS` | Declare the two new tool names so they're allowed | — |
| `mockBridge` fakes | Deterministic offline `start_stop_play` / `get_console_output` | `sequenceResponder` |
| `mockBridge.consoleResults` | Script successive console outputs for a fix loop | — |
| `systemPrompt` play section | Tell the agent when/how to play-verify and to always stop | — |

## 6. Testing

### 6.1 Unit (no live Studio)

- **mock `start_stop_play`**: `{is_start:true}` → text contains "Started";
  `{is_start:false}` → text contains "Stopped".
- **mock `get_console_output`**: with `consoleResults: ['a','b']`, successive calls
  return `a`, `b`, `b` (sequence + last-repeats).
- **allowedTools parity**: mock `allowedTools()` set equals real `allowedTools()`
  set (extend the existing parity test to include the two new tools).
- **real `TOOLS`**: asserts `start_stop_play` and `get_console_output` are present
  in `mcpBridge` `allowedTools()`.

### 6.2 Gated live test (`BLOX_LIVE_PLAY=1`)

`tests/e2e/live-play.test.ts`. Self-skips unless `BLOX_LIVE_PLAY=1`. Requires a
real Studio attached (place open, MCP enabled). Reuses the SP1c-a MCP client
helper. Flow:

1. Connect; assert `start_stop_play`, `get_console_output`, `execute_luau` are
   advertised.
2. `start_stop_play {is_start:true}`; allow ~5s for spin-up.
3. `execute_luau` returning `RunService:IsRunning()` → assert `true` (with a short
   attach retry).
4. Inject `print("<unique-marker>")` via `execute_luau`.
5. `get_console_output` → assert it contains the marker.
6. `start_stop_play {is_start:false}` in a `finally` (always stop, even on assert
   failure); afterward assert `IsRunning()` is `false`.

### 6.3 Full suite

`npm test` green, `tsc` clean, `npm run build` clean. Gated live test skipped in CI.

## 7. Out of scope

- **blox-owned play-stop gate.** A blox Stop-hook that force-stops play would have
  to call an MCP tool from inside the hook, reintroducing the "second Studio MCP
  client" problem SP1b deliberately avoided (SP1b hooks only call rojo, never MCP).
  The agent owns start/stop via the system prompt.
- **Per-tool sync gate before play.** Managed `rojo serve` (SP1c-c) propagates
  files continuously; the edit-mode `execute_luau` sourcemap PreToolUse hook is
  unchanged and untouched.
- **Server-context execute_luau workaround.** Documented as a caveat; no tooling
  to bridge it in this slice.
- Input simulation (`character_navigation`, `user_keyboard_input`,
  `user_mouse_input`), `screen_capture` (SP2 visual verify), and
  session/multi-Studio (`list_roblox_studios`, `set_active_studio`) — later slices.

## 8. Success criteria

1. `start_stop_play` and `get_console_output` appear in both real and mock
   `allowedTools()`; parity test passes.
2. Mock fakes behave deterministically (start/stop echo by `is_start`; console
   sequence).
3. System prompt instructs conditional play-verify, the client-context caveat, and
   "always stop play when done."
4. Full unit suite + `tsc` + build all green; live play test self-skips without the
   flag.
5. (Manual gate) `BLOX_LIVE_PLAY=1` live test passes against a real attached
   Studio: starts play, sees `IsRunning=true`, reads an injected marker from the
   console, stops play.
