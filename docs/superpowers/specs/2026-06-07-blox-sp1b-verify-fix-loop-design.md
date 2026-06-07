# blox SP1b — Verify/Fix Loop, Asset Tools, MCP Bridge Migration

**Date:** 2026-06-07
**Status:** Design approved → ready for implementation planning
**Parent spec:** `docs/superpowers/specs/2026-06-06-blox-design.md` (§8 SP1 MVP)
**Predecessor:** SP1a (core loop) — complete and merged to `main` (HEAD `6c6cb05`).

## 1. Goal

Complete the remaining SP1 MVP loop by adding the **autonomous tier-1
verify→fix loop**, **thin asset-generation tools**, and **migrating the Studio
bridge to the current built-in Studio MCP server**.

Prove end-to-end:

```
prompt → code → headless-verify (execute_luau) → fix → repeat (bounded) → commit
```

with **real Rojo sync** running in WSL. Live Studio validation and tier-2 play
sessions are explicitly deferred to SP1c (see §8).

## 2. Context: what SP1a already built

SP1a is a single agent run plus deterministic post-steps:

- `cli.ts`: parse args → load config → build digest → pick bridge (real/mock) →
  build query options → `runAgent` (one SDK `query()` pass) → `syncProject`
  (Rojo) → `commitChanges` (git) → print report.
- `bridge/{types,mcpBridge,mockBridge}.ts`: `StudioBridge` seam exposing
  `mcpServers()` + `allowedTools()`.
- `agent/{systemPrompt,buildOptions,runAgent}.ts`: system prompt from digest,
  query options, the SDK run loop.
- `sync/rojo.ts`: `syncProject` via `rojo sourcemap`, with an injectable
  `SpawnFn` (`realSpawn` default) — the established test seam.
- `git/commit.ts`, `context/digest.ts`, `report.ts`.

**What is missing (this spec):** no verify step, no fix loop, no asset tools, and
the bridge points at the now-**deprecated** standalone Rust MCP server.

## 3. Corrected facts (supersede the parent spec / SP1a assumptions)

