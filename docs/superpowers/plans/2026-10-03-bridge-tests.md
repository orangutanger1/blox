# Tests + metrics via eval bridge — Plan

**Spec:** `docs/superpowers/specs/2026-10-03-bridge-tests-design.md`
**Branch:** `bridge-tests`. Gate per commit: `npx tsc --noEmit` + `npx vitest run`.

### Task 1: runTests bridge path
- `src/testing/runner.ts`: `bridgeEligible(programs, timeouts)`; `runPlayViaBridge` (startPlay → runBatch per ctx → logs → stopPlay); fallback to `runPlayBatches` on ineligible / bridge throw; `TestRunResult.via`, `notes`; `formatTestRun` prints them.
- Tests first: `tests/testing.bridge.test.ts` (vi.mock evalBridge.runLuauViaBridge, fakeStudio with evalBridge).

### Task 2: metrics bot via bridge
- `src/metrics/run.ts`: `botProgram(..., {blocking})`; bridge path when eligible; fallback injection.
- Tests first in `tests/metrics.bridge.test.ts`.

### Task 3: docs + live
- agent guide / tool descriptions mention bridge use; live run_tests in ~/blox-fw.
