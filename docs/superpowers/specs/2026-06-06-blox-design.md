# blox — Agentic Coding Tool for Roblox Studio

**Date:** 2026-06-06
**Status:** Design approved → ready for implementation planning
**Author:** tashany@gmail.com (with Claude)

## 1. Vision

`blox` is an agentic coding tool for Roblox Studio — like Claude Code/Codex, but
specialized for Roblox. It writes Luau code, has context of the entire game,
playtests the game and fixes issues automatically, and can generate prototype
assets. It is built from first principles on the Model Context Protocol (MCP) and
the Claude Agent SDK, not by copying existing products (Lemonade.gg, Roblox's own
in-Studio Assistant). The goal is a higher-quality, more efficient, superior tool.

The defining challenge of Roblox is that a "codebase" is not just files. A Roblox
game is a live **DataModel**: a tree of Instances (Parts, Models, GUIs) with Luau
scripts embedded as Script/LocalScript/ModuleScript objects, plus asset-ID
references (meshes, sounds, images). `blox` must work across both code and the
live game tree, and over assets.

### Product intent

- **Type:** A serious personal power-tool — high quality, daily use on real
  games. Not a commercial multi-tenant product (no billing, auth, marketing-grade
  UX in scope).
- **Surface:** External CLI/TUI first (Claude Code style). A Studio dock panel may
  be added later; the agent brain never moves.

## 2. Differentiation

Roblox now ships its **own** in-Studio Assistant + built-in MCP server + playtest
subagent. That — not just Lemonade — is the real competitor. `blox` wins on:

- **Filesystem-first + git.** Scripts are real `.luau` files (Rojo sync), so git,
  diffs, grep, and normal file tools all work. Competitors are DataModel-only.
- **The brain.** Claude Opus 4.8 with adaptive thinking and high/xhigh effort,
  orchestrated by the Claude Agent SDK (subagents, hooks, permissions).
- **Whole-game context** assembled from both the filesystem and the live DataModel.
- **CLI orchestration ergonomics** the in-Studio Assistant cannot match.

## 3. Architecture

A local CLI ("the brain") drives a thin Studio plugin over MCP, with scripts
living as files synced by Rojo. The topology is largely forced by how the Studio
MCP works: an MCP server bridges an MCP **client** (the agent brain) to a Studio
**plugin** that executes inside Studio. Studio plugins are sandboxed Luau (no
filesystem, no git), so the brain must live outside Studio. Hence: **external
brain + thin Studio plugin**.

| # | Component | Role |
|---|-----------|------|
| 1 | **blox CLI/TUI** | Chat surface + orchestrator. Built on the **Claude Agent SDK** (Opus 4.8, adaptive thinking, effort high/xhigh). Owns the agent loop, subagents, permissions, hooks. Language: **TypeScript** (Agent SDK first-class, strong CLI ecosystem, MCP-native). |
| 2 | **Sync layer** | `.luau` files ↔ Studio DataModel via **Rojo** (`default.project.json`). Files are canonical; Rojo one-way pushes files → Studio. Git tracks the project. |
| 3 | **Studio bridge (MCP)** | The Agent SDK is the MCP client → official **Roblox Studio MCP** server + plugin (stdio transport, no auth, local-only). Wrapped behind a `blox` interface so a thin custom plugin can fill gaps without rewrites. |
| 4 | **Game context provider** | Whole-game context = (a) filesystem scripts via file/grep/glob, (b) live DataModel via the MCP's `search_game_tree` / `inspect_instance` / `explore_subagent`, (c) lazy detail fetch, (d) a cached project digest (services, places, key systems). |
| 5 | **Verify/playtest loop** | Two tiers: fast **headless code tests** (`execute_luau` / `run_script_in_play_mode`, capture errors) for the inner loop; full **play sessions** (`start_stop_play` + `console_output`, `playtest_subagent`) for gameplay/physics/replication. Bounded autonomous fix loop. |
| 6 | **Asset generation (thin)** | Orchestrate the MCP asset tools: `generate_mesh`, `generate_material`, `generate_procedural_model`, `insert_from_creator_store`. No custom asset subsystem in MVP. |

### Official Studio MCP tool surface (what we build on)

- **Scripts:** `script_read`, `multi_edit`, `script_search`, `script_grep`
- **Asset/content gen:** `generate_mesh`, `generate_material`,
  `generate_procedural_model`, `insert_from_creator_store`
- **DataModel:** `search_game_tree`, `inspect_instance`, `explore_subagent`
- **Luau:** `execute_luau` / `run_code`
- **Playtest:** `start_stop_play`, `run_script_in_play_mode`, `console_output`,
  `screen_capture`, `playtest_subagent`
- **Input sim:** `character_navigation`, `keyboard_input`, `mouse_input`
- **Session:** `list_roblox_studios`, `set_active_studio`

Because the MCP already covers DataModel, run, playtest, and assets, the custom
plugin work shrinks to true gaps only (and may be zero for MVP).

### Script-edit reconciliation

Files stay canonical. The agent edits `.luau` files on disk; Rojo one-way pushes
to Studio. The MCP's `multi_edit` / `script_read` are kept as a **fallback/reader**
for scripts that exist in Studio but are not in the Rojo project. This avoids
two-way sync conflicts and keeps git authoritative.

