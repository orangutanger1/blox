# Handoff 2026-10-08: refine blox's UI and map components

Paste the prompt at the bottom into a fresh session.

## Why

The quality bake-off (`bench/results/quality-bakeoff-2026-10-07.md`, PR #129) compared blox with the
"article workflow": Claude Code + Studio MCP + robloxstudio-mcp + Rojo/Lune/AI icons. The user judged both
tasks blind, and **blox won both** (the Farm Town map and the ZA shop UI). So blox continues. The user also
said exactly what the losing side did better. This handoff ports those wins into blox's **UI** and **map**
components, so the next Dog Attack work (Plan 5 maps, Plan 5b UI polish) starts from a better tool.

## What the user said (keep these words in mind)

- **Map:** blox's map won on a more cohesive building layout and better use of space, with less empty field.
  The article map had a **more vibrant, saturated palette**, "which may be more appealing to roblox players
  these days (a lot of them are little kids who are used to saturated colors)".
- **UI:** "both aren't great." blox's UI won on layout: "simple yet effective". The article UI's layout was
  confusing: a random angry dog mascot bottom-left, and the cancel button's X looked weird. But its
  **"button style and tile style is good"**. The user wants blox's layout with the article's buttons and
  tiles: "it would be better if ui y's buttons weren't pill shaped and were ui x's".

## Evidence on disk (read before designing)

- **Sheets:** `bench/results/quality-bakeoff-2026-10-07/sheet-*.jpg`. **X = article (A), Y = blox (B).**
- **Arm A's project** (`~/bakeoff/a`, uncommitted but on disk). Port ideas and code from it; it is our own
  generated code.
  - `src/shared/UI/Spec.luau` + `UI_SPEC.md`: one spec → preview + UI + checks. Every panel and button gets
    the depth stack: blue-shifted drop shadow, face gradient, top lift, even outline.
  - `tools/render_preview.py` and `tools/preview.luau`: a preview image of the UI rendered from the spec,
    without Studio.
  - `tools/ui_sweep.luau`: the in-play checker across states and devices. `tests/ui.luau` runs the layout
    rules under Lune: 6 sizes × ~340 states, tap ≥ 44 px, text ≥ 14 px, nothing touching, centring within
    1.5 px.
  - `tools/kaggle_icons/`, `tools/process_icons.py`, `tools/upload_icons.py`: the icon pipeline. FLUX.1-schnell
    runs as a Kaggle GPU batch job, then background removal, then upload through Open Cloud. 25 icons, all of
    which loaded. `assets/icons` holds the results.
  - `src/devtools/MapCheck.luau`: the map movement checker. It builds a raycast nav grid from the real jump
    and speed numbers, adds PathfindingService, and runs the 9 checks (floating parts, unstandable tops,
    unreachable high ground, reachable-but-shouldn't, pockets, sightlines, overlapping parts, uneven rings,
    ragdoll shortfalls).
  - `src/shared/Config/Palette.luau`: the saturated map palette. `src/shared/Map/Builders.luau`: config-driven
    building builders.
  - `TRAPS.md`: gotchas it hit. One example: JumpPower 53.15 actually jumps 8.2 studs because the character
    adds about 0.9 studs on take-off, and 49.72 measured 7.19.
- **Arm B's project** (`~/bakeoff/b`, blox). `world/FarmTown.luau` is the map that won. The UI is
  `src/ReplicatedStorage/BakeoffUI.luau` with icons from `art/mkicons.py`.
  - **blox friction found:** B wrote its own `tools/preview.mjs` + `tools/preview.luau` (a UI preview in
    edit mode) and `tools/editlint.mjs` (UI lint without Play). That means blox lacks an edit-mode UI preview
    and an edit-mode lint.
  - **More friction:** B also lost about 45 minutes because a locked Windows session stops Studio from
    entering Play. blox gave no clear error, and the agent polled.
- **Neutral judge kit:** `bench/results/quality-bakeoff-2026-10-07/`. `map_metrics.luau` is a raycast
  walkability search with an overlap probe for standing volume. `ui_metrics.luau` is the UI checker. `judge.py`
  drives robloxstudio-mcp device presets and captures.
- **Current blox UI pieces:**
  - `kits/_common/files/src/ReplicatedStorage/BloxUI/{init,Theme}.luau` (installed by `blox ui install`;
    the look is flat with pills).
  - `src/ui/{lint,probe,run}.ts` (`blox ui lint`). The probe clones GUIs into device-size frames, so UI
    whose scripts react to runtime size isn't measured truly. robloxstudio-mcp's `set_device_simulator`
    with `deviceId` presets (iphone_14 + orientation, ipad_6th_generation, hd_1080) was more faithful.
  - The ui-packs skill is `skills/blox/ui/`, and `src/assets/preview.ts` has the scout preview.
  - The guide text is `src/agentGuide.ts` → `AGENTS.md`.
- **Current blox map pieces:** there is no map component as such. Maps are `world/*.luau` builders
  (`src/sync/push.ts`) plus `scout --kind map`, and walkability is only per-game pathfinding specs.

## Scope: two components

### A. UI component
1. **Depth-stack look by default** in BloxUI: blue-shifted shadow, face gradient, top lift, even outline.
   Use square-ish rounded rectangles, not pills, for buttons and tiles. Build it as reusable Button / Tile /
   Panel / Dialog / Tabs pieces with ZA-style white text and a dark outline. Keep the colours themeable.
   **Proven win.**
2. **AI icon generation:** `blox image generate` (a tool and CLI). The default model is
   **Qwen-Image-2.1** (7B, top open model, native transparent RGBA output, up to 2048²), which the user chose
   over FLUX. Arm A used FLUX.1-schnell only because A picked it.
   - **How it runs:** as a Kaggle batch job built on the user's chosen notebook
     <https://www.kaggle.com/code/tamadaresearch/qwen-image-2-1-t4-x2-bring-your-own-weights> (T4 ×2,
     int8 weights, attention "int8").
   - **One-time setup.** The notebook includes no weights. Pull the three files from the pinned Comfy-Org
     copy (<https://huggingface.co/Comfy-Org/Qwen-Image-2.1/tree/ace0edeb3791a594ddfa36ed5f41a178a394e921>):
     `qwen_image_2.1_int8_convrot.safetensors` (7.3 GB), `qwen3vl_8b_int8_convrot.safetensors` (9.4 GB) and
     `qwen_image_2.1_vae_bf16.safetensors` (0.7 GB). Make them a private Kaggle dataset under the user's
     account, then attach that and the runtime dataset `tamadaresearch/qwen-image21-t4-runtime` (GPL-3.0
     launcher, sha-pinned in the notebook).
   - **Per batch.** Copy the notebook (`kaggle kernels pull … -m`), change it to loop over a list of
     prompts and seeds from a JSON input, and ask for transparent RGBA if the runtime exposes it (check;
     otherwise keep background removal). Then `kaggle kernels push`, poll `kaggle kernels status`, and run
     `kaggle kernels output`. Use `~/.local/bin/kaggle` (2.2.4; the miniforge `kaggle` is too old), with the
     token in `~/.kaggle/access_token`. Kaggle GPU time has a weekly quota, so batch many icons per job.
   - **Fallback:** Cloudflare Workers AI flux-1-schnell when Kaggle is down or the quota runs out. Use the
     OAuth token from `~/.wrangler/config/default.toml` and never print it.
   - **After generation:** apply a consistent style prompt → `asset sheet` → upload. The output feeds
     BloxUI icons. Keep the model a pluggable backend (memory `model-agnostic-design`).
   - **Licence:** Qwen-Image-2.1's weights are under the Qwen Research License, which is non-commercial
     only. The user confirmed (2026-10-07) that Dog Attack is personal, non-commercial use. Record the model
     and licence in each icon's asset provenance, and flag it in `release check` if the game is ever
     monetized.
3. **Edit-mode UI preview and lint.** B had to write its own. Render a ScreenGui at a device size without
   Play, and lint it there. Use the device simulator (presets) where it is available, so runtime-sized UI is
   measured truly. Return contact sheets the agent can look at.
4. **Spec-first optional path:** one spec → preview image + UI + checks, taken from A's
   `Spec.luau`/`render_preview.py`. Only do this if it stays simple. The user preferred B's simpler layout,
   so don't over-engineer.
5. **Guidance:** no decoration that isn't in the references (A's dog was marked down), and copy reference
   layouts. Lint should cover the 1.5 px centring check and "touching" (gap < 2 px).

