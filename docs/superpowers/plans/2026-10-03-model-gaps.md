# blox model gaps Implementation Plan

**Spec:** `docs/superpowers/specs/2026-10-03-model-gaps-design.md`
**Branch:** `model-gaps`. Gate per commit: `npx tsc --noEmit` + `npx vitest run`.

### Task 1: Colour survival + upload parts (Python)
- `tools/blender/blox_model.py`: `colour_class(mat) → flat|vertex|texture|procedural|missing-image`, `upload_parts(objs)`.
- `tools/blender/model.py stats()`: `colours {material: class}`, `uploadParts`, issues for procedural / missing-image.
- Test first: `tests/model.blender.test.ts` (skips without Blender): procedural material → issue; flat + Color Attribute → none; textured+flat mesh → uploadParts 2.

### Task 2: Budget block (TS)
- `ModelStats` gains `uploadParts?`, `colours?`; `formatStats(s, P, budget?)` prints `budget:` and `colours:` lines.
- Tests first in `tests/model.test.ts`.

### Task 3: check returns images
- `checkImages(views, refs, projectPath)` in `src/model/run.ts` → `{images, notes}`: PNG/JPEG only, ≤ 2 MB, refs capped at 4.
- `model check {images?:false}`; handler attaches views + refs.
- Tests first: pure helper with temp files; handler via a fake `BLOX_BLENDER` script.

### Task 4: Docs
- `model` tool description + briefText step 3 mention images and colour lint.
