# Edit-mode UI preview and lint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `ui preview` and `ui lint {mode:"edit"}` show and check a game's UI at every device size without Play, from a `mount` chunk; lint gains `off-centre`, `touching` and `pill` rules.

**Architecture:** A mount program (edit context, fresh `require`) creates `CoreGui.__BloxUiEdit` (a Folder standing in for PlayerGui) and runs the caller's `mount` chunk with `host` bound to it (default mount: clone StarterGui's ScreenGuis), then an optional state chunk. Lint reuses `uiProbeProgram` with its GUI root pointed at that folder. Preview stages one device at a time as `StarterGui.__BloxUiPreview` (ShowDevelopmentGui) — the device frame with the top-bar/safe insets, the cloned UI, BloxUI.fit recomputed, and a UIScale that fits it in the viewport — then `screen_capture`s, crops the device rect, and joins the crops into one JPEG contact sheet (devices across, states down) with jpeg-js. Everything staged is removed in `finally`.

**Tech Stack:** TypeScript, Luau programs as strings, jpeg-js, vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-ui-map-refine-design.md` §3

## Global Constraints

- Report file stays `.blox/ui-report.json`; result ids stay `ui:<rule>`; new rules are added to `UI_RULES`.
- New rules are warnings except none (all three `warn`), so existing games don't start failing the release gate.
- Never leave `__BloxUiEdit` / `__BloxUiPreview` behind (finally + a cleanup at the start of each run).
- The official MCP has no device simulator: document that UI reading `Camera.ViewportSize` is not measured truly in edit mode.

## Review Focus

- Mount chunk errors → the tool returns the Luau error with the state name, and still cleans up.
- No ScreenGui produced by mount (and none in StarterGui) → a clear note, not an empty pass.
- `states` with duplicate names → error before staging.
- Capture returns no image (Studio minimised) → restoreFor first; a missing image is reported per device, the sheet still builds from the rest.
- Depth-stack internals (`Shadow`, `Face`, `Lift`) must not trigger `off-centre`.

---

### Task 1: lint rules off-centre, touching, pill

**Files:** Modify `src/ui/lint.ts`, `src/ui/probe.ts` (element `cr`, corner radius px for buttons: the button's UICorner, else its `Shadow` child's); Test `tests/ui.lint.rules.test.ts`.

- [ ] Failing tests (pure `lintSnapshot`): a child 3 px off its parent's centre → `off-centre` warn; 0.5 px off or 20 px off → none; a `.Shadow` element 4 px off → none. Two sibling buttons 1 px apart → `touching` warn; 6 px apart → none; nested → none. A button 200×50 with `cr` 25 → `pill` warn; 50×50 with `cr` 25 (a circle) → none; 200×50 with `cr` 8 → none. `lintResults` includes the three ids.
- [ ] Implement; tests pass; commit.

### Task 2: probe root + mount/preview programs + contact sheet

**Files:** Create `src/ui/stage.ts` (`mountProgram(mount?, state?)`, `previewProgram(device)`, `UNSTAGE`), `src/ui/sheet.ts` (`cropJpeg(buf, rect)`, `composeSheet(rows: (Buffer|null)[][], cellH)`); modify `src/ui/probe.ts` (`uiProbeProgram(device, skip, budget, root?)`); Test `tests/ui.stage.test.ts`, `tests/ui.sheet.test.ts`.

- [ ] Failing tests: `mountProgram` wraps the chunk in a function receiving `host`, destroys an old `__BloxUiEdit` first, and the default (no mount) clones StarterGui ScreenGuis; `uiProbeProgram(d,0,1e6,'EDIT')` reads from `CoreGui.__BloxUiEdit` and never touches `LocalPlayer`; `previewProgram` returns JSON with `vw, vh, x, y, w, h`; `composeSheet` of 2×2 solid JPEGs gives a JPEG whose decoded size is (2 cells wide + gaps) and whose cell pixels keep their colours; a `null` cell is drawn dark grey.
- [ ] Implement; pass; commit.

### Task 3: run + tool + CLI

**Files:** Modify `src/ui/run.ts` (`runUiLintEdit`, `runUiPreview`), `src/tools/registry.ts` (`ui` actions `preview`, `lint` with `mode`, `mount`, `states`), `src/cliTools.ts` (`--mode edit --mount <luau|@file> --states <json|@file>`); Test `tests/ui.edit.run.test.ts` with a fake session (`execute_luau` answers per program marker, `screen_capture` returns a tiny JPEG).

- [ ] Failing tests: edit lint never calls `start_stop_play`, runs mount once per state, probes each device, writes findings with `device` = `phone-portrait@shop` when states are given, and calls UNSTAGE last even when the mount fails (error surfaced). Preview returns one image per state, writes `.blox/ui-preview/<state>.jpg`, and calls UNSTAGE.
- [ ] Implement; full suite + tsc; live smoke on a scratch place (mount BloxUI showcase; preview + edit lint); commit; PR; merge; `npm run build`.
