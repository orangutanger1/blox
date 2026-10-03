# Rig building (animate spec C)

Status: approved design (brainstorm 2026-10-02). Follows spec A (PR #74,
R15/R6 player animation) and spec B (PRs #75/#76, Part+Motor6D model rigs and
the NPC loader). Spec B refuses a model with parts but no joints ("not rigged:
rig building is not supported yet"); spec C removes that refusal.

## Goal

blox's agent can turn loose pieces into an animatable rig:

1. **Part-built bodies.** "Build a blocky dog from Parts and make it walk"
   ends with the agent's parts joined by Motor6Ds at sensible pivots, a
   controller, BloxRig declarations, and a range sheet image proving the
   pivots — then spec B's check → build → wire → verify flow animates it.
2. **Blender rigid-piece creatures.** A creature modelled with `blox model`
   as separate pieces under an armature is exported as a pieces-only GLB plus
   its pivots; after upload and insert, the rig is built from those pivots
   with no hand work.

blox suggests joints (tree + pivots) from the pieces' geometry; the agent
reviews or edits them, then builds. Bad pivots show on the range sheet.

Success: live smokes A (Part dog) and C (rebuild) pass in `~/blox-fw`; smoke
B (Blender creature) passes or is blocked only on the human upload approval.

## Constraints (carried from specs A/B and the repo)

- Vendor Roqer files whole (only import paths / `node:` prefixes / Roqer→blox
  names change), recorded in `src/anim/VENDOR.md`. Source: S4US/Roqer commit
  4dcb9a7, reused with the owner's permission (AGPL; owner of blox chose to
  proceed).
- Agent data reaches edit-thread Luau only as a payload: `longString(JSON)`
  decoded with HttpService, as spec B's edit programs do.
- The MCP edit thread cannot create scripts; nothing here needs scripts (the
  NPC loader from spec B is already a synced project file).
- Deterministic checks gate; the range sheet is evidence for the agent/human,
  not a pass/fail check.
- Tool contract stays model-agnostic: everything is reachable over MCP and
  CLI through the existing `animate` tool.

## Scope

In: Part-built bodies; Blender rigid-piece uploads; rebuilding a rig blox
built; the range sheet; the joint suggester.

