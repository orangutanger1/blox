# UI kit + UI lint Implementation Plan

> Executed inline (superpowers:executing-plans), TDD per task.

**Spec:** `docs/superpowers/specs/2026-10-02-ui-kit-lint-design.md`

## Tasks
1. **Lint rules** — `src/ui/lint.ts`: `DEVICES`, `UiSnapshot`/`UiElement` types, `lintSnapshot(s)`, `lintResults(findings, devices)` → `ui:<rule>` results, `formatUiReport`. Tests `tests/ui.lint.test.ts` (one positive + one negative case per rule, desktop touch threshold, warn vs error grading).
2. **Probe** — `src/ui/probe.ts`: `uiProbeProgram(devices)` client Luau (emulation described in spec), `parseProbe(raw)`; Lune compile check of the generated program.
3. **Tool** — registry `ui` {lint|install}; `src/ui/run.ts` orchestration; `withSyntheticResults` also reads `ui-report.json`; CLI `blox ui lint|install [--seconds N] [--prepare '<luau>'] [--devices a,b]`; guide; MCP list. Tests with fakeStudio.
4. **BloxUI** — `kits/_common/files/src/ReplicatedStorage/BloxUI/*.luau` + `kits/_common/files/tests/blox_ui.spec.luau` (edit); Lune harness injects `@lune/roblox` globals; test runs it.
5. **Kit HUD** — rebuild `KitHud.client.luau` on BloxUI; compile check; kit tests green.
6. **Verify + PR.**