### B. Map component
1. **`blox map check`:** port A's MapCheck and the judge's `map_metrics.luau` into one tool. It reports
   reachability from the spawns, spawn → spawn reachability (dog spawns, boss), pockets with no way back,
   reachable roofs and high ground, covered-but-reachable areas (are they allowed interiors?), floating
   parts, overlapping parts, the leak outside the boundary, a sightline summary, and the triangle and
   draw-call budget. Use the real jump and speed numbers from the game config, with a measured jump (see
   A's TRAPS: take-off adds about 0.9 studs). Bind it to tests the way metrics are (`map:<check>`).
2. **Saturated palette by default** for maps (the user's point about kids), as a Theme/Palette for world
   builders, with guidance. Measure it: a palette check, or at least a saturation report in the check above.
3. **Map building blocks:** reusable world-builder helpers for buildings with real door and window openings,
   enterable ground floors and solid upper floors, roofs (gable and flat), walls with an invisible boundary,
   roads with kerbs, and props. Base them on what B's `world/FarmTown.luau` and A's `Builders.luau` did well.
   The goal is that the next map (Plan 5) takes fewer turns and comes out cohesive.
4. **Map shots:** a standard set of cameras framed on the reachable area (4 high corner views, 2 eye-level
   views, a top-down view and a play view), as one call that returns a contact sheet. The agent compares it
   with the references.
5. **Triangle budget:** B's map drew 226k triangles to A's 6k. Add a budget to `map check` and the release
   gates.

### Also fix (friction)
- **Play blocked by a locked PC:** detect it (LogonUI running, or Play never starts) and fail fast with a
  clear message instead of letting the agent poll.

## How to work

- Follow the blox repo conventions: branch → PR → squash-merge (memory `always-merge-after-pr`), TDD,
  `npx tsc --noEmit` before claiming green, and the full test suite.
- **Live-smoke in a scratch place only** (e.g. `~/blox-playground`, or reuse `BakeoffB.rbxl`). Never touch
  `DogAttack.rbxl`. Restore the Studio window if it is minimised. No multiplayer while the user may be
  playing.
- Uploads and approvals are authorized. Never create, price or publish passes, products or places.
- **Prove the quality gain, not just the feature.** Re-run the bake-off's B tasks with the improved blox:
  the map task and the UI task, using the same briefs in `bench/results/quality-bakeoff-2026-10-07/` and the
  same judge (`judge.py` + `make_sheets.py`). Build a blind sheet of **old B vs new B** and show it to the
  user. Wait for their pick before claiming success.
- Report cost, turns and time beside quality. Write `bench/results/ui-map-refine-<date>.md`.
- Running child `claude -p` arm sessions needs the user's allow rule:
  `Bash(/home/myen/bakeoff/run-arm.sh:*)` is already in `~/.claude/settings.json`. Reuse that script (add an
  arm, e.g. `c` = new blox in `~/bakeoff/c`) rather than inventing new launchers.

---

## Prompt for the fresh session

```
Read ~/blox/docs/handoff/2026-10-08-ui-map-refine.md and follow it. Goal: optimize and refine blox's UI
component and map component, using what the blind quality bake-off (PR #129,
bench/results/quality-bakeoff-2026-10-07.md) showed: keep blox's layout strengths, and port the article
workflow's wins. UI: depth-stack buttons/tiles (no pills, no unrequested decoration), AI icon generation
(Qwen-Image-2.1 as a Kaggle T4x2 batch job via the tamadaresearch notebook, Cloudflare FLUX fallback),
edit-mode UI preview and lint. Map: `blox map check` (walkability
with real jump numbers, pockets, roofs, floating/overlapping parts, boundary leaks, triangle budget), a
saturated kid-friendly palette by default, reusable building blocks, standard map shots. Also fail fast when
a locked PC blocks Play. Brainstorm → spec → plan → implement with TDD, PR + merge each piece in ~/blox.
Then re-run the bake-off's map and UI tasks with the new blox and show me a blind sheet of old blox vs new
blox; wait for my pick. Scratch places only; never touch DogAttack.rbxl. Uploads authorized; never create,
price or publish passes/products/places. No multiplayer while I may be playing. Restore the Studio window
yourself if minimised. Commit messages end with Claude-Session: https://claude.ai/code/session_014pdBRy4dKQEEDyASXvzMRr
```
