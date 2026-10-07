# UI and map component refine (from the quality bake-off)

Source: handoff `docs/handoff/2026-10-08-ui-map-refine.md`, bake-off `bench/results/quality-bakeoff-2026-10-07.md`.

## Intent

blox beat the article workflow on both blind tasks, but the user named what the losing side did better. Port
those wins into blox so the next Dog Attack work (Plan 5 maps, Plan 5b UI polish) starts from a better tool.

- **Said by the user:** keep blox's layout ("simple yet effective"), and use the article side's buttons and
  tiles, not pills. No random decoration (the mascot dog). Maps: keep the cohesive layout, but use a more
  vibrant, saturated look, because many players are young kids. Icons come from Qwen-Image-2.1 on Kaggle.
- **Success:** a blind sheet of old blox vs new blox on the same two bake-off tasks, and the user picks the
  new one. Report cost, turns and time beside it.
- **Constraints:** scratch places only, never `DogAttack.rbxl`. Uploads are fine. Never create, price or
  publish passes, products or places. No multiplayer tests. Model-agnostic tools (memory
  `model-agnostic-design`).

## Findings that shape the design

1. **Vibrancy came mostly from lighting, not the part colours.** A's palette RGB values are ordinary. A set
   `ColorCorrection.Saturation = 0.12` and light atmosphere; B set `Atmosphere.Haze = 0.8`, which washes
   colour out. So the "saturated palette" is a palette **plus** a lighting preset, and it is measured on
   rendered pixels, not on part colours alone.
2. **B's 226k triangles** came mostly from cylinder parts (silo, poles) across a larger built area. A budget
   has to know per-shape triangle costs.
3. **The official Studio MCP has no device simulator.** robloxstudio-mcp has one, but blox only depends on
   the official MCP. The edit-mode preview therefore lays UI out inside device-sized frames (what B's
   `tools/preview.luau` did). UI code that reads its parent's `AbsoluteSize` is measured truly; code that
   reads `Camera.ViewportSize` is not, and the docs say so.
4. **Qwen notebook** (tamadaresearch): T4 #0 runs the denoiser and VAE, T4 #1 the text encoder. About 147 s
   per 1024² image warm. It takes one `--prompt` per run, verifies the three weight files by size and
   SHA-256, and never downloads weights itself.

## Pieces (one PR each, in this order)

### 1. Play blocked by a locked PC: fail fast

- `startPlay` (`src/studio/play.ts`) checks a lock probe before and after `start_stop_play`. The probe, on
  WSL or Windows hosts, runs `powershell.exe Get-Process LogonUI` (present = locked or at the sign-in screen).
- If locked: throw `StudioError('play_blocked', 'Windows session is locked (LogonUI is running): Studio cannot
  enter Play until someone unlocks the PC. Edit-mode tools (sync, check, ui preview, map check) still work.')`.
- If `start_stop_play` reports success but the mode stays `Edit` for 15 s, the error says the same and names
  the lock as the likely cause. No more silent polling.
- The probe is injected (a function), so unit tests fake it. Linux-native hosts skip it.

### 2. BloxUI depth stack (no pills)

`kits/_common/files/src/ReplicatedStorage/BloxUI/` changes:

- **Theme tokens:** `radius = 8` for buttons and tiles, `panelRadius = 12`; `depth = { shadow = Color3(14,24,64),
  shadowTransparency = 0.55, shadowOffset = 4, lift = 0.18, gradient = 0.22, outline = 2.5 }`; `textStroke`
  (dark outline on white text, ZA style); a palette of button colours (`primary` green, `info` blue, `warn`
  yellow, `danger` red, `accent` purple, `disabled` grey) and the `fontHeavy` used for titles.
- **`BloxUI.depth(frame, color)`**: one helper that adds the stack to any frame: a shadow frame behind
  (blue-shifted, offset down), a vertical `UIGradient` on the face (lighter top, darker bottom), a top-lift
  strip (a white frame at 18% opacity over the top third, rounded), and a `UIStroke` outline darker than the
  face. Every component uses it.
- **Components:** `Button` (existing API kept, look changed), `Tile` (icon + title + subtitle + action button;
  for shop rows and inventory cells), `Panel` (titled window with a close button that is a drawn X built from
  two rotated bars, not a font glyph), `Dialog` (confirm/cancel), `Tabs` (vertical or horizontal tab rail;
  selected tab uses the `warn` yellow, like ZA). `Modal`, `Row`, `Rail` are rebuilt on these, with their
  APIs kept, so existing games keep working.
- **No decoration** beyond what a component needs: no mascots, no emoji, icons only where the caller passes
  an image.
- Tests: the existing offline kit tests (`tests/ui.kit.test.ts`) extend to the new components (built
  instances, sizes, the depth children present, no `UICorner` radius ≥ half the height = no pill).

### 3. Edit-mode UI preview and lint

