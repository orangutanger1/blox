# UI kit + deterministic UI lint (pipeline item 4)

Research §I: ~80% of sessions are mobile, UI bugs are the most visible quality signal,
and the checks that matter (off-screen, safe area, touch targets, overlaps, text
overflow) need no vision — they are geometry.

## UI lint

`ui {action:"lint", seconds?=3, prepare?, devices?}` (MCP + CLI `blox ui lint`):
1. Start (or reuse) a playtest; wait `seconds`; run optional `prepare` client Luau (open
   the shop, etc.).
2. **Device emulation probe** (client context, no plugin APIs): for each device, a
   hidden ScreenGui holds a Frame of the device's logical pixel size; each enabled
   PlayerGui ScreenGui's children are cloned (scripts stripped) into a container
   inset by that ScreenGui's `ScreenInsets`/`IgnoreGuiInset` and the device's safe
   area + 58 px topbar. Two frames later the layout engine has resolved scale,
   constraints, list layouts and TextFits; the probe reports every visible GuiObject
   rect relative to the device, button-ness, text props, and its source path. Plus a
   `studio` snapshot of the real viewport.
3. Pure TS rules (`src/ui/lint.ts`) per device → findings `{rule, severity, device,
   path, detail}`:
   - `offscreen` — rect leaves the device (error for buttons, warn otherwise)
   - `safe-area` — a button overlaps the topbar or the device's unsafe insets (error)
   - `touch-target` — button smaller than 44 px on phone/tablet (error), 24 px desktop
   - `overlap` — two visible buttons overlap > 25% of the smaller (error)
   - `text-overflow` — non-scaled text with `TextFits == false` (error)
   - `text-tiny` — rendered text under 9 px on phones (warn)
4. Writes `.blox/ui-report.json`; each rule becomes a synthetic test `ui:<rule>`
   (pass = no error findings for it on any device).

Devices: `phone-landscape` 844×390 (safe L/R 47, bottom 21), `phone-portrait` 390×844
(top 47, bottom 34), `tablet` 1024×768, `desktop` 1920×1080. Inset rules approximate
Roblox's; documented in code.

## UI kit (BloxUI)

`kits/_common/files/src/ReplicatedStorage/BloxUI/` (ships with every kit; `ui install`
for other projects): `Theme`, `Button` (scale-sized, `UISizeConstraint` min 44,
`UIAspectRatioConstraint` for round icons), `CurrencyBar` (top-centre counters with
optional `+`), `Rail` (left rail of round buttons), `Modal` (title, close, tabs, scroll
list), `Toast` (stack, auto-expire), `Reveal` (full-screen reward card), `screen(name)`
(ScreenGui with `CoreUISafeInsets`, `ResetOnSpawn=false`). Components build instances
only; callers connect events. The incremental kit HUD is rebuilt on BloxUI.

## Verification
Rules unit-tested on synthetic snapshots; probe program + tool orchestration against
the fake Studio; BloxUI built under Lune (`@lune/roblox` instances) by an edit spec
that asserts min touch sizes and scale sizing (also runs in Studio). Live smoke
pending: kit project → `blox ui lint` clean on all four devices.

Non-goals: gamepad selection paths, VLM style review, real device-simulator plugin RPC.
