# Handoff prompt — 2026-10-06 (Volcano: real UI kit + Blender art pass)

Paste the block below into a fresh Claude Code session started in `~/blox` (after `/clear`).

```
Continue blox work ("Claude Code for Roblox"). State as of 2026-10-06, blox main after PR #113.

The first real game is built and passes every machine release gate. It does not look good enough yet. This session is a UI + art quality pass. You work in two places: the game and the blox repo.

THE GAME: ~/blox-game1, "+1 Jump Every Second: Escape the Volcano". Git log: 0718f2b M5.
- Loop: jump grows +1 every second. Climb 8 volcano stages above lava. Each checkpoint pays wins. Wins buy training, jump boosts and Lava Pup pets. The summit is an "escape" (+1,500 wins, then +400 per repeat). Rebirth gives ×1.5 jump.
- Studio place: test.rbxl, studio_id from list_roblox_studios. The user has NOT yet saved it as a file. Terrain and world builders exist only in the place; adopted packs are also in assets/packs/*.rbxm, which sync restores.
- Read first: reports/SUMMARY.md, reports/M1.md–M5.md, .blox/design.json, .blox/presentation.json.
- Key code:
  - src/StarterPlayerScripts/VolcanoHud.client.luau (HUD on the adopted "Cartoony GUIs" pack, ReplicatedStorage.cartoonGui)
  - src/StarterPlayerScripts/Pets.client.luau (code-built pups)
  - src/ServerScriptService/Services/{VolcanoService,MonetizationService,LeaderboardService}.luau
  - world/Volcano.luau (pillars, tuned cliffs), world/VolcanoArt.luau (terrain, lighting, rocks)
- Gates: tests 43/43, multiplayer 7/7, FTUE 4/4, soak 3/3, ui lint clean, present lint 21/21, release check READY.

SCREENSHOTS (current look; all under ~/blox-game1/reports/):
- HUD and menus: m2-hud.jpg, m2-shop.jpg, m2-settings.jpg, m4-cue.jpg (stage-reach cue and toasts)
- World: m1-stage3.jpg, m1-volcano-edit.jpg, m3-spawn.jpg, m3-stage5-pet.jpg, m3-wide.jpg
- Store drafts: action.jpg, explore.jpg, hero.jpg, reward.jpg, social.jpg, icon.png
UI references from top games: ~/blox-uirefs/curated/*.jpg and README.md (conventions).

USER FEEDBACK (2026-10-05). These are requirements:
1. "The UI seems quite crude and basic." I only scouted Creator Store and DevForum, adopted one DevForum pack (Cartoony GUIs, 9362490121) for the panels, and hand-built the top pills, progress bar and rail icons. I never searched BuiltByBit, itch.io or Kenney.
2. NO EMOJIS anywhere in the UI. Current emoji uses:
   - VolcanoHud.client.luau: WINS_ICON (line 24), shop card icons (210-214), rebirth toast (287), rail icons (322-325), jump pill (545), stage-reach toast and bar text (572-579), prices (604)
   - LeaderboardService.luau:64
   - Config/Monetization.luau icons
   - world/Volcano.luau:107 (board title)
   - Also check the store description in .blox/presentation.json.
   Replace them with real icon images: an icon pack packed into one sheet with `asset sheet`, uploaded.
3. Design 3D assets in BLENDER, not code-built balls and boxes. Windows Blender 5.2 should be running already, with the blender-lab MCP bridge on 127.0.0.1:9876. If it isn't, launch it with:
   powershell.exe -NoProfile -Command "Start-Process -FilePath 'D:\Program Files\Blender Foundation\Blender 5.2\blender-launcher.exe'"
   Check the bridge with mcp__blender-lab__get_objects_summary.

PLAN:
A. UI kit research (whole web, research-before-building):
   - Search builtbybit.com/resources/roblox/graphics-ui, itch.io (rblx-essentials.itch.io, beanystudios.itch.io/robloxsimulatorgui, the itch.io/game-assets/tag-roblox tag), DevForum UI-pack threads, and Kenney UI and icon packs.
   - Free only, with a clear licence. Compare against ~/blox-uirefs. Pick a cohesive simulator-style kit plus an icon set.
   - If a pack is browser-only: blox import can't download itch.io files without a browser. Note the gap, then try a DevForum or Store id, or a Kenney direct zip (Kenney is CC0).
   - scout try → preview → adopt → rebuild the HUD (currency pills with icon images, rail, progress bar, toasts, panels) from the kit's art. Run ui lint on all devices; it must stay clean.
B. Blender assets, via the blox model pipeline (`node dist/cli.js model brief|run|check|export|preview|import`) and the blender-lab MCP:
   - a Lava Pup pet (low-poly, stylized, rigged: idle and walk), to replace Pets.client.luau's balls
   - volcanic rock and crystal props, checkpoint flags/pads, an escape-portal arch, maybe stylized pillar caps
   - Each asset: check views against references → export → `asset upload` (authorized) → import → wire.
   - Keep the tuned cliff faces: pillar parts stay frictionless with exact heights, and tests/volcano_world.spec.luau guards the climb column. Rerun tests/playtests/climb-at-threshold.json after any world change (`node dist/cli.js tool playtest "$(cat tests/playtests/climb-at-threshold.json)"`; all 8 stages must report onPad, stage 8 escapes to spawn).
C. Re-render the store shots (present render) with the stage signs hidden in close shots. Update reports with before/after screenshots and a new reports/M6-art.md. Ask the user to judge it ("is it fun" and art sign-off are human gates).
D. Log every blox friction you hit and fix it in blox: branch → PR → squash-merge yourself.

STILL HUMAN: is it fun; saving the place file; group creator id; pass/product ids and prices; final title and art; Studio API access (saving, global board); release approve and publish.

Rules:
- Read memory first: MEMORY.md index, then ui-quality-no-emoji-blender, first-real-game, scout-search-whole-web, research-before-building, tool-is-for-claude, blender-wslg-launch, clone-repos-authorized.
- Branch → PR → squash-merge yourself in the blox repo.
- In the blox repo, run `npx tsc --noEmit` and `npx vitest run` before claiming green.
- Run the repo CLI as `node ~/blox/dist/cli.js` after `npm run build`; the `blox` on PATH is stale. Run game commands from ~/blox-game1.
- Use the subscription only (no ANTHROPIC_API_KEY). No Robux spend, no publishing.
- The auto-mode classifier blocked two things last time: deleting user instances in Studio via execute_luau, and launching the `blox "<prompt>" --auto` runner. Build directly with the CLI tools.
- Gotchas:
  - KitApi getState returns a copy across the Bindable; change state through the APIs.
  - Humanoid:Move/.Jump from client luau is overwritten by the PlayerModule; use keyboard playtest inputs.
  - A child named "Name" is shadowed by the Name property; use FindFirstChild("Name").
```