The parent design (§3, §6, §8) was written against the standalone Rust MCP
server (`Roblox/studio-rust-mcp-server`), which is **deprecated**. The current
path is the **Studio built-in MCP server**
(<https://create.roblox.com/docs/studio/mcp>). Verified facts:

- **Transport:** still stdio. Bridge architecture is unchanged.
- **Server name:** `Roblox_Studio`. Enabled inside Studio (Assistant → Manage
  MCP Servers → "Enable Studio as MCP server"), not a separate binary install.
- **Launch command (verbatim from docs):**
  - Windows: `cmd.exe /c %LOCALAPPDATA%\Roblox\mcp.bat`
  - macOS: `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`
  - WSL: invoke the Windows form (`cmd.exe /c …mcp.bat`) across the WSL/Windows
    boundary.
- **Tool surface (verbatim):**
  - Scripts: `script_read`, `multi_edit`, `script_search`, `script_grep`
  - Assets: `generate_mesh`, `generate_material`, `generate_procedural_model`,
    `insert_from_creator_store`
  - Data model: `explore_subagent`, `search_game_tree`, `inspect_instance`
  - Luau: `execute_luau` — **the only Luau-exec tool.** There is **no**
    `run_script_in_play_mode` / `run_code`; the parent spec was wrong.
  - Playtest: `start_stop_play`, `console_output`, `screen_capture`,
    `playtest_subagent`
  - Input: `character_navigation`, `keyboard_input`, `mouse_input`
  - Session: `list_roblox_studios`, `set_active_studio`
- **Tier-1 headless verify = `execute_luau`** running test Luau and capturing
  output/errors.

## 4. Agent SDK feasibility (verified against the installed package)

Checked `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`:

- **Hooks supported.** `Options.hooks?: Partial<Record<HookEvent,
  HookCallbackMatcher[]>>`. Events include `PreToolUse`, `PostToolUse`, `Stop`.
  `HookCallback` is `(input, toolUseID, { signal }) => Promise<HookJSONOutput>`;
  `HookCallbackMatcher` is `{ matcher?: string; hooks: HookCallback[]; timeout? }`.
- **Bounding is fully SDK-native.** `Options.maxTurns?: number` *and*
  `Options.maxBudgetUsd?: number` are both real options — the docs on
  `maxBudgetUsd` read: "Maximum budget in USD for the query. The query will stop
  if this budget is exceeded, returning an `error_max_budget_usd` result."
  SP1a already passes `maxBudgetUsd`, so it works as-is. (Also available:
  `Options.taskBudget?: { total: number }` — a token budget the model is *made
  aware of* so it paces tool use; optional nicety, see §6.3.)
- **Result subtypes** (drive `stopReason`): `'success'` |
  `'error_during_execution'` | `'error_max_turns'` | `'error_max_budget_usd'` |
  `'error_max_structured_output_retries'`.
- **`canUseTool?: CanUseTool`** exists for a future stop-to-ask gate; stubbed/out
  of scope for SP1b.
- **Type entry point** is `sdk.d.ts` itself, so `HookCallback`, `HookInput`,
  `HookJSONOutput`, `Options` import directly from
  `@anthropic-ai/claude-agent-sdk`.

**Correction to an earlier assumption:** budget bounding does NOT need a
blox-managed `abortController` / cost accumulation — `maxBudgetUsd` is native.
The only blox-owned orchestration in SP1b is the PreToolUse sync hook.

These findings drive the architecture in §5.

## 5. Architecture

**Agent-native loop; blox owns the gates via SDK hooks.**

The agent drives iteration inside a single `query()` session (so fix attempts
retain memory of prior failures). blox does not run an outer re-invocation loop
and does not introduce a second MCP client.

- **Bounding is SDK-native:** `maxTurns` (iteration cap) + `maxBudgetUsd` (cost
  cap; query stops with `error_max_budget_usd`). Both already in `BloxConfig` and
  already passed through. No blox-managed abort.
- **The one blox-owned gate is the sync gate** — a **PreToolUse hook on
  `execute_luau`**: before the agent runs any Luau test, blox runs
  `syncProject()` (real Rojo) so tests execute against current `.luau` files.
  blox owns sync; the agent owns *when* and *what* to test.
- **`runAgent` maps the result `subtype` → `stopReason`** so the report
  distinguishes a clean finish from a bounded stop (see §6.4).

Why this shape:

- Avoids the in-process-tool-calling-another-MCP-server problem (a blox `verify`
  tool would need its own stdio client to `Roblox_Studio`, i.e. a second Studio
  connection). A hook sidesteps that entirely.
- Everything blox owns (bridge config, sync hook, subtype→stopReason mapping,
  asset tool list, system prompt) is pure TS and testable against the mock
  bridge. Agent reasoning is not unit-testable in any design, so no loop logic
  lives in untestable code.
- Fits the SP1a seams (`StudioBridge`, `SpawnFn`).

### Data flow (SP1b)

```
user prompt
  → agent plans (Opus 4.8, adaptive thinking)
  → reads context (files + DataModel via search_game_tree / inspect_instance)
  → edits .luau files (Edit/Write)
  → agent calls execute_luau to run tests
      └─ [PreToolUse hook] blox runs syncProject() (real Rojo) first
  → agent reads output/errors
  → fix → re-run execute_luau → … (bounded natively by maxTurns + maxBudgetUsd)
  → (optional) asset tools for prototype assets
  → cli.ts: final syncProject → git commit → report
```

## 6. Components (changes)

### 6.1 `bridge/mcpBridge.ts` — migrate to built-in server
- Server key `Roblox_Studio`; allowed-tool prefix `mcp__Roblox_Studio__*`.
- Default command per platform; keep `BLOX_STUDIO_MCP_CMD` / `BLOX_STUDIO_MCP_ARGS`
  overrides:
  - WSL/Windows default: `cmd.exe` with args `['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat']`
  - macOS default: `/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`
  - Platform detected via `process.platform` (`win32`/`darwin`); WSL (`linux`)
    uses the Windows form.
- `allowedTools()` returns, prefixed: `search_game_tree`, `inspect_instance`,
  `script_read`, `script_search`, `script_grep`, `execute_luau`,
  `generate_mesh`, `generate_material`, `generate_procedural_model`,
  `insert_from_creator_store`.
- **Out of scope tools** (not exposed in SP1b): `multi_edit` (files are
  canonical via Rojo), all tier-2/input/session tools (SP1c).

### 6.2 `agent/hooks.ts` (new) — the sync gate
- `buildSyncHook(projectPath, spawn?)` → a `HookCallback`. On a `PreToolUse`
  event whose `tool_name` ends with `execute_luau`, it runs
  `syncProject(projectPath, spawn)` and returns `{ continue: true }`. For any
  other event/tool it returns `{ continue: true }` unchanged.
- On sync failure it still returns `{ continue: true }` but attaches
  `hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: '<sync
  error>' }`, so the agent sees the sync problem (and that tests may be stale)
  rather than silently testing old files.
- Matcher targets the fully-qualified `mcp__Roblox_Studio__execute_luau`; the
  hook body also re-checks `tool_name` defensively.
- Pure/testable: inject `SpawnFn` (reuse `sync/rojo.ts` seam); no live Studio
  needed to test the hook.

### 6.3 `agent/buildOptions.ts`
- Add `hooks: { PreToolUse: [ { matcher: 'mcp__Roblox_Studio__execute_luau',
  hooks: [buildSyncHook(config.projectPath)] } ] }`.
- **Keep `maxBudgetUsd`** in the returned options object — it is a real native
  option, not a no-op. Keep `maxTurns`, `thinking: { type: 'adaptive' }`.
- (Optional, deferred) `taskBudget: { total }` and `effort` — not in SP1b.

### 6.4 `agent/runAgent.ts`
- No abort/cost-accumulation logic (budget is native).
- Add a pure `classifyStop(subtype)` helper → `StopReason`
  (`'completed' | 'maxTurns' | 'budget' | 'error'`): `'success'`→`completed`,
  `'error_max_turns'`→`maxTurns`, `'error_max_budget_usd'`→`budget`, else
  `error`. Extend `AgentRunResult` with `stopReason` set from the result message.

### 6.5 `agent/systemPrompt.ts`
- Append fix-loop guidance: after editing `.luau` files, write and run Luau tests
  via `execute_luau` (load modules, exercise functions, assert, capture
  errors/output); read failures; fix; repeat until tests pass or the run is out
  of budget/turns. Use the asset tools for prototype assets when the task needs
  them. Note that files are canonical (do not use `multi_edit`).

### 6.6 `bridge/mockBridge.ts` — enrich for dev/gated-e2e
- Rename in-process server to `Roblox_Studio`.
- Add an `execute_luau` mock + echo mocks for the four asset tools so a dev/gated
  run exercises the full tool set.
- Export a pure `sequenceResponder(results: string[]): () => string` (returns
  successive entries, last repeats) used to script the `execute_luau` mock
  (e.g. fail→fail→pass for a gated loop run). The pure util is what unit tests
  assert; the SDK tool handler is exercised only in dev/gated e2e.
- `allowedTools()` mirrors the real bridge's SP1b set (`Roblox_Studio` prefix).

### 6.7 `sync/rojo.ts`
- No code change required, but rojo is **installed in WSL** so an integration
  test can exercise the real `syncProject` path (Studio mocked). If rojo's CLI
  surface differs from SP1a's `rojo sourcemap` assumption, reconcile here.

## 7. Testing & definition of done

Done bar = **mock + real rojo in WSL** (per design decision). SP1b is "done"
when:

- **Unit tests (mock bridge / injected seams):**
  - bridge config: server key, allowed-tool prefixes, per-platform default
    command, env-override behavior.
  - PreToolUse sync hook: fires `syncProject` for `execute_luau`, ignores other
    tools, surfaces sync failure via `additionalContext` (SpawnFn injected — no
    live Studio).
  - `classifyStop`: maps each result subtype to the right `stopReason`.
  - `execute_luau` mock sequencer (pure `sequenceResponder` util).
  - asset tool list present in `allowedTools`.
- **Integration test:** real rojo in WSL exercises `syncProject` against the
  fixture game (`test-fixtures/game/`); Studio still mocked.
- **Gated live e2e:** written but skipped (same gate pattern as SP1a); runs only
  with a live Windows Studio — exercised in SP1c.
- `tsc` clean; `npm run build` produces `dist/cli.js`.

## 8. Out of scope (deferred to SP1c / later)

- **Tier-2 play sessions:** `start_stop_play`, `console_output`,
  `screen_capture`, `playtest_subagent`. Stateful, flaky, and unvalidatable in
  WSL. Tier-1 `execute_luau` carries the autonomous fix loop for SP1b. The
  "playtest" element of the MVP goal is honored in SP1c once live Studio
  validation can be set up.
- **Input simulation:** `character_navigation`, `keyboard_input`, `mouse_input`.
- **Session/multi-Studio:** `list_roblox_studios`, `set_active_studio`.
- **Live Studio e2e** across the WSL/Windows boundary (real `mcp.bat`).
- Per-run autonomy controls; `canUseTool` stop-to-ask beyond a stub; visual
  verify (SP2); heavy asset pipeline (SP3).

## 9. Risks & mitigations

- **WSL/Windows MCP bridge unproven.** Mitigation: SP1b validates everything
  blox-owned via mock + real rojo; the live `cmd.exe→mcp.bat` hop is isolated to
  the (deferred) SP1c live e2e, behind the existing env-override seam.
- **rojo CLI surface drift** from SP1a's assumption. Mitigation: real-rojo
  integration test catches it inside SP1b.
- **Runaway fix loop.** Mitigation: native `maxTurns` + `maxBudgetUsd` are hard
  caps; `stopReason` records which fired.
- **`execute_luau` output format unknown until live.** Mitigation: SP1b keeps
  parsing on the agent side (no blox-owned result parser), so format changes do
  not break blox; revisit if SP1c shows a need for structured gating.

## 10. Open questions (for SP1c)

- Exact `execute_luau` result envelope (for any future blox-owned tier-1 gate).
- Whether tier-2 needs a blox-owned play-session lifecycle wrapper or stays
  agent-driven pass-through.
- Real WSL→Windows latency/reliability of the stdio hop.
