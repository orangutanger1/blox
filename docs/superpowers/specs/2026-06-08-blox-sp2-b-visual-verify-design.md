# blox SP2-b — visual verification (`screen_capture` + Opus vision)

**Date:** 2026-06-08
**Status:** Design approved → ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-06-06-blox-design.md` (§7 SP2 "Richer context")
**Predecessor:** SP2-a (input simulation) — complete and merged to `main` (merge `a6fd062`). SP1c-d (tier-2 play) and the rest of SP1 MVP are complete.
**Scope note:** Second SP2 slice. SP2 bundles three independent capabilities — richer
context (dependency graph / semantic map / retrieval), a **visual-verify tier**
(`screen_capture` + vision), and input-sim scenarios (done in SP2-a). This slice does
visual-verify only; richer context is a later slice (SP2-c). It builds directly on the
tier-2 play loop: `screen_capture` only works while a play session is running.

## 1. Goal

Let the agent verify *visual/rendered* game state — UI layout, model appearance,
VFX, lighting, on-screen feedback — by exposing the Studio `screen_capture` MCP tool
and guiding its use. The captured frame is forwarded to the model as a vision input
(see §3), so Opus can look at the running game and reason about what it sees.

This extends the verify loop from "run the game, drive input, and assert via Luau /
console" (SP1c-d + SP2-a) to "look at the rendered frame and judge it" — the tier-3
visual layer named in the master design §7.

## 2. The gap this closes

After SP1c-d (start play, run `execute_luau` in the client, read console) and SP2-a
(drive character/keyboard/mouse), the agent can exercise gameplay and assert anything
expressible in Luau or printed to the console. But a large class of correctness is
**only visible on screen**: did the UI lay out correctly, is the generated mesh/material
visually right, did a particle effect fire, is the camera framed sensibly, is something
clipping or invisible. None of that is reliably assertable through the DataModel alone.
`screen_capture` closes that gap by giving the agent the rendered frame to inspect.

## 3. Grounding facts

**Not live-probed this session** (no Windows Studio attached during this design).
Sources: the captured Studio MCP reference (`docs/reference/roblox-studio-mcp.md`),
the SP1c-a live tool catalog (which lists `screen_capture` among the 26 advertised
tools), and inspection of the installed Agent SDK source.

**Play-mode tool (from reference):** `screen_capture` "captures the Studio viewport in
Play mode and returns the image data (for visual verification)." It is therefore
expected to be play-only, mirroring SP2-a's input tools and SP1c-d's runtime path —
start a play session first (`start_stop_play {is_start:true}`).

**Argument schema: unknown (not probed).** Treated as a non-blocking unknown — see §4.4.
The real bridge needs only the tool name; the live test calls it with no arguments and
adapts to the observed schema; the mock uses a permissive/empty argument schema.

**Image is forwarded to the model as vision (verified — `@anthropic-ai/claude-agent-sdk`
0.3.168 source).** MCP tool results carry typed content blocks; the SDK defines an MCP
image-content schema `{ type: "image", data: <base64>, mimeType: string }` and converts
it into an Anthropic vision block `{ type: "image", source: { type: "base64",
media_type, data } }` (`mimeType` → `media_type`, base64 `data` passed through) before
the result reaches the model. So a `screen_capture` result containing an image block is
seen by Opus as an image with **no blox-side handling** — this is what makes pure
pass-through viable for visual-verify. The same forwarding applies whether the result
comes from the external Studio MCP server (real bridge, stdio) or an in-process
`createSdkMcpServer`/`tool` handler (mock bridge).

## 4. Architecture

**Agent-driven pass-through**, identical in shape to SP1c-d and SP2-a. No new blox
module, no image persistence, no orchestration: expose the tool, fake it in the mock
bridge, guide its use in the system prompt. The SDK does the image→vision forwarding.

### 4.1 Real bridge (`src/bridge/mcpBridge.ts`)

Add `screen_capture` to the `TOOLS` array (15 → 16). `allowedTools()` already maps each
name to `mcp__Roblox_Studio__<tool>`. The tool is already advertised by the live proxy
catalog (SP1c-a).

### 4.2 Mock bridge (`src/bridge/mockBridge.ts`)

Add one in-process fake. Unlike the other mock fakes (which return text), this fake
returns an **image content block** so the mock exercises the same content shape the real
tool produces and the SDK forwards:

- `screen_capture` → `{ content: [{ type: 'image', data: <tiny 1×1 PNG base64>, mimeType: 'image/png' }] }`.

The fake ignores its inputs and uses a permissive/empty zod argument schema (the real
arg schema is unknown — §4.4). Add `screen_capture` to the mock `allowedTools()` list to
keep full parity with the real surface (the parity test guards this). No new mock option
is needed.

### 4.3 System prompt (`src/agent/systemPrompt.ts`)

Add a visual-verify block to the verify guidance, after the SP2-a input-sim block:

- `screen_capture` works **only while play is running** (start with `start_stop_play`
  first; the SP1c-d block covers starting/stopping play).
- Use it to confirm **visual/rendered** state that Luau and the console can't assert:
  UI layout, model/mesh/material appearance, VFX, camera framing, on-screen feedback.
- The captured frame comes back as an image you can see directly — describe and judge
  what is rendered, then continue the verify loop.
- Pair with input-sim: drive the player (SP2-a) or set up state, **then** capture to see
  the result.
- Prefer `execute_luau` / `get_console_output` for non-visual checks — `screen_capture`
  is for things only visible on screen, and a capture is comparatively expensive.

### 4.4 Unknown argument schema (handling)

The exact `screen_capture` input schema is not probed this session. This is handled the
same way `get_console_output` / `start_stop_play` were before live confirmation:

- **Real bridge:** only the tool name is added to the allow-list; the live Studio MCP
  server owns and enforces the real schema. No schema lives in blox.
- **Mock bridge:** permissive/empty argument schema (accepts a no-arg call).
- **Live test:** calls `screen_capture` with no arguments first; if the server requires
  arguments, adapt the call to the observed `inputSchema` from `listTools`.

If a live probe later reveals required arguments, the only follow-up is tightening the
mock's zod schema to match; the real bridge and the pass-through architecture are
unaffected.

## 5. Components & responsibilities

| Unit | Responsibility | Depends on |
| --- | --- | --- |
| `mcpBridge.TOOLS` | Declare the `screen_capture` name so it's allowed | — |
| `mockBridge` fake | Deterministic offline capture returning an image content block | zod |
| `systemPrompt` visual block | Tell the agent capture needs play, is for visual-only checks, returns a viewable frame | SP1c-d play block, SP2-a input block |

## 6. Testing

### 6.1 Unit (no live Studio)

- **real `TOOLS`**: `mcpBridge` `allowedTools()` contains `screen_capture`.
- **mock parity**: mock `allowedTools()` set equals real `allowedTools()` set (the
  existing parity test now covers 16 tools).
- **mock fake present**: mock `allowedTools()` contains `screen_capture`.
- **mock returns an image**: calling the mock `screen_capture` fake returns a content
  block with `type: 'image'` (not text) — guards the vision-forwarding shape.
- **system prompt**: contains `screen_capture` and the visual-verify guidance (stable
  substrings: a play-required note and a "visual"/"see" cue).

### 6.2 Gated live test (`BLOX_LIVE_CAPTURE=1`)

`tests/e2e/live-capture.test.ts`. Self-skips unless `BLOX_LIVE_CAPTURE=1`. Requires a
live Studio attached with a place open. Reuses the SP1c-a `defaultClientFactory`
persistent client. Flow:

1. Assert `screen_capture` is present in `listTools`.
2. Start play (attach-retry); poll `RunService:IsRunning()` until `true`.
3. Call `screen_capture` (no args; adapt to `inputSchema` if the server requires args).
4. Assert the call returns non-error (`isError !== true`) and its `content` carries at
   least one block with `type === 'image'` (with non-empty `data`).
5. Stop play in a `finally`; close the client.

### 6.3 Full suite

`npm test` green, `tsc` clean, `npm run build` clean. Gated live test skipped in CI
(skip count up by 1 vs the SP2-a baseline).

## 7. Out of scope

- **Image persistence / run-report artifacts.** No saving captures to disk, no
  surfacing them in the run report. The frame goes to the model via the SDK and is not
  retained by blox. (Candidate for SP4 polish if a need appears.)
- **`store_image`.** The MCP's own image-save tool is not exposed; no current consumer.
- **Richer context** (dependency graph, semantic game map, retrieval) — SP2-c.
- **Session / multi-Studio** (`list_roblox_studios`, `set_active_studio`).
- **Blox-owned visual-diff / golden-image comparison.** The agent judges the frame with
  vision; no pixel-diff or baseline-image subsystem.
- **Per-tool sync gate or play gate.** Unchanged from SP1c-d (agent owns play lifecycle;
  managed `rojo serve` already propagates files).

## 8. Success criteria

1. `screen_capture` appears in both real and mock `allowedTools()`; parity test passes
   (16 tools).
2. The mock fake behaves deterministically and returns an **image** content block (not
   text), with a permissive zod schema that accepts a no-arg call.
3. System prompt instructs: capture requires play, is for visual-only verification, and
   returns a frame the agent can see and judge.
4. Full unit suite + `tsc` + build all green; live capture test self-skips without the
   flag.
5. (Manual gate) `BLOX_LIVE_CAPTURE=1` live test passes against a real attached Studio:
   starts play, captures the viewport, and the result carries an image content block.
