# blox model gaps (lifeshaze eval)

Status: self-approved design (unattended run 2026-10-03). Queue item 3.

## Where blox model stands

The 2026-10-02 eval of the @lifeshaze AI→Blender workflow listed three gaps.
Reading the code on 2026-10-03, part of each is already in place:

| Gap | Already there | Still missing |
|---|---|---|
| Reference images | `brief {refs}` checks that the files exist and lists them in the build guide | The agent never *sees* them next to its renders. `check` returns render paths only, so an MCP agent with no image-file reader compares nothing. |
| Budget/stats report | `check` flags triangles over budget and per-mesh/texture/influence limits | No "used vs target" view: % of the triangle budget, how many MeshParts the upload makes, bones, texture sizes in one place. |
| Colour survival | `export` bakes flat material colours into vertex colours | Nothing warns *before* export about colours the bake can't save: procedural base colours (noise, ramps, other nodes), image textures whose pixels are missing. Those arrive white. |

## Design

1. **`check` returns images.** The four views plus up to four reference
   images (PNG/JPEG, ≤ 2 MB each) come back as tool images, so any MCP client
   sees them side by side. `images:false` turns this off. Refs that are too big or not
   PNG/JPEG are listed by path with a note.
2. **Budget report.** `model.py stats` gains `uploadParts`: the MeshParts
   an upload makes (per mesh: one if any face is flat-coloured, plus one
   per textured material it uses) and `colour`: a per-material survival
   class. `formatStats` prints a budget block:
   `triangles 4210 / 5000 (84%) · upload ≈ 3 MeshParts · 12 bones · textures: 1024²`.
3. **Colour-survival lint.** Each material used by a mesh is classed:
   `flat` (baked → survives), `texture` (packed or on disk → survives),
   `vertex` (Color Attribute node → survives), `procedural` (Base Color
   linked to another node → **lost**), `missing-image` (image node with no
   pixels → **lost**). Lost classes become `issues` (so `check`/`run` report
   errors) naming the material and the fix: use flat colours or bake to an image.

## Decisions

- Images on by default: a view is ~350 tokens at 512²; seeing them is what
  check is for. Opt-out exists for text-only clients.
- Classification lives in Python (it needs node trees); TS only formats.
- No new deps.

## Testing

TS: formatStats budget block, check images attach/opt-out/ref size skip
(fake runModelPy via a spawner seam). Blender (skips without Blender):
procedural material → issue; flat + vertex colour → no issue; uploadParts
for a mixed textured/flat mesh.
