# FTUE + soak metrics Implementation Plan

> Executed inline (superpowers:executing-plans), TDD per task.

**Spec:** `docs/superpowers/specs/2026-10-02-ftue-soak-metrics-design.md`

## Global Constraints
ESM TS, `.js` suffixes, no new deps; Lune-backed tests skip without a binary; `npx vitest run` + `npx tsc --noEmit` before PR.

## Tasks
1. **Codegen FTUE order** — `renderTunables` emits `ftue = { "<id>", ... }` (array, design order). Test in `tests/design.codegen.test.ts`.
2. **Pure evaluation** — `src/metrics/gamefeel.ts`: `TelemetryDump` type, `evaluateFtue(dump, doc|null, budgets?)`, `memorySlope(samples)`, `evaluateSoak(dump, errorCount, {doc, archetype, tolerance, seconds, maxMemGrowthMbPerMin})`, `formatMetrics(report)`. Tests `tests/metrics.gamefeel.test.ts` (step within/over target, missing step, auto first-currency, slope math, pace window incl. unreached).
3. **Synthetic results** — rename `withDesignResults` → `withSyntheticResults` (reads sim-report + metrics-report); update call sites/tests; test metrics results appear as `ftue:<id>`.
4. **Luau** — `kits/_common/files/src/ReplicatedStorage/BloxTelemetry.luau`; kit KitService calls `start()`, `step` for `first-step` (first action gain while moving) and gate ids `first-wall` mapping via design ftue ids that equal gate ids, `event` purchases/rebirth; kit `bots/active.luau`; kit design adds `bot` archetype (cheapest, long session) + ftue ids aligned. `applyKit` copies `_common` first. Lune compile check covers new files.
5. **Tool** — `src/metrics/run.ts` `runMetrics(session, projectPath, opts)` (play → bot → wait → dump → logs → stop), registry tool `metrics`, CLI `blox metrics ftue|soak|install [--seconds N] [--bot X] [--archetype A]`, guide line, MCP tool list. Tests with fakeStudio: dump parsed + report written + isError on failing step; missing telemetry message; install writes the module; bot file inlined.
6. **Verify + PR.**
