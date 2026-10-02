# Blender in the agent loop (`blox model`) — design

Source: the @lifeshaze workflow (Sep 2026): multi-angle reference images → a
structured prompt (style, triangle cap, Roblox-ready, rig-ready, named
animations) → Claude writes the model in Blender → fix small mistakes → FBX →
import model and animations into Studio. blox automates the middle and keeps the
human gates.

## Shape

- Agent-agnostic core: Blender runs headless (`blender -b`, BLOX_BLENDER or PATH).
  The GUI Blender MCP (blender-lab) is optional, for watching live.
- `.blox/models/<id>/`: brief.json, code/build.py (the source of truth; every
  run rebuilds model.blend from it), views/, check.json, export/.
- Helpers (tools/blender/blox_model.py): reset, material, box, voxels (culls
  shared faces → low-poly blocky models), join, rig, bind_rigid (each part 100%
  on one bone), animate (keyframes → action on its own NLA track), rest.
  1 Blender unit = 1 stud; Z up; models face -Y.

## Actions

brief → run → check (stats vs Roblox limits: 20k tris/MeshPart, ≤4 influences,
≤1024 textures, skinned to the rig; + Workbench turnaround renders for the
agent to compare with references) → export (model.fbx rest pose; anim_<name>.fbx
per action; preview.json in Roblox axes) → preview (EditableMesh MeshPart from
the MCP thread, coloured per face, nothing uploaded) → import (asset manifest
candidate; human `blox asset approve`; existing Open Cloud upload).

## Constraints found

- Open Cloud uploads FBX as Model, but animations only as .rbxm/.rbxmx; so
  animations go through Studio's Animation Editor FBX import (human step) until
  KeyframeSequence generation is verified against a real rig.
- Headless Workbench renders need software GL on WSL (LIBGL_ALWAYS_SOFTWARE=1,
  WAYLAND_DISPLAY=nonexistent), passed per spawn.
- `model run` executes agent-written Python with host access: gated in --ask.

## Open

- Facing after Roblox's 3D importer is unverified (export: -Z forward, Y up;
  preview uses the same mapping). One manual import settles it.
- Textured (UV) models: the helpers do flat colours; textures pass through FBX
  (embed) but preview ignores them.
