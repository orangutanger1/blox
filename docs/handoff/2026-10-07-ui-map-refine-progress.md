# Handoff 2026-10-07: UI/map refine, in progress

Continues `docs/handoff/2026-10-08-ui-map-refine.md` (the goal and rules). Spec:
`docs/superpowers/specs/2026-10-07-ui-map-refine-design.md`. Plans: `docs/superpowers/plans/2026-10-07-p{1..5}-*.md`.

## Done (merged to main)
- #132 spec. #133 play-lock fail-fast (`src/studio/host.ts`: LogonUI probe, un-minimise Studio; `BLOX_HOST_PROBES=0` in tests).
- #134 BloxUI depth stack (Shadow → Face → Lift, no pills; Tile, Panel with drawn X, Dialog, Tabs).
- #135 edit-mode `ui preview` / `ui lint {mode:"edit"}` (mount chunk with `host`, states, contact sheets); rules off-centre,
  touching, pill; BloxUI windows in design px + `BloxUI.fit` (min 0.72 → 62 px design buttons = 44 px).

## Merged this session
- #136 `blox image` (Qwen/FLUX). #137 map component (live-smoked on BakeoffA: check 9/9, shots sat 0.56, install).
- #138 `skills/blox/map/map-building` + guide map/icon lines (guide 5994/6000).
- Arm c set up: `~/bakeoff/c` (blox new + setup claude + CLAUDE.md/arm.mcp.json), `BakeoffC.rbxl` (copy of the
  736-byte fresh place) open beside A and B (B holds old-blox work unsaved: keep it open for judging);
  `run-arm.sh` has arm c. Map run started 2026-10-07 21:21, logs `~/bakeoff/logs/c-map.*`.

## (Old) On branches, not merged yet
- `feat/image-generate` (commit 7b8bda6, plus an uncommitted `'image'` in `src/args.ts` TOOL_COMMANDS in the
  worktree at `<scratchpad>/wt-image`; copy that one-line change if the worktree is gone). `blox image generate|setup|status`.
  **Live-verified:** weights kernel `ricemaster/blox-qwen21-weights` COMPLETE; a 4-icon Qwen batch
  (`ricemaster/blox-image-batch`) gave clean transparent icons (pistol, cash, shield, white bone) in ~20 min wall time.
  To finish: commit args.ts, full suite, PR, merge.
- `feat/map` (WIP commit c8cc3bf): BloxMap kit (Palette, Lighting "bright", Build), `map check` (port of the judge's
  map_metrics with two-pass grid, overlaps, interiors, lighting-aware saturation, SceneAnalysisService triangles),
  `map shots` (8 views → sheet + rendered saturation), `map:<id>` criteria, release `map` gate, config `map`.
  1464 tests pass, tsc clean. Live-checked on BakeoffA/B: matches the judge (B play area 316×276, 23,420 reachable,
  covered 990). To finish: live smoke of the `map` tool through the CLI, PR, merge (it will conflict lightly with
  `feat/image-generate` in registry.ts, cliTools.ts, args.ts, config.ts, release/check.ts, mcp.server.test.ts).

## Findings worth keeping
- The vibrancy gap was lighting: A/B part saturation equal (0.52/0.54); B had Atmosphere Haze 0.8 and no colour
  correction. Rendered shot saturation: A 0.56, B 0.36.
- The judge's 226k triangles for B = 132k shadow pass + 93k opaque at its camera/quality. Edit and play measure the
  same at the same camera (~3k); B's top view is 12k vs A's 6k. A turned CastShadow off on 435/672 parts.
- Lune quirks: `ColorSequence.new(a, b)` repeats `a` (use keypoints); harness now returns real services (Lighting)
  when no project folder exists.

## Next
1. Finish/merge both branches (above). 2. Piece 6 guidance: `skills/blox/map` + map lines in `src/agentGuide.ts`
   (≤ 6000 chars; the guide test checks rule phrases). 3. Re-run: arm `c` = new blox in `~/bakeoff/c`, fresh
   `BakeoffC.rbxl`, via `~/bakeoff/run-arm.sh` (add arm c), same briefs; judge B vs C with `judge.py` + `make_sheets.py`;
   blind X/Y coin flip; show the user; wait for the pick. Report in `bench/results/ui-map-refine-2026-10-07.md`.

Rules: scratch places only (BakeoffA/B/C, `~/bakeoff/smoke` → BakeoffA), never DogAttack.rbxl; no multiplayer;
commits end with `Claude-Session: https://claude.ai/code/session_014pdBRy4dKQEEDyASXvzMRr`.

## Arm c status (2026-10-07 ~22:00)
- c map: done. 67 turns, $3.04, 11.6 min (B: 67 turns, $3.83, 14.7 min). 9/9 map checks, 12 tests.
- c ui: done but last test run unverified: 121 turns, $6.99, 33 min (B: 204 turns over a usage-limit resume,
  $12.5–21, ~2.4 h). Play stopped entering mid-run: **Windows screen-time limit** ("Give more time?" overlay;
  not LogonUI, LockApp stays suspended, overlay window not enumerable). Do not bypass; wait for the user.
- Judge: `judge.py` takes arm c and `JUDGE_RUN=r2` (out/<arm>-r2); `make_sheets.py` takes `PAIR=b-r2,c-r2 SHEETS=r2`
  (key in out/r2/blind.json). Next once unlocked: run c's tests (`node ~/blox/dist/cli.js test` in ~/bakeoff/c),
  then `JUDGE_RUN=r2 judge.py b all`, same for c, then sheets, show the user blind.
- blox idea: add "or a screen-time limit" to the Play-failed hint in src/studio (no reliable probe found).

## Result (2026-10-07 ~23:00)
User picked Y = new blox (C) blind for both map and UI. Report: `bench/results/ui-map-refine-2026-10-07.md`.
Remaining: blox fix for the stuck `Start play hasn't finished yet` reply (src/studio/play.ts startPlay), then
Dog Attack Plan 5 maps.
