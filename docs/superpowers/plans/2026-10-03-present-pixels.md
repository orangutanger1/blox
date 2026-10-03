# Present pixel checks — Plan

**Spec:** `docs/superpowers/specs/2026-10-03-present-pixels-design.md`. Branch `present-pixels`.
Gate per commit: `npx tsc --noEmit` + `npx vitest run`.

### Task 1: decoders — `src/present/pixels.ts`
- `decodePng(buf)`, `decodeJpegDc(buf)` → `{w, h, luma, rgb}` | null; `decodeSmall(buf)` dispatch.
- Fixtures via Blender (script in scratchpad, outputs committed); tests first `tests/present.pixels.test.ts`.

### Task 2: stats + rules
- `pixelStats(img)` → `{std, p5, p95, mean}`; `aHash(img)` 16×9 bits; `hamming`.
- `lintPresentation`: `thumb-blank`, `thumb-contrast`, `thumb-similar` (thumbnails + icon for blank/contrast).
- Tests first in `tests/present.lint.test.ts` (or existing file).

### Task 3: live smoke on ~/blox-smoke captures (read-only, not committed).
