# `model animate`: Blender actions → Roblox animations

Closes the "animations need Studio's Animation Editor by hand" gap. Ideas from
Roqer's animation tool (shared with permission): check motion before Studio,
build the KeyframeSequence against the real rig, play it and compare.

## Pipeline
1. `model export` writes `anim_<action>.json`: per frame, every bone's posed
   and rest matrix in Blender model space (+ mesh centre, loop flag).
2. `prepare()` (src/model/anim.ts): D = posed·rest⁻¹, Q = D_parent⁻¹·D (motion
   relative to the parent), moved into Roblox axes centred on the mesh
   ((x, y, z) → (−x, z, y), matching the GLB import).
3. Motion checks: loop closes (≤2°, ≤0.05 studs), no joint faster than
   1440°/s, something moves.
4. Studio (edit mode, non-script instances only): rest check (Blender bone
   heads vs imported Bones ≤0.05 studs), Pose CFrame = W0⁻¹·M·Q·M⁻¹·W0
   (W0 = Bone.WorldCFrame, M = MeshPart.CFrame), poses nested
   `<MeshPart> > <root bone> > …`, registered with KeyframeSequenceProvider,
   stepped with Animator:StepAnimations, and every bone's head plus a point
   1 stud along it compared with the Blender motion (≤0.1 studs).
5. rbxmx → `rojo build` → `anim_<action>.rbxm`, recorded as an `animation`
   asset; upload sends it as assetType Animation.
6. Runtime: `ReplicatedStorage.BloxAnimate` (kits/_common): `play`, `track`,
   `auto(model, {idle, walk})`.

## Spikes / live results (dog probe, 6 bones)
- Skinned GLB upload → MeshPart with nested Bones + AnimationController.
- Pose hierarchy: `root>head` and `body>root>head` drive bones; a top-level
  child-bone pose does not. Pose.CFrame = Bone.Transform. Edit-mode stepping
  works from the MCP thread once the track has loaded.
- Walk: probe error 0.001 studs; Sleep 0.000. Uploaded Walk
  (asset 87111650999140) samples identically to the local KeyframeSequence, and
  a server spec in a playtest sees it swing the leg > 20°.

## Not done
R15/R6 character animations (Motor6D pose compiler, Animate-script slots) and
gait/IK generators; contact-sheet images; NPC loader pacing by ground speed.
