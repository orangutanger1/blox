# Open Cloud upload path: key file, GLB, vertex colours

Findings from the first live uploads (2026-10-02, user 682176016):

| Probe | Result |
|---|---|
| `crate` as FBX (`apply_unit_scale`) | inserted 400×400×400 studs (100×, cm units), colour lost |
| colour/facing probe as GLB | 4×2.5×2 studs (1 Blender unit = 1 stud), one MeshPart, colours kept |
| glTF facing | Roblox turns glTF +Z (Blender −Y, our front) into its look direction −Z; a pre-turn reversed it |
| brightness | vertex colours are multiplied by `MeshPart.Color` (default 163 grey → 0.64×); white Color matches Parts of the same RGB exactly |
| vertex colour encoding | sRGB numbers in COLOR_0 render as the intended hex (no gamma step needed) |

Changes:
- `openCloudKey()` falls back to `~/.config/blox/opencloud.env` (non-interactive
  shells never source `~/.bashrc`). Tests get a temp `XDG_CONFIG_HOME` and no key
  via `tests/setup.ts`: a test once reached the live API through the fallback.
- `blox_model.material()` stores colours linear (renders now match the hex);
  `bake_vertex_colors()` bakes untextured materials into a "Col" sRGB attribute and
  one shared `BloxVertexColor` material (textured materials kept); `export_glb()`.
- `model export` also writes `model.glb` (the upload; `model import` records it);
  `asset normalize` defaults to `.normalized.glb` and now applies location before
  pivoting (results were off-centre and not grounded).
- Upload dry run warns on FBX; the upload result says how to insert and to set
  MeshPart Color to white.