Out: skinned meshes (bones already present — PR #68's lane); replacing an
importer's rig (`replace:"importer"`; blox uploads never produce one); Roqer's
`rig-glb` 3D preview and `rig-tool`; Roqer's import-space origin bookkeeping
(`BloxRigOrigin`) — the Blender lane calibrates from the current part
positions instead (see Blender handoff). The vendored planner keeps its code
for all of these; the tool surface refuses them by name.

## Tool surface

`animate` gains these forms (`rig {model}` with no other arguments keeps
spec B's read-only behaviour; `declare` is unchanged):

| Call | Does |
|---|---|
| `rig {model, suggest:true, plan?}` | Read the pieces, propose `joints[]` (parent + pivot per part, riders in `with`), save `.blox/anims/_rig/<Model>/suggest.json` stamped with the pieces revision. Writes nothing in Studio. |
| `rig {model, joints, controller, plan?, declarations?, expected_revision?}` | Plan the build offline (vendored `planRigBuild`), make it in one Studio call, read it back, compare, draw the range sheet. |

`joints` is one of:
- an array of `{part, parent, pivot:[x,y,z], name?, with?}` (world space);
- `"suggested"` — load `suggest.json`; refuse if missing or if the pieces
  revision changed since it was written;
- `"blender"` — load `.blox/models/<id>/export/pivots.json`, where `<id>`
  is the required `blender_id` argument (the `blox model` id), and map it
  through the calibration fit.

`controller`: `"Humanoid"` (walks; root free, hip height from rest pose) or
`"AnimationController"` (flies/swims/stays put; root anchored).
`plan`: `"quadruped"` | `"custom"` (default), as spec B's `declare`.

Refused by name, nothing changed: `replace`, `pivot_space`, a skinned model
(bones present), a model with an importer rig, a rebuild (model already
jointed) without `expected_revision` or with a stale one.

## Data flow

```
animate rig {model, joints, …}
 1. readPieces (edit execute_luau, read-only)
      → raw PiecesReading + fingerprint (Luau FNV-1a over a canonical
        serialisation, as spec B's fingerprint)
    TS: revision = "rp1:" + sha256(reading)
        planRigBuild(reading, request)               (vendored, pure)
      → errors[] (nothing touched)  |  RigBuildPlan + expected ModelRigReading
 2. buildRig (one edit execute_luau)
      recompute fingerprint → mismatch: refuse "model_changed"
      begin ChangeHistory recording (spike 1; fallback: clone backup)
      pcall:
        rebuild → destroy Motor6Ds/AnimationConstraints + BloxMadeWeld welds
        root    → make or reuse (BloxMadeRoot attr), invisible
        physics → root Anchored only for AnimationController; CanCollide root
                  only; others Massless; PrimaryPart = root
        joints  → Motor6D per plan entry, parented to part1, C0/C1 from plan
        welds   → WeldConstraint per `with` rider (BloxWeld_<part0>, BloxMadeWeld)
        control → Humanoid (RigType R15, HipHeight, RequiresNeck=false,
                  BreakJointsOnDeath=false; wait for RootPart — spike 2)
                  or AnimationController; Animator in either
        attrs   → BloxRig = declarations; BloxRigBuilt = read-back rr1 revision
      error → cancel recording / restore backup → named error
      → returns spec B's readRig reading of the result
 3. TS: rigFromModel + builtRigMismatches(expected, actual)
      rangeSheetAnimation(rig) → compile → renderContactSheet
      → .blox/anims/_rig/<Model>/range.png
      result: joints, root {part, made, anchored}, controller, hipHeight,
              readBack {matches, mismatches?}, revision, range sheet path,
              planner + reader notes, next steps
```

- `src/anim/rigBuild.ts` (new) generates both programs and shares spec B's
  `readRig` Luau so the read-back is byte-identical to what `check` reads.
- Roqer → blox names: `RoqerWeld_*` → `BloxWeld_*`; made-root / made-weld /
  built-revision attributes → `BloxMadeRoot` / `BloxMadeWeld` /
  `BloxRigBuilt`; `RoqerRig` → `BloxRig` (as spec B).
- Size: `MAX_PIECE_PARTS = 512`, `MAX_RIG_JOINTS` from model-rig (vendored).
- Empty / non-JSON replies → named error via spec B's `parseReply`.
- Read-back mismatch after a successful build: result says `rigged: true`,
  lists mismatches and how to undo; not silently accepted.
- Rig revision for `expected_revision` is the rr1 revision spec B's `rig`
  read returns; a model whose `BloxRigBuilt` differs from its current rr1
  (hand-edited after build) gets a note on rebuild.

## Joint suggester

`src/anim/rigSuggest.ts` (new, pure):
`suggestJoints(reading: PiecesReading, plan) → { joints, notes, loose }`.

1. **Contact graph.** Each part as its oriented box (shape ignored). Two parts
   link when their boxes overlap or lie within 0.05 studs (SAT with slack).
   A link records its contact centre (overlap region clipped to the smaller
   box) and contact area.
2. **Trunk.** Part named `Torso|Body|Trunk|Chest` (case-insensitive), else the
   largest-volume visible part. Hidden parts and a made root are skipped.
3. **Tree.** BFS from the trunk, edges ordered by contact area descending;
   each part's parent is the neighbour it was reached from.
4. **Pivot.** Contact centre, snapped onto the child box's face nearest the
   parent (a thigh turns at its top, not its middle).
5. **Riders.** A leaf under 3% of its parent's volume whose name is not a
   known limb word goes into the parent's `with` instead of getting a joint.
6. **Plan names.** With `quadruped`, missing / unmatched body-plan names
   (`FrontLeft`, `FrontLeftUpper`, …, `Head`, `Jaw`, `Tail`) become notes.
   Never renames.
7. **Loose parts.** No contact → joined to the nearest part at the closest
   point, flagged `loose` with the gap distance.

Output `joints[]` is in exactly the build input shape, each with a short
`why`. The agent may pass it back edited, or use `joints:"suggested"`.

## Blender handoff

Blender side (`tools/blender/blox_model.py`, `tools/blender/model.py`):

- `rig_rigid(armature, parts)` — like `bind_rigid` but each piece stays its
  own object, parented to its bone, never joined; the `{piece: bone}` map is
  stored as a custom property on the armature.
- `model export` on a model with a rigid map writes:
  - `model.glb` with the pieces only (no armature), vertex-colour material,
    each object named after its piece;
  - `pivots.json`: `pieces` (name, Blender bbox centre, size), `joints`
    (piece, parent piece from the bone's parent, pivot = bone head),
    `riders` (extra pieces on a bone that already has one → `with`).
- Rigid models animate in Studio via `animate check/build` (motion checks
  apply); Blender actions stay the skinned lane (#68).

Studio side (`src/anim/rigBlender.ts`, pure):

- Match each `pivots.json` piece to the model's part of the same name.
- Fit the Blender → Roblox-world rigid transform: try all 24 axis-aligned
  rotations, least-squares translation over piece centres; keep the best.
  No axis mapping is assumed (the importer's facing turn is not fully
  pinned down; see PR #67 notes).
- Refuse (named) when: residual > 0.05 studs; fewer than 3 non-collinear
  matched pieces; sizes disagree under the fitted rotation (> 0.05 studs per
  axis); a name is missing or repeated on either side.
- Map pivots through the fit; build with world-space pivots. Because the fit
  is recomputed from where the parts are now, a moved model rigs correctly
  again.
- If spike 3 shows upload loses object names: match by nearest fitted centre
  after a name-free fit, refusing on ambiguity.

## Safety

- Nothing changes until the planner accepts the whole request.
- The build re-verifies the pieces fingerprint in the same call that writes.
- One undo step via ChangeHistoryService. If the MCP edit thread cannot
  record (spike 1), the program first clones the model to
  `ServerStorage.__BloxRigBackup.<Model>` and the result names it and how to
  restore; a failed build restores from it automatically.
- Rebuilding needs the current rr1 revision (`expected_revision`).
- No HTTP, no scripts, no asset loads in any program.

## Spikes (before the plan is executed)

1. `ChangeHistoryService:TryBeginRecording` / `FinishRecording` on the MCP
   edit thread — works, or use the clone backup.
2. `task.wait` on the MCP edit thread (Humanoid `RootPart` binding) — works,
   or skip the wait (read-back does not need `RootPart`).
3. Multi-object GLB upload → one MeshPart per object, names kept, one Model.
   Costs one Open Cloud upload: needs the user's approval.

## Testing

Offline (vitest; `npx tsc --noEmit` + full suite gate):

- Vendored `rig-build.ts` with Roqer's `rig-build.test.ts` and the
  `dog-pieces` fixture (skinned/importer planner cases kept as planner tests).
- `rigSuggest`: dog fixture → tree equals the hand rig, pivots within 0.15
  studs; synthetic biped and snake chain; riders; loose parts; quadruped
  name notes.
- `rigBlender`: all 24 rotations + translation recovered; noise within
  tolerance; too few pieces; residual refusal; size mismatch; name mismatch.
- `rigBuild`: generated Luau compiles under Lune; fake-session round trip
  (reading → plan → build reply → read-back → range sheet file); refusals
  change nothing; `model_changed`; non-JSON reply → named error.
- Tool: `suggest` / `"suggested"` / `"blender"` resolution; `suggest.json`
  revision gate; skinned/importer/replace/pivot_space refused; rebuild needs
  `expected_revision`.
- Blender (skips without Blender, like the existing Blender tests):
  `rig_rigid` + export → pieces-only GLB + valid `pivots.json`.

Live smokes (`~/blox-fw`):

- **A. Part dog.** Agent builds a ~10-part blocky dog → `rig suggest` →
  `rig joints:"suggested", controller:"Humanoid", plan:"quadruped"` → range
  sheet inspected → `check` a gait on the dog → `build` → wire to the NPC
  loader with temporary clips → `verify` walk + idle pass.
- **B. Blender creature.** `blox model` rigid voxel creature → export →
  upload (human-approved) → insert → `rig joints:"blender"` → range sheet →
  `check`/`build` a gait → `verify`.
- **C. Rebuild.** Move one pivot, rig again with `expected_revision` → old
  joints and made welds gone, read-back matches; undo (or the backup)
  restores the earlier rig.

## Docs

- `character-animation` skill: new "Rigging a model" section (suggest →
  build → read the range sheet → check).
- Spec B's "not rigged" refusal now points to `rig {model, suggest:true}`.
- `src/anim/VENDOR.md`: rig-build vendored, local renames listed; rig-glb and
  rig-tool still not vendored.
- `animate` tool description: the new `rig` forms, kept short.
