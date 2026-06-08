# blox SP2-a — input simulation (`character_navigation`, `user_keyboard_input`, `user_mouse_input`)

**Date:** 2026-06-08
**Status:** Design approved → ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-06-06-blox-design.md` (§7 SP2 "Richer context")
**Predecessor:** SP1c-d (tier-2 play) — complete and merged to `main` (HEAD `8cc8e2c`). SP1 MVP is complete.
**Scope note:** First SP2 slice. SP2 bundles three independent capabilities — richer
context (dependency graph / semantic map / retrieval), a visual-verify tier
(`screen_capture` + vision), and **input-sim scenarios**. This slice does input-sim
only; the other two are later slices (SP2-b, SP2-c). It builds directly on the
tier-2 play loop: input tools only work while a play session is running.

## 1. Goal

Let the agent verify *interactive* gameplay — player movement, key presses, mouse
actions — by exposing three Studio input-sim MCP tools and guiding their use:

- `character_navigation` — move the player character to a position or instance.
- `user_keyboard_input` — send an ordered list of keyboard actions.
- `user_mouse_input` — send an ordered list of mouse actions.

This extends the verify loop from "run the game and read output" (SP1c-d) to "drive
the player and assert the game responds."

## 2. The gap this closes

SP1c-d lets the agent start play, run `execute_luau` in the running client, and read
the console. But it cannot *act as a player*: it can't move the character, press a
key, or click. Any behavior gated on player input — movement, controls, UI buttons,
interaction prompts — is unverifiable. This slice gives the agent those input
primitives so it can exercise gameplay the way a player would and then assert the
result through the SP1c-d observation tools.

## 3. Grounding facts (live-probed 2026-06-08)

Probed directly against Windows Studio over the WSL `cmd.exe → mcp.bat` hop, using
the SP1c-a MCP client.

**Hard requirement — play mode:** all three tools return `isError: true` in edit
mode with the exact message `"This tool is only available in play mode with client
datamodel focused."` They require an active play session (the SP1c-d
`start_stop_play {is_start:true}`). In play they return `isError: false` with text
`"Success"` (`character_navigation` also returns `"Success"`).

**Observability:** effects are visible from `execute_luau` running in the play
client (the SP1c-d client-context path). In the fixture place: 1 player spawns,
`LocalPlayer.Character` exists, HumanoidRootPart starts at `0, 5, 0`. A
`character_navigation {x:12, y:5, z:12, speed_multiplier:2.0}` call returned
`Success` and the HRP moved to ~`6.5, 4.5, 6.5` within 4s.

**Navigation is asynchronous:** the call returns `Success` immediately but the
character keeps moving afterward (pathfinding). Verification must **poll/wait for
arrival** (or for the position to change), not assert the exact target instantly.

**Probed schemas (exact, from `listTools` `inputSchema`):**

- `character_navigation`: `{ instance_path?: string, x?: number, y?: number, z?: number, speed_multiplier?: number }`. Nothing strictly required, but `x`/`y`/`z` are required when `instance_path` is absent. `instance_path` starts with `game`/`LocalPlayer`/`Workspace`. `speed_multiplier` default 1.0, range 0.1–10.0.
- `user_keyboard_input`: `{ actions: [ { action: 'keyDown'|'keyUp'|'keyPress'|'textInput'|'wait', key_code?: <enum>, instance_path?: string, text_inputs?: string, wait_time_ms?: number } ] }`. `actions` required; each step requires `action`. `key_code` required for keyDown/keyUp/keyPress (large enum incl. `Space`, `Return`, letters, digits, gamepad and mouse codes). `text_inputs` required for `textInput`. `wait_time_ms` required for `wait` (0–10000).
- `user_mouse_input`: `{ actions: [ { action: 'moveTo'|'mouseButtonDown'|'mouseButtonUp'|'mouseButtonClick'|'scrollUp'|'scrollDown'|'wait', x?: number, y?: number, instance_path?: string, mouse_button?: 'left'|'right', wait_time_ms?: number } ] }`. `actions` required; each step requires `action`. `mouse_button` required for button actions. `x`/`y` or `instance_path` set position; later steps reuse the prior position; `instance_path` overrides `x`/`y`.

## 4. Architecture

**Agent-driven pass-through**, identical in shape to SP1c-d. No new blox module, no
orchestration: expose the tools, fake them in the mock bridge, guide their use in
the system prompt.

### 4.1 Real bridge (`src/bridge/mcpBridge.ts`)

Add `character_navigation`, `user_keyboard_input`, `user_mouse_input` to the `TOOLS`
array (12 → 15). `allowedTools()` already maps each to
`mcp__Roblox_Studio__<tool>`. Both already advertised by the live proxy catalog.

