# Format kit (+1 incremental) Implementation Plan

> Executed inline (superpowers:executing-plans), TDD per task.

**Goal:** `kit` tool + first kit `incremental` whose runtime economy is verified equal to the simulator.

**Spec:** `docs/superpowers/specs/2026-10-02-format-kit-incremental-design.md`

## Global Constraints

- ESM TS, `.js` import suffixes; tests in `tests/*.test.ts`; no new npm dependencies.
- Luau targets Roblox Luau (strict-compatible, `--!strict` not required); no Lune-only APIs in kit files.
- Lune-backed tests skip cleanly when no binary (`BLOX_LUNE` env, else `lune` on PATH).
- Before claiming green: `npx vitest run` AND `npx tsc --noEmit`.

## Tasks

### Task 1: Lune spec harness
- Create `tests/lune/harness.luau`: loads spec files with `@lune/luau` `load(source, {environment})`; env provides `test/it/describe/expect/waitFor` (same matchers as `src/testing/runner.ts`), a fake `game:GetService(name)` returning path proxies rooted at `src/<name>`, and a `require` that resolves proxies to `<path>.luau` / `<path>/init.luau` (cached). Prints one JSON line `{results, fileErrors}`.
- Create `tests/helpers/lune.ts`: `luneBin(): string | null`, `runLuneSpecs(projectDir, files[])`, `luneCheck(files[])` (compile-only syntax check via `luau.compile`).
- Test `tests/lune.harness.test.ts` (skipIf no lune): a temp project with a module + passing and failing spec → statuses; a syntax error → fileErrors.

### Task 2: Economy.luau + Format.luau
- Create `kits/incremental/files/src/ReplicatedStorage/Kit/{Economy,Format}.luau` per spec contract.
- Create `kits/incremental/files/tests/kit_economy.spec.luau`, `kit_format.spec.luau` (`-- @context edit`): cost growth, requires, max, purchase deducts, upgrade mult/add, consume gate, auto gate on tick, chance roll with injected rng, drains closed form, offline cap, rebirth reset + mult + pass regrant, abbreviations.
- Test `tests/kit.incremental.test.ts`: run both specs via Lune against a temp project made of kit files + generated Tunables → all pass.

### Task 3: Sim parity
- Export `rates` + `SimState` from `src/design/sim.ts` (no behaviour change).
- Add Lune parity script `tests/lune/parity.luau`: given Tunables + a JSON list of states, prints Luau `rates(state, online)` and `cost` for each item.
- Test: for the kit design, scripted owned-count states (incl. rebirths, upgrades, chance income) → Luau rates == TS rates (rel 1e-9); costs equal.

### Task 4: Server, client, world, server spec
- `KitService.luau` (data via DataStore with in-memory fallback, 1 s tick, leaderstats, `Kit/Remotes` Purchase/Rebirth RemoteFunctions with rate limit, offline accrual on join, autosave, BindToClose, `getState/grant/grantPass/purchase/rebirth` API), `KitMain.server.luau`, `KitHud.client.luau`, `world/Track.luau`, `tests/kit_server.spec.luau` (`server`).
- Test: every kit `.luau` compiles under Lune (syntax), and Task 2 specs still pass. Live run is a pending Studio smoke.

### Task 5: kit tool + CLI + guide
- `src/kits.ts`: `listKits()`, `applyKit(projectPath, name)` (non-destructive copy, design.json if absent, Tunables regen), kit root resolved from module URL (`../kits` from `src/` or `dist/`).
- Registry tool `kit` {action: list|apply, name?}; CLI `blox kit [list|apply <name>]`; help line; `TOOL_COMMANDS`; agent guide line; MCP tool-list test update.
- Tests `tests/kit.tool.test.ts`: list; apply into temp dir creates files + design + Tunables; second apply keeps all; edited file kept; existing design kept; unknown kit error; kit design validates and passes its own assertions.

### Task 6: Verify + PR
- Full `npx vitest run`, `npx tsc --noEmit`, CLI smoke `blox kit apply incremental` in a temp dir; squash-merge.
