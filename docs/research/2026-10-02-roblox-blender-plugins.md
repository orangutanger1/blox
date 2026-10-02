# Roblox devs: Blender practice and plugins (2026-10-02)

## Blender → Roblox, as practised

- Export FBX (keeps rig + skin weights): Apply Scalings = FBX Unit Scale,
  -Z Forward / Y Up, Path Mode Copy + Embed Textures, Add Leaf Bones off,
  Bake Animation only for animation files. Apply rotation/scale first. [1][2]
- Import with Studio's 3D Importer (Home tab); animations with the Animation
  Clip Editor importer, which since Aug 2026 fixes common Blender mismatches at
  import time. [1]
- Open Cloud Assets API: Model accepts .fbx/.gltf/.glb/.rbxm(x) (imports as a
  Model of MeshParts); Animation accepts only .rbxm/.rbxmx. Files edited
  outside Studio may not upload for those types. [3]
- AI-first workflow in the wild (@lifeshaze, Sep 2026): ChatGPT makes
  multi-angle style references → a prompt with style, tri cap, "Roblox-ready",
  "riggable", named animations → Claude builds in Blender in one shot (~$2.84,
  ~1.5 h wall) → manual tweaks → FBX model + per-animation FBX → human import.
  `blox model` automates the build/check/export/preview part.

## Plugins builders actually use (free unless noted)

- Building Tools by F3X — precise move/resize/rotate, surface snapping, paint.
- Archimedes Two — arcs, rings, spirals from parts.
- GapFill & Resize Align (Stravant) — fill gaps, resize to a surface.
- Moon Animator 2 — the de-facto animation editor (multi-rig, easing).
- Rojo — file sync (blox uses `rojo sourcemap` as its mapping oracle).
- Tag Editor — now built into Studio (2026). [4][5]

For blox: none needs integrating; agent-side equivalents exist (sync, code-built
geometry, model pipeline). Moon Animator is the human path for hand-polishing
animations the model pipeline exports.

Sources:
[1] https://nilo.io/articles/export-from-blender-to-roblox ·
https://nilo.io/articles/export-animations-to-roblox-studio
[2] https://create.roblox.com/docs/art/modeling/export-requirements
[3] https://create.roblox.com/docs/cloud/guides/usage-assets
[4] https://picoo.io/blog/best-roblox-studio-plugins-2026
[5] https://rohire.dev/blog/5-free-roblox-studio-plugins-2026