### 4.2 Mock bridge (`src/bridge/mockBridge.ts`)

Add three in-process fakes whose zod schemas mirror the probed shapes (a single
nested `actions` array element schema reused for keyboard/mouse; a flat schema for
navigation). The fakes ignore inputs and return deterministic canned text:

- `character_navigation` → `"[mock] navigated"`.
- `user_keyboard_input` → `"[mock] Success"`.
- `user_mouse_input` → `"[mock] Success"`.

Add the three names to the mock `allowedTools()` list to keep full parity with the
real surface (the parity test guards this). No new mock option is needed (no
sequence/fix-loop semantics required for input).

### 4.3 System prompt (`src/agent/systemPrompt.ts`)

Add an input-sim block to the verify guidance:

- Input tools work **only while play is running** (start with `start_stop_play`
  first; the SP1c-d block already covers starting/stopping play).
- To verify player-driven behavior: start play, drive input
  (`character_navigation` / `user_keyboard_input` / `user_mouse_input`), then assert
  the result with `execute_luau` (client context) or `get_console_output`.
- `character_navigation` is asynchronous — after it returns, **wait/poll** for the
  character to reach the target (e.g. re-read HumanoidRootPart position) before
  asserting; do not expect instant arrival.
- Prefer `character_navigation` for movement checks (position is directly readable
  and assertable). Use keyboard/mouse for controls and UI; their effect depends on
  the game wiring input handlers.

## 5. Components & responsibilities

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `mcpBridge.TOOLS` | Declare the 3 input tool names so they're allowed | — |
| `mockBridge` fakes | Deterministic offline input tools (canned success) | zod |
| `systemPrompt` input block | Tell the agent input needs play, drive-then-assert, async-nav | SP1c-d play block |

## 6. Testing

### 6.1 Unit (no live Studio)

- **real `TOOLS`**: `mcpBridge` `allowedTools()` contains all three input tools.
- **mock parity**: mock `allowedTools()` set equals real `allowedTools()` set (the
  existing parity test now covers 15 tools).
- **mock fakes present**: mock `allowedTools()` contains the three input tools.
- **system prompt**: contains `character_navigation`, `user_keyboard_input`,
  `user_mouse_input`, and the async-nav guidance (a stable substring such as
  `'wait'`/`'poll'` for arrival and the play-required note).

### 6.2 Gated live test (`BLOX_LIVE_INPUT=1`)

`tests/e2e/live-input.test.ts`. Self-skips unless `BLOX_LIVE_INPUT=1`. Requires a
live Studio attached with a place that spawns a player character. Reuses the
SP1c-a `defaultClientFactory` persistent client. Flow:

1. Start play (attach-retry); poll `RunService:IsRunning()` until `true`.
2. Read HumanoidRootPart position (retry until `LocalPlayer.Character` exists).
3. `character_navigation` to an offset from the start position; assert the call
   returns non-error `Success`.
4. Poll the HRP position until it has **changed** from the start position (bounded
   retries; navigation is async); assert it moved.
5. `user_keyboard_input` `keyPress Space` and `user_mouse_input` `moveTo`+`click`;
   assert each returns non-error (`Success`).
6. Stop play in a `finally`; close the client.

(The keyboard/mouse assertions are success-only because their game-visible effect
depends on the place wiring input handlers; movement is the deterministic signal.)

### 6.3 Full suite

`npm test` green, `tsc` clean, `npm run build` clean. Gated live test skipped in CI.

## 7. Out of scope

- **Visual-verify** (`screen_capture` + vision) — SP2-b.
- **Richer context** (dependency graph, semantic game map, retrieval) — SP2-c.
- **Session / multi-Studio** (`list_roblox_studios`, `set_active_studio`).
- **Blox-owned input orchestration / scenario DSL.** The agent composes input
  through the raw tools, the same way it composes `execute_luau`. No blox sequencing
  layer.
- **Per-tool sync gate or play gate.** Unchanged from SP1c-d (agent owns play
  lifecycle; managed `rojo serve` already propagates files).

## 8. Success criteria

1. `character_navigation`, `user_keyboard_input`, `user_mouse_input` appear in both
   real and mock `allowedTools()`; parity test passes (15 tools).
2. Mock fakes behave deterministically (canned success text), with zod schemas that
   accept the probed input shapes.
3. System prompt instructs: input requires play, drive-then-assert via
   `execute_luau`/`get_console_output`, and `character_navigation` is async (wait
   for arrival).
4. Full unit suite + `tsc` + build all green; live input test self-skips without the
   flag.
5. (Manual gate) `BLOX_LIVE_INPUT=1` live test passes against a real attached
   Studio: starts play, navigates the character, observes the HRP position change,
   and the keyboard/mouse calls succeed.