## 4. Task lifecycle (data flow)

```
user prompt
  → agent plans (Opus 4.8)
  → reads context (files + DataModel map via MCP)
  → edits .luau files
  → Rojo syncs to Studio
  → headless tests via MCP (execute_luau / run_script_in_play_mode)
  → (if gameplay) play session via StudioTestService / start_stop_play
  → reads logs / errors
  → bounded fix loop (re-edit → re-sync → re-test)
  → git commit + report
```

## 5. Context strategy

**Lazy navigation, not pre-embedding** — the Claude Code model, adapted to Roblox.
The agent gets a cached project digest, the live DataModel tree via the MCP, and
tools to grep scripts / fetch a script's source / inspect an instance on demand.
No vector DB in MVP — Opus 4.8 plus good tools navigate better than a stale index.
Semantic retrieval and a dependency graph are deferred to SP2, added only if
context proves a bottleneck.

## 6. Verify/playtest loop

Two tiers:

1. **Headless code tests (inner loop, fast, fully automated):** run Luau in Studio
   via `execute_luau` / `run_script_in_play_mode` — load modules, exercise
   functions, assert, and capture errors/output. No human needed.
2. **Play sessions (gameplay/physics/replication):** `start_stop_play` /
   StudioTestService, with `console_output` capture and optionally
   `playtest_subagent` for scenario automation.

**Autonomy: bounded autonomous loop.** The agent runs playtests, reads errors,
fixes, and re-tests on its own — but capped by max iterations and a token budget
(Opus 4.8 `task_budget`), and it stops to ask when stuck, making risky changes, or
out of budget. Per-run override is a later nicety, not MVP.

## 7. Scope: decomposition into sub-projects

Each sub-project gets its own spec → plan → implementation cycle.

- **SP1 — Core agentic code loop (THIS SPEC / MVP).** See §8.
- **SP2 — Richer context.** Dependency graph, semantic game map, retrieval; the
  `screen_capture` + Opus vision visual-verify tier and input-sim scenarios.
- **SP3 — Asset pipeline.** Iteration, asset libraries, prototype→final quality
  beyond the thin MVP tool orchestration.
- **SP4 — Polish.** Rich TUI, optional Studio dock panel surface, onboarding for
  non-Rojo games, per-run autonomy controls.

## 8. SP1 — MVP scope (the first thing to build)

**Goal:** prove `prompt → code → playtest → fix → commit` end-to-end on one real,
existing Rojo-managed game, with basic asset generation available.

**In scope:**

- `blox` CLI on the Claude Agent SDK (Opus 4.8, adaptive thinking, effort
  high/xhigh), TypeScript.
- Studio bridge: Agent SDK as MCP client to the official Roblox Studio MCP (stdio),
  behind a `blox` interface abstraction.
- Rojo sync: files canonical, one-way push files → Studio; git.
- Game context: filesystem (file/grep/glob) + DataModel map via MCP
  (`search_game_tree` / `inspect_instance` / `explore_subagent`) + lazy detail +
  cached project digest.
- Code editing: edit `.luau` files; Rojo syncs.
- Asset gen (thin): expose `generate_mesh` / `generate_material` /
  `generate_procedural_model` / `insert_from_creator_store` as agent tools.
- Verify loop: tier 1 headless + tier 2 play sessions; bounded autonomous fix loop
  (max iterations + `task_budget`), stop-to-ask on stuck/risky.
- Output: git commit + run report.

**Out of scope for MVP** (later sub-projects): heavy asset pipeline (SP3);
dedicated visual-verify tier + input-sim scenarios (SP2); rich TUI and Studio dock
panel (SP4); multi-place games; non-Rojo onboarding; dependency-graph/semantic
context (SP2); per-run autonomy controls (SP4).

## 9. Key technical decisions

- **Brain stack:** Claude Agent SDK + custom Roblox layer (not a from-scratch loop,
  not a model-agnostic framework, not just pointing an existing client at the MCP).
- **Model:** `claude-opus-4-8`, adaptive thinking, effort high/xhigh for the main
  agent; cheap `claude-haiku-4-5` subagents for fan-out exploration.
- **Source of truth:** hybrid — scripts as files (Rojo), instances live in the
  DataModel via MCP.
- **Studio MCP:** start on the official built-in server; abstract behind an
  interface; add a thin custom plugin only for gaps.
- **Language:** TypeScript.

## 10. Top risks & mitigations

- **MCP tool-surface gaps** (e.g., precise StudioTestService hooks) → thin-plugin
  escape hatch behind the bridge abstraction.
- **Rojo round-trip for non-script instances is lossy** → that is *why* instances
  stay DataModel-first; only scripts are filesystem-canonical.
- **Flaky gameplay tests** → headless tier first for the tight loop; play sessions
  second.
- **No auth on the Studio MCP (stdio, trust-based)** → local-only; never expose the
  bridge over a network.
- **Runaway auto-fix sessions** → bounded loop with max iterations + `task_budget`
  + stop-to-ask.

## 11. Open questions for later sub-projects

- Exact custom-plugin needs (if any) once SP1 hits the official MCP's limits.
- Whether two-way Rojo sync is ever worth the conflict risk.
- Asset-pipeline quality bar for SP3 (prototype vs final).
