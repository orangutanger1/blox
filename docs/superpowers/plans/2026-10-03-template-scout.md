# Template Scout Implementation Plan

**Spec:** `docs/superpowers/specs/2026-10-03-template-scout-design.md`
**Branch:** `template-scout`. Gate per commit: `npx tsc --noEmit` + `npx vitest run`.

### Task 1: Pure core — `src/assets/scout.ts`
- `scoutQueries(need, kind) → {query, assetType?}[]`
- `mergeResults(perQuery: SearchHit[][], need, kind) → Ranked[]` (drop non-free, dedupe by assetId, score, stable sort)
- `adaptVerdict(kind, stats, findings) → {verdict, reasons}`
- `inspectProgram(path)` (Luau: parts, meshParts, guis, screenGuis, sounds, scripts with sources, size) + `gradeInspect(raw)` (risk findings via `riskFindings`)
- `scoutFile(need, kind)` slug
Tests first: `tests/assets.scout.test.ts`.

### Task 2: `scout` tool in registry + CLI
- search / try / adopt / discard as in the spec; quarantine `ServerStorage.BloxScout`.
- CLI: `blox scout <need...> --kind map [--max N]`, `blox scout try <assetId> --id x`, `blox scout adopt <id> --to Workspace [--unpack] [--keep-scripts]`, `blox scout discard <id>`.
Tests first: `tests/scout.tool.test.ts` with fakeStudio (`tools.search_asset`, `tools.insert_asset`).

### Task 3: Agent guide + README
- agentGuide "Start from a kit…" paragraph names `scout` instead of raw `studio_tool search_asset`.
- README tool table row.

### Task 4: Live smoke (~/blox-fw)
- `blox scout obby --kind map`, `try` the top hit, read verdict, `discard`. No uploads.
