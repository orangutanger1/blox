---
name: ui-check
description: The ui preview / ui lint contract without reading blox's source — what a mount chunk gets (host), how states, devices, safe areas and the top bar are emulated, the lint thresholds, and when to use play mode.
---
# ui preview and ui lint: the contract

## Mount (edit mode, no Play)

- `mount` is edit-context Luau. `host` is a Folder at `CoreGui.__BloxUiEdit`
  standing in for PlayerGui: parent your ScreenGuis to it
  (`UI.screen("HUD", host)`, or `gui.Parent = host`). It is rebuilt before
  every state, so the mount runs once per state.
- `require` is fresh (modules as they are on disk after the sync), so
  require your real UI modules; no LocalPlayer, no RemoteEvents, no
  Camera.ViewportSize truth — pass fake data in.
- Default mount (no `mount`): clones every ScreenGui in StarterGui.
- Scripts in the mounted UI never run in preview/lint: clones drop
  LocalScripts/Scripts. Build the layout in the mount, not in a script.
- BloxUI.fit scales are recomputed per device from their attributes
  (BloxFitHeight/Width/Min/Max/Fill), so fitted panels show true.

## States

`states: [{name, luau}]`: each runs after a fresh mount, with `host` in
scope — open the shop (`host.Menu.Shop.Visible = true`), select a tab, show
a dialog. One preview sheet per state; lint reports `<device>@<state>`.

## Devices (logical px) and insets

| device | size | safe area (top, left, right, bottom) |
|---|---|---|
| phone-landscape | 844×390 | 0, 47, 47, 21 |
| phone-portrait | 390×844 | 47, 0, 0, 34 |
| tablet | 1024×768 | 0, 0, 0, 20 |
| desktop | 1920×1080 | 0 |

A ScreenGui with IgnoreGuiInset = false starts below the 58 px top bar
(or the safe top if larger); with ScreenInsets ≠ None it also keeps the side
and bottom safe areas. Two 44 px Roblox top-bar buttons sit at the top left
(16 + safe left, 6 + safe top) so collisions show. Sheets show devices left →
right in the order above (`devices: [...]` picks a subset). Preview frames
the device in the edit viewport on a green stand-in for the world.

## Lint rules (errors fail the call; warns don't)

Most rules judge buttons (GuiButtons); ±1 px slack; elements clipped by a
scrolling ancestor are skipped.

- offscreen: leaves the device rect (error for buttons, warn otherwise).
- safe-area (buttons): above max(58 px top bar, safe top), or in the side/bottom safe strips.
- touch-target (buttons): shorter side < 44 px on phone/tablet, < 24 desktop.
- overlap (buttons, not nested): covers > 25 % of the smaller one.
- text-overflow: TextFits = false and not TextScaled.
- text-tiny (warn, phones): text renders < 9 px tall.
- off-centre (warn): 1.5–6 px off the parent's centre on an axis no
  UIListLayout/UIGridLayout controls. BloxUI depth parts (Shadow, Face, Lift) skipped.
- touching (warn): sibling buttons side by side/stacked < 2 px apart.
- pill (warn): corner radius ≥ half the height on a button ≥ 1.3× wider than tall.

## Edit vs play

Iterate with `mode:"edit"` (seconds per call). Do ONE `mode:"play"` lint at
the end: it reads the real PlayerGui after `seconds` (default 3), with
`prepare` = client Luau run first (open menus; `require` works). UI that
sizes itself from Camera.ViewportSize is only right in play.
