# BloxUI depth stack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** BloxUI components get the depth-stack look (blue-shifted shadow, face gradient, top lift, even outline, square-ish corners, white text with a dark outline) and new Tile / Panel / Dialog / Tabs pieces, without breaking the existing API.

**Architecture:** In `Sibling` z-order a child always draws above its parent, so every depth component is a transparent holder (the API object, the layout item and the hit box) containing `Shadow` (ZIndex 0, offset down) → `Face` (child of Shadow, offset back up; gradient, outline, corner) → `Lift` (child of Face). Content (labels, icons, lists) is a sibling of Shadow with ZIndex ≥ 1. Buttons hide their own text (`TextTransparency = 1`) and mirror `.Text` into a `Label` child (signal when the engine has one, set at build otherwise).

**Tech Stack:** Luau, Lune offline specs (`kits/_common/files/tests/blox_ui.spec.luau`, run by `tests/ui.kit.test.ts`).

**Spec:** `docs/superpowers/specs/2026-10-07-ui-map-refine-design.md` §2

## Global Constraints

- Existing API keeps working: `screen, label, Button, CurrencyBar, Rail, Modal, Row, Toast, Reveal, fit, fitScale`, the returned fields (`frame, buttons, labels, set, close, list, tabs, open, hide, toggle, button, show, style, ok`), and `Button(...).Text` reads the caption.
- No pills: no `UICorner` radius ≥ half the element's height on any button, tile or bar (the rule the `pill` lint check in piece 3 enforces). Rail buttons stay square (aspect 1) with `Theme.radius`.
- Every button keeps the ≥ 44 px `UISizeConstraint` floor.
- No decoration the caller didn't ask for: icons only when an `icon` image id is passed.
- Colours themeable: each component takes `color` (a Theme style name or a Color3); styles live in `Theme.styles`.

## Review Focus

- Caller sets `button.Text = "x"` after build in the engine → the visible label must update (signal mirror).
- `Tile` in a `UIListLayout` / `UIGridLayout`: the holder is the layout item; the shadow must not become a separate list item.
- Theme style given as a Color3 instead of a name → derive top/bottom/stroke from it (lighter/darker), not crash.
- Disabled button (`disabled = true`) → grey style, `Active = false`, `AutoButtonColor` off.
- A `Panel` content child with default ZIndex 1 must render above the face (Shadow ZIndex 0).

---

### Task 1: Theme + depth helper + Button

**Files:** Modify `kits/_common/files/src/ReplicatedStorage/BloxUI/Theme.luau`, `.../BloxUI/init.luau`; Test `kits/_common/files/tests/blox_ui.spec.luau`, `tests/ui.kit.test.ts` (count).

- [ ] Step 1: failing specs: `UI.depth(frame, "primary")` adds `Shadow` (ZIndex 0, Position.Y.Offset = Theme.depth.shadowOffset) with a `Face` child carrying a `UIGradient` (Rotation 90), a `UIStroke` and a `Lift`; `Button(...)` has `Label` with the text, a text `UIStroke`, and `button.TextTransparency == 1`; no UICorner on the button subtree with `CornerRadius.Offset >= 22` (pill check at the 44 px floor); `Theme.styles.primary.top/bottom/stroke` exist; a Color3 `color` works.
- [ ] Step 2: run `npx vitest run tests/ui.kit.test.ts` → FAIL.
- [ ] Step 3: implement Theme (`font = Enum.Font.FredokaOne`, `radius = 8`, `panelRadius = 12`, `depth = {shadow = Color3.fromRGB(14,24,64), shadowTransparency = 0.45, shadowOffset = 4, liftHeight = 3, outline = 2.5, textStroke = 2}`, `styles` = A's Buy/Upgrade/Max/Close/Tab/TabActive/Window/Row/Disabled/Locked mapped to `primary, info, warn, danger, tab, tabActive, panel, row, disabled, locked, accent`) and `BloxUI.depth(holder, style, opts)`; rebuild `Button`.
- [ ] Step 4: pass. Step 5: commit.

### Task 2: Tile, Panel (drawn X close), Dialog, Tabs; rebuild Modal/Row/Rail/CurrencyBar/Toast/Reveal on them

- [ ] Step 1: failing specs: `Tile(list, {name, title, subtitle, icon?, action, color})` returns `{frame, button, title, subtitle, icon?}` with a depth face and `frame.Size.Y.Offset >= 64`; `Panel(gui, {title})` has `Close` whose glyph is two `Frame` bars rotated ±45 (no "X" text); `Dialog(gui, {title, text, confirm, cancel})` → `{frame, confirm, cancel, show(text?), hide()}` hidden at start; `Tabs(parent, {"Shop","Inventory"}, {vertical=true})` → `{frame, buttons, select(id), selected}` where `select` swaps the face gradient to `tabActive`; `Rail` buttons have aspect 1 and radius `Theme.radius` (not 999); `Modal` still returns `frame, close, list, tabs, open, hide, toggle`; no pill anywhere in `build()`.
- [ ] Step 2: FAIL. Step 3: implement. Step 4: pass, update `expect(r.results.length)` in `tests/ui.kit.test.ts`. Run `npx tsc --noEmit` and the full suite.
- [ ] Step 5: live smoke in a scratch place: build every component in StarterGui via `blox luau` edit context, `screen_capture`, look at it. Commit, PR, merge, `npm run build`.
