# Model rigs + NPC loader (animate spec B)

Status: approved design (brainstorm 2026-10-02). Follows spec A
(`2026-10-02-r15-character-animation-design.md`, PR #74), which shipped R15/R6
player-character animation. Spec C (joining loose pieces into a rig: Roqer's
`rig-build`, range sheet) is out of scope.

## Goal

blox's agent can animate things other than the player's character:

1. **NPCs.** "Add a guard who patrols" ends with an NPC whose idle / walk / run
   play by how fast it moves, feet keeping pace, proven in a playtest.
2. **A model's own rig.** "Make my dog wag its tail" animates a Part-built
   model's Motor6D / AnimationConstraint rig through the same
   check → build → (human approves) → upload → wire → verify flow as spec A.

Success: both flows run end to end live in `~/blox-fw` (upload excepted: it
stays behind the human-only `blox asset approve`).

## Constraints (carried from spec A and the repo)

- Reuse `src/anim` as vendored in #74; new Roqer files are vendored the same
  way (only `node:` prefixes / import paths change) and recorded in `VENDOR.md`.
- Agent data reaches Luau only as a payload: `longString(JSON)` decoded with
  HttpService in edit programs; a `jsonToLuau` literal for bridge probes (the
  eval-bridge lint refuses any `HttpService` text). Probes return tables.
- The edit thread cannot create scripts; scripts reach Studio only as
  Rojo-synced project files (`pushProject`).
- Skinned / Bone rigs stay with `model animate` (PR #68): the rig reader skips
  Bones.
- Contact sheets draw MeshParts as their boxes (no mesh reads); the result
  notes it.
- `npx tsc --noEmit` and `npm test` green before any claim.

## Architecture

### Vendored (Roqer 4dcb9a7, `packages/core/src/animation/`)

| File | Role |
|---|---|
| `model-rig.ts` | `rigFromModel(reading)` validates a `ModelRigReading` and returns a `Rig` + notes |
| `rig-declarations.ts` | `declareRig(rig, json)` applies declarations v1; `RIG_ATTRIBUTE` renamed `RoqerRig` → `BloxRig` |
| `body-plans.ts` | `planDeclarations('quadruped' \| 'custom', joints)`, `mergeDeclarations` |

Tests vendored with them: `model-rig`, `rig-declarations`, the body-plan cases,
plus the gait / wave / motion-check tests pruned in #74 for want of the
`parts-dog` / `parts-octopus` fixtures (fixtures vendored to
`tests/fixtures/anim/`). `judgeMovement`'s and other user-facing strings that
say `RoqerModelAnimate` / `RoqerRig` say `BloxModelAnimate` / `BloxRig`.

### New blox units

**`src/anim/modelRig.ts`** — reading a model's rig.
- `READ_RIG_LUAU`: edit program (payload `{path}`), port of Roqer's
  `animatedModel` + `readModelRig` + `copyRefusal` without Bones and meshes.
  Resolves the path by walking `FindFirstChild` from `game`; refuses a path
  outside Workspace / ServerStorage / ReplicatedStorage, anything under
  Players or StarterPlayer, a non-Model, a model with no Humanoid /
  AnimationController, no joints, > 64 joints, > 128 parts, duplicate part
  names among rig parts, a `BloxRig` attribute that is not a string, and a
  model a copy would not reproduce (copyRefusal). Returns the reading minus
  `revision`.
- `rigRevision(reading)`: TS sha256 over the same fields Roqer's
  `rigRevision` uses (welded offsets excluded), prefixed `rr1:`.
- `readRig(ctx, path)` → `{ok, reading, rig, notes} | {ok:false, error}`: runs
  the probe, adds the revision, `rigFromModel`.
- `rigForSequence(projectPath, seq)`: `R15`/`R6` → stock rig; otherwise the rig
  rebuilt from `.blox/anims/<name>/rig.json` (`rigFromModel(saved reading)`).

**`src/anim/npc.ts`** — NPC bodies and the model loader.
- `NPC_LUAU`: edit program, payload `{name, rig, at, parent}`. One
  ChangeHistory recording: `CreateHumanoidModelFromDescription` (default
  description), named `name`, `Animate` LocalScript removed, tagged
  `BloxAnimated`, pivoted so its feet stand at `at`, parented to `parent`
  (default Workspace; must resolve under Workspace). Refuses a name already
  taken under the parent.
- `MODEL_LOADER_PATH = src/ServerScriptService/BloxModelAnimate.server.luau`,
  `MODEL_LOADER_SOURCE`: Roqer's `RoqerModelAnimate` state machine retargeted:
  one server Script animates every model tagged `BloxAnimated`
  (`CollectionService:GetTagged` + `GetInstanceAddedSignal` /
  `GetInstanceRemovedSignal`), reading model attributes `BloxAnim_idle`,
  `BloxAnim_walk`, `BloxAnim_run` (ids) and `BloxAnim_walkSpeed`,
  `BloxAnim_runSpeed` (ground speed), reloading on `AttributeChanged`.
  Humanoid speed from `Running`; AnimationController models' speed measured
  from the PrimaryPart. Cross-fade 0.2 s, standing below 0.5 studs/s, pace
  clamp 0.5–2× (`LOADER_PACE`). First line is a GENERATED header.
- `planModelWire` / model-attribute program `WIRE_MODEL_LUAU` (edit, one
  recording): sets `BloxAnim_<state>` and, for walk/run, `BloxAnim_<state>Speed`;
  adds the tag.
- `.blox/anims/wired.json`: `{ "<model path>": { "<state>": "<id>" } }` — the
  ids blox last wired, for the attribute guard.

**`src/anim/studio.ts`** (extended)
- `buildProgram` / `verifyProgram` take an optional model path. With one,
  PLAY clones the model (after copyRefusal) into the non-archivable
  `__BloxAnimPreview` folder, anchors its root, removes the clone's
  `BloxAnimated` tag (the loader must not drive it), plays on the clone's
  controller Animator and samples joints by Part1 name as today.
- `VERIFY_MODEL_LUAU`: server probe through the bridge. Optional playback of
  the checked animation on the model (as spec A's verify), then an
  observation port of Roqer's `observeModel`: with a Humanoid, `MoveTo` a
  point 12 studs ahead (or `target`), sample every 0.1 s (`phase`, `speed`,
  most-weighted loader track id, its `Speed`), then 10 standing samples;
  returns `{rigType?, loader:{ids, speeds}, length?, samples?, observation?}`.
  The loader's state comes from the model's attributes, so no `.Source` read.

### `animate` tool changes

| Action | Args | Studio | What it does |
|---|---|---|---|
| `rig` | `model` | edit read | rig summary (`describeRig`), notes, checks that cannot run and the declaration that would enable each |
| `declare` | `model`, `plan?` (`quadruped`\|`custom`), `declarations?` | edit read + write | merge plan + given, validate with `declareRig` against the read rig, write `BloxRig` (one recording); nothing written on any error |
| `npc` | `name`, `rig` (`R15`\|`R6`), `at` [x,y,z], `parent?` | edit write + sync | stock NPC body + loader file if absent, then `pushProject` |
| `check` | `rig` may be a model path | edit read (model rigs only) | as spec A; saves `rig.json` (reading + revision) beside the other files |
| `build` | unchanged | edit | model rigs: re-read, refuse if revision ≠ `rig.json` ("rig changed since check; check again"); play on a copy |
| `wire` | `model` + `state` (`idle`\|`walk`\|`run`) instead of `slot` | edit write + sync | see Wiring |
| `verify` | `model`, `name?`, `target?` | playtest server | see Verify |

`animateShape.rig` widens from `enum(['R15','R6'])` to `string`; a value other
than R15/R6 must look like an instance path (`^[A-Za-z_][\w ]*(\.[\w ]+)+$`).

### Wiring a model

`wire {model, state, asset, name, force?}`:
1. `name` is required (the checked animation); it must loop.
2. Rig match: stock-rig animation → the target has a Humanoid whose `RigType`
   equals `seq.rig`; model-rig animation → the target's freshly read revision
   equals `rig.json`'s (so clones of the checked model pass).
3. walk/run need the report's `groundSpeed` (refuse without it: "check it with
   locomotion:true"); `groundSpeed` > `MAX_GROUND_SPEED` is refused.
4. Attribute guard: replace `BloxAnim_<state>` only when it is empty, equal to
   the new id, or equal to `wired.json`'s id for that model/state; otherwise
   refuse naming the held id, `force:true` overrides.
5. Loader file: write if absent; refuse if present and not byte-equal to
   `MODEL_LOADER_SOURCE` (CRLF normalized).
6. Write attributes (one recording), update `wired.json`, `pushProject`.
7. Reply warns when a Humanoid's `WalkSpeed` / ground speed falls outside
   0.5–2× and says what to change.

### Verify a model

`verify {model, name?, target?}` inside `withPlay`, `runLuau(..., 'server')`:
- With `name`: playback compare against the checked motion using
  `verifyLivePlayback(seq, samples, rigForSequence(...))`.
- Movement: Humanoid models walk to `target` (default 12 studs along the
  root's look vector); `judgeMovement(observation, loader)` decides.
  AnimationController models skip movement and say so.
- Writes `.blox/anims/<name or model-slug>/verify.json`.
- Failure text names the fix (wire state X; WalkSpeed outside pace range;
  root anchored; no PrimaryPart).

## Data flow summary

```
rig {model} ──read──▶ reply
declare ──read──▶ merge/validate ──write BloxRig──▶ reply (re-read summary)
check {rig: path} ──read──▶ rig.json + spec/sequence/report/sheet
build ──re-read (revision guard)──▶ play on copy ──▶ compare ──▶ commit + rbxm + candidate
human: blox asset approve → asset upload
npc ──create body + loader file──▶ sync
wire {model,state} ──rig match + guards──▶ attributes + wired.json + loader file ──▶ sync
verify {model} ──playtest server──▶ playback + movement judgement ──▶ verify.json
```

## Errors and guards

- Payload-only Luau; paths resolved in Luau, never interpolated.
- Revisions: `rig.json` (check → build → wire); `BloxAnimRev` (rebuild, spec
  A); loader file exact-content; `wired.json` attribute guard.
- Checks needing missing declarations report `skipped`, never `pass`; build
  does not treat skipped as failing; the check reply names the `declare` call
  that would enable them.
- A model with parts but no joints: "not rigged: rig building is not supported
  yet; rig it in Studio (Rig Builder / RigEdit) or Blender".
- An empty or non-JSON Studio reply → a named error, not a `JSON.parse` throw
  (fixes the spec-A deferred minor for the new paths).

## Testing

- Vendored unit tests (model-rig, rig-declarations, body plans, restored
  gait/wave/motion-check cases).
- Tool tests with a fake session (pattern of `tests/anim.build.test.ts`):
  rig refusal passthrough; check on a model saves `rig.json`; build refuses a
  changed revision; build sends the model path and compares; npc writes the
  loader + syncs; wire rig mismatch / missing groundSpeed / guard refusal /
  force / hand-edited loader; verify pass + pace failure text.
- `rigRevision` stable across key order and moved welded parts.
- Lune compile test over every new program and `MODEL_LOADER_SOURCE`.
- Live smoke (`~/blox-fw`, bridge on): server-probe spike first; a Part-built
  dog (build in Studio, `declare` quadruped, check/build Walk + TailWag); an
  R15 NPC (`npc` → wire idle/walk with temp-uploaded or stock ids → verify
  movement + pace).

## Docs

`skills/blox/animation/character-animation/SKILL.md`: NPC and model-rig
sections, the `BloxRig` format, a DogWalk + TailWag recipe on the
quadruped plan; `agentGuide.ts` one line; `ANIMATE_DESCRIPTION` updated.

## Out of scope

Rig building (spec C), skinned rigs (PR #68), mesh previews, one-shot
(attack) wiring — the skill shows playing those from game code.
