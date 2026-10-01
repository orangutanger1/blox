# blox, agent-native — architecture and decisions (2026-09-30)

## 1. What blox was

A Claude Agent SDK wrapper (`blox "<prompt>"`): system prompt + Read/Write/Edit +
the raw Roblox Studio MCP tool surface, a PreToolUse hook that ran `rojo sourcemap`
before `execute_luau`, auto-commit, and a large human-facing periphery (Studio dock
panel + daemon, Electron desktop app, CCR model routing, auth linking, team policy,
audit ledger, usage report, spend relay). ~7k lines, ~500 unit tests, all green.

What it demonstrably could and could not do (live, 2026-09-30):

| claim | reality |
|---|---|
| "edits sync into Studio" | only via `rojo serve` **plus a human clicking Connect** in the Rojo plugin; the PreToolUse hook ran `rojo sourcemap`, which pushes nothing |
| "verify loop" | prompt advice to call `execute_luau`; no tests, no structured results, `print` output lost, errors unmapped, edit-context `require` returned stale modules |
| "play-test" | raw `start_stop_play`; prompt said server state is unreachable in play (false — the Server datamodel is available); nothing guaranteed play was stopped |
| tool surface | hardcoded names; two (`search_creator_store`, `insert_from_creator_store`) no longer exist; every tool now needs `studio_id` (Aug 2026) which blox never supplied — the model had to discover `list_roblox_studios` itself |
| connection | `mcp.bat` launcher; broken whenever a Studio auto-update outdates the bat |
| agent independence | none — capabilities existed only inside the Claude SDK loop |
| `--auto` safety | `bypassPermissions` exposes every tool incl. Bash (allowedTools does not restrict in that mode); the baseline agent used Bash to kill/restart `rojo serve` |
| `blox eval` | scored the agent's own exit status, not the game |

## 2. What the agent actually needs (derived from the loop)

*Inspect → plan → modify → run → observe → diagnose → fix → verify*, unattended:

1. **One reliable channel** to Studio that survives attach races, studio ids, updates.
2. **Deterministic file→Studio sync** with a diff, no human step.
3. **A test runner inside the engine** (edit, server, client) with file:line failures —
   tests accumulate, so re-running them is the regression check.
4. **One-call observed playtests**: readiness, probes on both sides, typed logs,
   screenshot, guaranteed stop.
5. **Structured Luau execution** for inspection (all values, logs, mapped errors,
   fresh modules).
6. **Persistent task state**: goal + acceptance criteria bound to tests, blockers.
7. **An event log** that any UI and any later session can read.
8. **The same contract for every agent** (MCP + CLI), plus a short workflow guide.

## 3. Target architecture (implemented)

```
src/studio/launcher.ts   resolve newest Versions/*/StudioMCP.exe (mcp.bat fallback)
src/studio/session.ts    persistent MCP client: attach polling, studio selection
                         (studio.match / BLOX_STUDIO), studio_id injection, re-attach retry
src/studio/luau.ts       JSON-envelope execution: values, typed logs, line mapping,
                         syntax-error recovery, fresh-require loader (edit)
src/studio/play.ts       start/stop with readiness; LogService log collection + folding
src/sync/push.ts         rojo sourcemap → plan; inventory diff; batched upserts/deletes;
                         world/ builders; anchors; CollectionService tag "BloxManaged";
                         ChangeHistory recording (one undo step)
src/testing/runner.ts    spec discovery, @context, inlined specs + syntax precheck,
                         per-test timeouts, position mapping, playtest logs
src/testing/playtest.ts  composite observed playtest + screenshots → .blox/artifacts
src/state/store.ts       .blox/ events.jsonl, last-*.json, task.json; criteria evaluation
src/tools/registry.ts    THE contract: 13 tools, zod schemas, uniform errors + event log
src/mcp/server.ts        `blox mcp` stdio server (instructions = AGENT_GUIDE)
src/cliTools.ts          same tools as CLI commands; `blox new`, `blox setup <agent>`
src/bridge/bloxBridge.ts same tools in-process for the built-in runner
src/dashboard/           read-only web view over .blox/
src/bench/               agent-agnostic benchmark harness
bench/tasks/             7 tasks: seed, prompt, hidden checks, reference solution
```

Key decisions:

- **Rojo as mapping oracle, blox as transport.** `rojo sourcemap --include-non-scripts`
  decides what each file becomes; blox pushes via `execute_luau`. Keeps Rojo project
  compatibility, removes the plugin/human dependency, makes sync observable.
- **Only tagged instances are deleted.** Hand-built or agent-built geometry is never
  touched; project-declared engine containers (StarterPlayerScripts…) are "anchors",
  ensured but never tagged.
- **World as code** (`world/*.luau` builders) instead of `.model.json` property
  serialization: expressive, diffable, rebuilt on change, survives place reloads.
- **Tests are the completion signal**; LLM judgment (screenshots) supplements visual
  criteria. Criteria bind to tests by name; manual criteria require evidence text.
- **Agent-agnostic core, thin adapters.** MCP for capable agents, CLI for everything
  else, in-process for the built-in runner; no agent-specific logic in the core.
- **Gating narrowed.** In `--ask`, only credit-spending asset generation/insertion is
  gated (via `studio_tool` inner-name inspection). Playtests are the verify loop and
  stay autonomous.
- **Kept, not on the agent path:** dock panel/daemon (now on the blox bridge), auth,
  CCR routing, policy/audit/report/relay, `init`, Electron app. They are working,
  tested, and cost the agent no context. Removing them gains nothing measurable; they
  are documented as peripheral.
- **Deprecated:** the legacy raw-Studio bridge stays only for `--mock` and its unit
  tests; `blox eval` is superseded by `blox bench`.

## 4. Verification levels used in this repo

| level | what | where |
|---|---|---|
| static | `tsc --noEmit` | CI/local |
| unit (mocked Studio) | fake MCP client (`tests/fakeStudio.ts`) for session/luau/registry/runner logic | `npm test` |
| live tool | real Studio, real tools (`scratch/` probes during development; bench `--validate`) | requires Studio |
| end-to-end | an agent builds a game, hidden checks run in a real playtest | `blox bench` |

## 5. Known limitations / next

- Multiplayer: playtests are single-player (Play Solo). `StudioTestService.ExecuteMultiplayerTestAsync`
  needs a plugin-security context; candidate via the blox dock plugin.
- DataStores need a published place with API access; in-Studio tests should mock them.
- Non-script Rojo files (`.model.json`, `.rbxm`) are reported as skipped; use builders.
- CI lane: Open Cloud Luau Execution for edit-context specs without Studio.
- Visual acceptance is still agent-judged from screenshots.
