# Presentation pipeline Implementation Plan

> Executed inline (superpowers:executing-plans), TDD per task.

**Spec:** `docs/superpowers/specs/2026-10-02-presentation-pipeline-design.md`

## Tasks
1. `src/present/schema.ts` (zod, `validatePresentation`) + `src/present/generate.ts` (`titleCandidates`, `describe`, `defaultShots`). Tests `tests/present.generate.test.ts`.
2. `src/present/image.ts` (`imageSize(buf)` for PNG/JPEG) + `src/present/lint.ts` (`lintPresentation(doc, projectPath)` → findings + `present:<rule>` results, `formatPresentLint`). Tests `tests/present.lint.test.ts` with hand-built PNG/JPEG headers.
3. `src/present/rig.ts` (`rigProgram(shot)`, `CLEANUP`), `src/present/render.ts` (`renderShots(session, projectPath, doc, ids?)`). Tests with fakeStudio (`screen_capture` returns an image; rig built then cleaned up even on capture failure), Lune compile of a rig program.
4. Registry `present` tool + `withSyntheticResults` reads `present-report.json` + CLI `blox present get|set|generate|render|lint` + guide + MCP list. Tests `tests/present.tool.test.ts`.
5. Verify + PR.
