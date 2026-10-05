# Handoff — Volcano UI/art pass, part 2 (2026-10-05 evening)

Game: `~/blox-game1` ("+1 Jump Every Second: Escape the Volcano"), game git `946eaf3`.
blox: main after PR #117. Studio place `test.rbxl` (still not saved to a file — human gate).

## Done this session

### UI (user feedback 1 + 2: crude UI, no emoji)
- Researched whole web. Free candidates: zxgly "FREE Cartoony Roblox UI Pack" (.rbxm) + "Vector Icon Pack" (itch, commercial OK),
  classicdivines gamepass icons (itch + Google Drive), DevForum cartoon packs (mediafire/Drive links), Kenney UI pack (CC0 direct zip).
  BuiltByBit pages return 403 to WebFetch. Store scout results were junk.
- **Blocked:** scripted itch.io download (CSRF + `/file/<upload_id>` POST) was denied by the auto-mode classifier
  ("Exfil Scouting"). Not retried. itch packs need the user to download in a browser → drop into `~/blox-game1/assets/incoming/`.
- Chose instead: **Blender-rendered 3D icons** (Pet Sim 99 / Adopt Me style), licence-clean (owned).
  15 icons in `art/icons/*.py` → `model icon` → `asset sheet hud-icons` (cell 160) → uploaded, image `129074242987399`.
  Icons: bolt cart crown dumbbell flag flame gear gem jump lock pup rebirth star trophy volcano.
- HUD rebuilt (`src/StarterPlayerScripts/VolcanoHud.client.luau`): left-middle currency chips with overflowing 3D icons,
  2×2 coloured icon-tile menu rail, thick gradient next-stage bar (volcano → flag/star/trophy icon), lava-gradient climb rail
  with dot ticks, icon toasts with pop tween, sheet icons on shop cards / prices / locks. Pack (Cartoony GUIs) panels kept.
  `UI.fit` responsive scale (design 800×560, min 0.57). **Zero emoji** in src/world/tests/store copy (new HUD spec guards it).
- Board title split into crowned title bar + list (LeaderboardService/Volcano.luau/test updated).

### 3D (user feedback 3: Blender)
- Lava Pup pet (`art/models/lavapup.py`): 7 rigid pieces, quadruped rig → asset 89722316776604, Motor6D rig via
  `animate rig joints:"blender"`, anims PupIdle 116240445148813 / PupWalk 80515729896710. Template
  `ReplicatedStorage.PetModels.LavaPup` (saved `assets/packs/lavapup.rbxm`). `Pets.client.luau` clones it, idle/walk by speed (idle verified playing).
- Props (`art/models/{flag,crystals,portal}.py`): CheckpointFlag 82031924374988, LavaCrystals 136495848386914 (Neon crystals),
  EscapeArch 124449986057569; templates in `ReplicatedStorage.WorldProps` (packs saved). Placed by `world/VolcanoArt.luau`
  (flags + crystals on pad front corners, crystal ring at spawn, arch + glowing slab/disc portal fill; EscapePortal is now an invisible trigger).
- Pads: basalt top + orange plastic rim (Neon rims were blinding).

### Store shots
- Re-rendered with `hide:["BillboardGui"]` (stage signs gone) and the Lava Pup as `hero` with yaw. present lint 21/21.

### Gates (last full run, before the final lighting fix)
tests 44/44 · multiplayer 7/7 · ftue 4/4 (`--bot bots/climber.luau --seconds 300`) · ui lint 6/6 clean on 4 devices ·
asset lint 6/6 · climb-at-threshold: stages 1–7 onPad, stage 8 escapes to spawn · release check READY (machine gates).

### blox PRs (all squash-merged)
- #115 `model icon` (Cycles, transparent, cropped, sticker outline) + Blender helpers `shape`/`prism`; sheet re-run keeps upload;
  sheet module luau-lsp fix; `BloxUI.fit` honoured by ui lint probe; guide: icons never emoji.
- #116 `asset relink` for never-placed entries; present `hide` list + hero `yaw`.
- #117 `metrics` reruns reuse the mode's last bot/seconds (bare rerun had overwritten a passing FTUE report).

## Issues / open
1. **Pets not seen in the very last screenshot** (after moving them to flank the player at ±4 studs). Verify they render
   (`workspace.LocalPets`) and are in frame; adjust offset.
2. Last lighting fix (idempotent PadLight, template PostEffects disabled) not yet followed by a full gate rerun → rerun
   tests, ui lint, climb playtest, release check. Two Atmospheres still exist in Lighting (template + ours); can't delete
   user instances via execute_luau (classifier) — ask user or set the template one to match.
3. Toasts stack 3+ at bottom-centre and cover the lower screen; consider top-right toasts (Adopt Me) or max 2.
4. Shop card name pills are clipped at the bottom by the pack's scroll layout (pre-existing).
5. Visual coherence is ad hoc: icons, props, pup and the pack panels were each styled on the fly. **No style guide yet.**
6. Default avatar in store shots is the grey/blocky "noob" (no avatar loaded in edit) — human may prefer a custom avatar.
7. reports/M6-art.md not written yet (screenshots ready: reports/m6-*.png|jpg, before = m2-*/m3-*).
8. Friction not yet fixed: `asset upload` needs a manual `"creator"` in .blox/assets.json (could read StudioService:GetUserId);
   `sync` summary reports `~0 updated` even when scripts changed.

## Next — visual direction first (user request 2026-10-05)
The user wants a **clear visual direction before more assets**, then this asset method:
1. Write a style guide `~/blox-game1/art/STYLE.md`: palette (hex), shape language (chunky, rounded, bevelled, low-poly
   faceted rock vs smooth glossy collectibles), outline rules, material/roughness, lighting mood, UI chrome (stroke colour,
   corner radius, gradients), icon framing, scale references. Base it on ~/blox-uirefs and the game's sunset-lava theme.
2. **Generate a style-sheet image** (concept board: pet turnaround, props, palette, icon samples) with an image generator.
   Find what is available without spend: Roblox Studio MCP `generate_texture`/`generate_material`/`generate_mesh`
   (check if any returns a 2D image), vidiq `generate_thumbnail`, Figma MCP for a board, or compose one in Blender.
   Show the board to the user for sign-off (human gate: art direction).
3. Rebuild assets in Blender **from the sheet** (`model brief --refs <sheet crops>` so `model check` compares views to it):
   re-skin the pup, props, icons to the agreed palette; add missing ones (stylized pillar caps, pad trims, rocks).
4. Then M6-art.md with before/after, rerun every gate, ask the user: is it fun + art sign-off.
5. Fix friction from item 8 (branch → PR → squash-merge).

## Commands
- blox CLI: `node ~/blox/dist/cli.js` (run `npm run build` in ~/blox first). Run game commands from ~/blox-game1.
- Icon: `model brief icon-x --prompt … ; model run icon-x art/icons/x.py ; model icon icon-x --out assets/ui/icons/x.png`
  then `asset sheet hud-icons assets/ui/icons --licence owned --cell 160` → approve → upload.
- Model: `model run|check|export|import <id>` → `asset approve` → `asset upload --confirm` → insert_asset (Color white) →
  `asset relink <id> <path>` → `asset save <id>`.
- FTUE: `metrics ftue --bot bots/climber.luau --seconds 300`.
- Climb: `node ~/blox/dist/cli.js tool playtest "$(cat tests/playtests/climb-at-threshold.json)"`.