New `ui` tool actions, with `mount` = edit-context Luau that builds the UI into a parent it is given:

- **`ui preview {mount, devices?, states?}`**: no Play. For each device, a device-sized frame (with the top
  bar and safe-area insets of `DEVICES`) is staged in a temporary `ScreenGui` in `StarterGui` (with
  `ShowDevelopmentGui`), the mount code runs with that frame as its parent, and `screen_capture` takes a
  shot. `states` is an optional list of `{name, luau}` steps run after mount (open the shop, show the
  confirm). The shots are joined into one contact sheet PNG (devices across, states down) written to
  `.blox/ui-preview/<state>.png`, and returned as an image. The stage is always removed afterwards.
- **`ui lint {mode: "edit", mount, states?}`**: the same staging, then the existing probe program runs on
  the staged frames instead of `PlayerGui` (the probe gets a `root` parameter), and the existing rules run.
  Same report file, so `ui:<rule>` criteria and the release gate work unchanged.
- **New rules** (both modes): `off-centre`: an element whose centre is within 6 px of its parent's centre
  on an axis but more than 1.5 px off it (meant to be centred, isn't). `touching`: two sibling buttons or
  tiles with a gap of 0–2 px (they look stuck together) — but not inside a `UIListLayout` with padding 0
  that the author chose, which is reported as one note per list instead. `pill`: a button whose `UICorner`
  radius is at least half its height (warn; the user rejected pills).
- `ui install` also installs `BloxUI/Preview.luau`, a tiny helper the mount code can use to read the device
  frame size.

### 4. AI image generation: `blox image`

New `image` tool and CLI (`src/image/`):

- **`image generate {items: [{name, prompt, seed?}], style?, size?=512, backend?}`** writes
  `assets/icons/<name>.png` (transparent RGBA) and adds an asset manifest entry per image with
  `source: "generated"`, a new licence value `qwen-research` (non-commercial) or `generated-flux` (Apache
  2.0 schnell output), and the model, backend, prompt and seed in a `provenance` field.
- **Style presets** prepended to each prompt: `icon` (default: "game UI icon, single centred object, bold
  black outline, flat cel shading, saturated colours, plain white background, no text") and `item` and
  `badge`. The caller can pass a raw `style` string instead.
- **Backends (pluggable, one interface `generate(items) → PNG buffers`):**
  - `kaggle-qwen` (default). One Kaggle kernel per batch: blox writes a kernel folder (the tamadaresearch
    notebook's launcher cells, plus a loop over `items.json` that calls the runtime once per item with its
    seed), attaches the runtime dataset and the user's weights, pushes it with `~/.local/bin/kaggle kernels
    push`, polls `status` (every 30 s, timeout 60 min), downloads `output`, and matches images to names.
  - **Weights, one-time `image setup`:** a "weights" kernel that downloads the three pinned Comfy-Org files
    from Hugging Face into its output (17.3 GB, under Kaggle's 20 GB output limit). The batch kernel attaches
    it through `kernel_sources`, so nothing is uploaded from the user's PC. If Kaggle refuses that, the
    fallback is the private dataset from the handoff. Setup is checked once and remembered in
    `~/.config/blox/image.json`.
  - `cloudflare-flux`: Workers AI `@cf/black-forest-labs/flux-1-schnell` with the wrangler OAuth token
    (`~/.wrangler/config/default.toml`; never logged). Used when asked, or when Kaggle fails (quota,
    auth, timeout), and the result says which backend ran.
- **Background removal:** if the image already has alpha, keep it. Otherwise flood-fill the near-white
  background from the border (A's TRAPS #15: a full matte model eats white fills). Then trim to content,
  pad to square, and resize to `size`.
- **Then** the existing `asset sheet` and `asset upload` take over. `release check` gets a `licence` gate
  that fails when any in-use asset is `qwen-research` and `blox.config.json` has `"monetized": true`.

### 5. Map component

**5a. `BloxMap` kit** (`kits/_common/files/src/ReplicatedStorage/BloxMap/`, installed by `map install`, used
by `world/*.luau` builders):

- `Palette.luau`: a saturated, kid-friendly default (grass, dirt, road, kerb, brick red, barn red, cream,
  roof grey/blue/red, wood, hay, metal, glass…) as `{color, material}`, each with HSV saturation ≥ 0.35
  except the neutrals (road, kerb, metal, glass).
- `Lighting.luau`: `apply(preset)`, with `"bright"` as the default: `ColorCorrection.Saturation = 0.15`,
  contrast 0.05, `Atmosphere` density 0.25 and haze ≤ 0.3, clear sky colour, brightness 2.5.
- `Build.luau`: `part`, `building {size, floors, doors, windows, roof = "gable"|"flat", enterable}` (real
  door and window openings built from wall segments, an enterable ground floor with a floor part, solid
  upper floors), `roof`, `boundary {size, height}` (visible walls plus an invisible, taller kill-free barrier
  so nobody climbs out), `road {from, to, width, kerb}` with kerbs, and props (`crate`, `bale`, `fence`,
  `pole`, `lamp`, `tree`). Cylinders are built with low-poly options (the silo as an 8-sided prism of
  parts) to keep the triangle count down. Based on B's `FarmTown.luau` and A's `Builders.luau`.

**5b. `map check`** (`src/map/`): one edit-mode Luau program (ported from the judge's `map_metrics.luau`
and A's `MapCheck.luau`) plus pure TS evaluation:

- **Input:** the map root (`map.root` in `blox.config.json`, default `Workspace.Map`), spawn names
  (player spawns = `SpawnLocation`s; extra named groups such as `DogSpawns`, `BossSpawn` from config), the
  boundary (the root's bounding box unless configured), and movement: `WalkSpeed`, and jump height =
  `StarterPlayer.CharacterJumpHeight` (or from `JumpPower`) **+ 0.9 studs take-off** (A's measured trap),
  overridable in config.
- **Search:** a 2-stud raycast grid; a point counts only where a 1.2 × 4.3-stud standing volume is free.
  Moves: walk, jump up to the jump height, drop any height, with a clear sideways ray. Forward from the
  player spawns and backward to them.
- **Checks** (each a result `map:<id>` for criteria and the release gate): `spawns-reach` (every named spawn
  reaches the player spawn), `pockets` (reachable points with no way back), `roofs` (reachable points more
  than jump height above the ground, listed), `covered` (reachable points under a roof, listed with whether
  they are inside a part named or tagged `Interior`), `floating` (unanchored or unsupported parts),
  `overlap` (parts that interpenetrate by more than 0.2 studs, excluding welded decor), `leak` (reachable
  points outside the boundary), `triangles` (estimated triangles; budget default 30k), `saturation` (the
  area-weighted mean HSV saturation of visible parts, warn under 0.30). Sightlines are reported as a
  summary only, never a failure.
- **Triangles:** a per-shape table (block 12, wedge 10, corner wedge 8, cylinder and ball calibrated once
  against robloxstudio-mcp's `triangle_composition` in the judge kit and stored in code), plus MeshParts
  through `AssetService:CreateEditableMeshAsync` face counts when the API allows, else counted as unknown.
- Output: `.blox/map-report.json`, a short text report with sample coordinates, and `release check` gains a
  `map` gate (required when the project has a map root).

**5c. `map shots`**: one call that frames the reachable area (from the last `map check`, or the map's
bounding box): 4 high corner views, 2 eye-level views (from the player spawn and from the farthest dog/boss
spawn), a top-down view and a play-height view behind the spawn. Captured with `screen_capture` in edit mode
and returned as one contact sheet PNG, plus the measured mean pixel saturation of the sheet (the render-side
check of finding 1).

### 6. Guidance

`src/agentGuide.ts` / `AGENTS.md` and `skills/blox/ui`, plus a new `skills/blox/map`:

- UI: install BloxUI and use its components; copy the reference layout; no decoration that the reference
  doesn't have; preview in edit mode, then lint in edit mode, then one Play lint at the end.
- Map: install BloxMap, build with its blocks and palette, apply the `bright` lighting, run `map check` and
  `map shots` after each building pass, and compare the sheet with the references.
- Icons: `image generate` (Qwen) → `asset sheet` → `asset upload`; no emoji.

## Proof: the re-run

Arm `c` = the new blox, in `~/bakeoff/c` with a fresh `BakeoffC.rbxl`, launched through the existing
`~/bakeoff/run-arm.sh` with the same briefs, references and naming contract. The same judge (`judge.py` +
`make_sheets.py`, with `c` added) captures both B (old) and C (new). The blind sheet labels them X and Y by a
coin flip. The user picks; only then is the key revealed. Results go in
`bench/results/ui-map-refine-2026-10-07.md` with cost, turns and time.

## Error handling

- Every Studio-staged thing (preview frames, shot cameras) is removed in a `finally`, including on errors.
- Kaggle: a missing CLI, token, setup, or quota error is a clear message with the next step; the tool falls
  back to Cloudflare only when asked or on quota/timeout, and says so.
- `map check` on a place with no map root returns a clear error, not empty results.

## Testing

TDD per piece with vitest: pure evaluation (lint rules, map report evaluation, palette saturation, triangle
estimate, kernel folder generation, background flood-fill, contact sheet composition) is unit tested; Studio
calls use the existing fake session pattern. Each piece is live-smoked once in a scratch place (`BakeoffC` or
`~/blox-playground`), and `npx tsc --noEmit` plus the full suite run before each merge.

## Out of scope

The spec-first UI path (A's `Spec.luau` → preview → UI) is **not** built: the user preferred B's simpler
layout, and the edit-mode preview covers the need. Hunyuan3D, VFX and multiplayer are out of scope.
