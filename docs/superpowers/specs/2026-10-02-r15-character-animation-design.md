# R15/R6 character animation (spec A)

Date: 2026-10-02
Status: design approved in chat; awaiting written-spec review

## Goal

An agent goes from a plain-words request ("make a sneaky walk for the steal
kit") to a player-character animation that passes motion checks, is built and
verified in Studio, waits for human approval to upload, and is wired into every
player's `Animate` script — with a test at each step.

This is spec A of two. Spec B (later) animates Part + Motor6D model rigs
(NPCs, creatures) on the same compiler and checks.

## Background

- PR #68 (`model animate`) handles skinned Bone rigs authored in Blender. It
  stays as is.
- Roqer (github.com/S4US/Roqer, owner granted reuse; AGPL noted, user chose to
  proceed) has a pure-TypeScript animation core: R15/R6 rig descriptions, a pose
  compiler (rotations, limb `aim`/`bend`, `aimAt` IK, planted feet, easing,
  markers), gait/wave generators, seven motion checks calibrated so Roblox's own
  R15 animations pass, and a software-rendered contact sheet.
- blox already has: edit-mode `execute_luau` KeyframeSequence build + Animator
  `StepAnimations` verification (#68), `CreateHumanoidModelFromDescription` in
  edit mode (present pipeline), `.rbxm` → Open Cloud Animation upload behind
  `asset approve` (#67/#68), the eval bridge for play probes (#69), the sync
  revision guard pattern (#70), and the `skill` tool (#72).

## Approach

Port Roqer's core; adapt the Studio, wiring and verification halves to blox's
existing pipeline. (Rejected: a minimal home-grown compiler — no IK, gait or
foot checks, so walks/runs come out wrong unnoticed; Blender authoring — poor
fit for describing motion, no checks or recipes.)

## Components

### `src/anim/` — vendored core

Ported from `packages/core/src/animation/`:

| File | Role |
|---|---|
| `rig.ts`, `r15-rig.ts`, `r6-rig.ts`, `rigs.ts` | joint/part/limb descriptions of the stock rigs |
| `motion.ts`, `easing.ts`, `limb-reach.ts` | frames, tracks, sampling, two-bone reach |
| `gait.ts`, `wave.ts`, `generators.ts` | gait and wave generators expanded into keyframes |
| `pose-compiler.ts` | description → `KeyframeSequenceDescription` |
| `motion-checks.ts` | jointLimits, velocity, rootDrift, loopContinuity, groundContact, footSliding, gaitSymmetry |
| `contact-sheet.ts` + PNG encoder | multi-moment rig render, pure TS |

Not ported in spec A: `model-rig`, `rig-declarations`, `body-plans`, `box-rig`,
`rig-build`, `rig-glb`, `skin`, mesh files (spec B), and prop/grip handling.

Imports change to blox ESM `.js` paths; the vendored files keep Roqer's code
style. `src/anim/VENDOR.md` records source repo, commit, permission and licence
note, and the list of local changes.

### `src/anim/tool.ts` — blox glue

Adapted from Roqer's `animation-tool.ts`: `prepareAnimation` (validate, compile,
check, apply waivers), compact check reporting, playback tolerance
(1.5°, 0.05 studs), the Studio build/verify Luau and payloads, and the wire file
generator.

### `animate` tool (registry)

Separate from `model` (which stays the skinned Blender path).

| Action | Args | Does |
|---|---|---|
| `recipes` | `name?` | lists tested recipes / returns one |
| `check` | `animation, locomotion?, grounded?, waive?` | compile + 7 checks offline; writes `.blox/anims/<name>/{spec,report}.json` + `sheet.png`; returns checks and the sheet image |
| `build` | `name, force?` | Studio edit-mode build + playback verification; writes `ServerStorage.BloxAnimations.<name>`, `anim_<name>.rbxm`, assets.json animation candidate |
| `wire` | `slot, asset, replaces?` | writes the fixed loader + generated slot table, then syncs |
| `verify` | `name, slot?` | playtest probe: plays on the player's character, compares with the checked motion, confirms the Animate slot |

Slots: idle, walk, run, jump, fall, climb, swim, swimidle, sit.

### Recipes skill

`skills/blox-animation/` (served by the `skill` tool) holds the tested recipes
ported from Roqer's `character-animation.md`: R15 wave, idle, walk, run, jump;
R6 walk, wave. (Roqer's slash and lunge recipes need weapon props, which are out
of scope here.) The agent guide gets one line pointing at the
`animate` loop and this skill.

## Data flow

1. `animate recipes` → start from a recipe.
2. `animate check` → compile + checks + contact sheet (offline). Fix or waive
   intended failures (e.g. groundContact on a jump).
3. `animate build` → one edit-mode `execute_luau` (creates no scripts):
   - stock dummy via `Players:CreateHumanoidModelFromDescription` in a
     non-archivable temp folder;
   - build the KeyframeSequence from the JSON payload, load on the dummy's
     Animator, `StepAnimations` to sample times, compare each joint's
     `Transform` with the compiled prediction within tolerance;
   - only on a match: write `ServerStorage.BloxAnimations.<name>` in one undo
     recording, stamped with a checksum attribute; destroy the dummy always;
   - TS exports `anim_<name>.rbxm` (as #68) and records an `animation`
     candidate in `.blox/assets.json`.
4. Human: `blox asset approve <id>`; agent: `asset upload` (existing path;
   `.rbxm` uploads as assetType Animation).
5. `animate wire` → file-based:
   - `src/ServerScriptService/BloxCharacterAnimate.server.luau`: fixed loader,
     written if missing, never rewritten; on each character it sets
     `Animate.<slot>` Animation ids from the slot table;
   - `src/ReplicatedStorage/BloxAnimSlots.luau`: generated `{slot = id}` table;
   - then `sync`.
6. `animate verify` → playtest client probe via the eval bridge (fallback:
   multi_edit injection as tests/metrics use) reads `Animate.<slot>`, plays the
   animation on the character, samples joints, compares; writes
   `.blox/anims/<name>/verify.json`.

Rig handling: `check`/`build` use the animation's `rig`. `wire` reads
`StarterPlayer.GameSettingsAvatar` (readability from edit-mode Luau to be
confirmed in the first live check; if it cannot be read, `wire` takes a required
`rig` argument instead): refuses a mismatched rig; on `PlayerChoice` warns the
animation plays on one rig only.

## Errors and guardrails

- Compile errors: all reported at once with paths (max 20), returned as a tool
  error.
- Failed checks name joint, time, measured value and limit. `build` refuses
  while any check fails unwaived; waivers are recorded in `report.json`.
- Playback mismatch: nothing written; the worst joints are listed with degree
  and stud error.
- Rebuild guard: a `BloxAnimations.<name>` whose checksum no longer matches
  (hand-edited) or that blox did not build is refused without `force`.
- `wire`: replacing a slot that holds an id needs `replaces: <current id>`; a
  hand-edited loader (content differs from the fixed source) is left alone and
  reported.
- Ownership: animations play only for the uploading user/group; `verify` says
  so when the place owner differs from the uploader.
- No new network path: upload stays `asset upload` behind `asset approve`.
- Studio Luau is fixed code; agent data reaches it only as a JSON payload. The
  verify probe is fixed code, so the eval-bridge deny lint passes.
- `wire` writes only its two fixed files, inside the project.

## Files on disk

`.blox/anims/<name>/`: `spec.json`, `report.json`, `sheet.png`,
`anim_<name>.rbxm`, `verify.json`.

## Testing

Offline (vitest):
- Ported Roqer suites: pose-compiler, motion-checks (including the calibration
  that Roblox's R15 animations pass), gait, wave, recipes (every recipe compiles
  and passes all checks).
- New: `animate` arg validation and file outputs; sheet PNG written and returned
  as an image; build payload is JSON data only; `wire` generated files,
  `replaces` rule, hand-edited loader refusal, rig mismatch refusal; assets.json
  animation candidate.
- `npx tsc --noEmit` clean.

Live (Studio, `~/blox-fw`):
1. R15 walk recipe: check → build; playback matches; sequence written.
2. R6 wave: same.
3. Broken description (knee bent backwards): check fails, build refuses.
4. Hand-edit the built sequence: rebuild refuses without `force`.
5. `wire` the walk slot with Roblox's default walk id + playtest `verify`
   (no upload needed): loader and slot readback proven.
6. Optional, only with the user's approval: `asset approve` → upload → full
   `verify` on the uploaded animation.

## Done when

The "sneaky walk for the steal kit" request runs end to end: checked, built and
verified in Studio, pending human approval, wired — each step covered by a test.

## Out of scope (spec A)

Part + Motor6D model rigs, NPC loaders, creatures (spec B); props/grips and
the slash/lunge recipes that use them; 3D
in-chat preview; dedicated marker tests (markers compile but are not separately
tested).

## Size

~4.5k ported lines, ~600 new TS + Luau, ~400 lines of tests; one PR.
