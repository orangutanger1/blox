# Asset pipeline Implementation Plan

> Executed inline (superpowers:executing-plans), TDD per task.

**Spec:** `docs/superpowers/specs/2026-10-02-asset-pipeline-design.md`

## Tasks
1. `src/assets/manifest.ts` (zod schema, load/save, `addAsset`, `approveAsset`) + `src/assets/lint.ts` (`lintAssets(manifest, scan?)`, `assetResults`). Tests `tests/assets.manifest.test.ts`.
2. `src/assets/scan.ts` — `SCAN_LUAU`, `sanitizeProgram(path, keep)`, `riskFindings(source)` (TS twin used for tests + to grade Luau-reported sources). Tests incl. Lune compile, fake Studio.
3. `assets/normalize.py` + `src/assets/blender.ts` (`blenderCommand`, `runNormalize` with injectable spawn). Tests: command, missing binary, report parsing, `python3 -m py_compile`.
4. `src/opencloud/client.ts` + `src/assets/upload.ts` (gates + dry run). Tests with fake fetch.
5. Registry tool `asset`, CLI `blox asset …` incl. CLI-only `approve`, `withSyntheticResults` reads `asset-report.json`, guide, MCP list.
6. Verify + PR.
