# blox SP4-b — Non-Rojo Onboarding

**Date:** 2026-06-09
**Status:** Design approved → ready for implementation planning

## 1. Context

SP4-b is the second slice of SP4 (polish), decomposed in the SP4-a spec §1
(A autonomy controls — shipped; **B non-Rojo onboarding — THIS SPEC**; C rich TUI;
D Studio dock panel). A/B/D are mutually independent.

Today blox only works on games that already have a Rojo project. `buildDigest`
(`src/context/digest.ts`) **throws** `No default.project.json in <dir>` when the
project file is missing, and `syncProject` / `ensureServe` both shell out to
`rojo`. A game whose scripts live only in the live Studio DataModel — with no
local files and no `default.project.json` — cannot run blox at all. (This is the
"Place1 is non-Rojo → empty digest → outside blox model" gap noted during SP2-c.)

**Goal:** a one-shot `blox init` that pulls the live DataModel's scripts into a
Rojo project on disk (files + `default.project.json`), so the normal blox loop
(edit `.luau` → rojo serve → verify → commit) works afterward.

## 2. Scope

**In scope:** pull **scripts only** (Script / LocalScript / ModuleScript) from the
attached Studio into Rojo-convention `.luau` files, generate a service→directory
`default.project.json`, and commit a baseline.

**Out of scope (hybrid model, per master design):** non-script instances stay
DataModel-first — onboarding does not serialize Parts/Models/GUIs/Values. Two-way
sync, asset pulling, and multi-place games remain out of scope.

**Decided defaults** (from design review):
- Subcommand name: **`blox init`**.
- `--on-conflict` default: **`abort`** (never silently mangle names).
- Baseline: **`git init` (if needed) + commit** the pulled state.

## 3. Pull mechanism — deterministic, not agent-driven

The bulk copy is mechanical, so blox does it directly through the existing
MCP-client seam (the one `doctor` uses), not via the agent. `blox init` runs **one**
`execute_luau` whose Luau walks the DataModel and returns every
`LuaSourceContainer` as JSON:

```
[ { "fullName": "ServerScriptService.Systems.Combat",
    "className": "Script",
    "source": "..." }, ... ]
```

`fullName` comes from `Instance:GetFullName()`; `className` is one of
`Script` / `LocalScript` / `ModuleScript`; `source` is `.Source`. The walk
collects descendants of the DataModel that `:IsA("LuaSourceContainer")`.

This reuses `probeExecuteLuau(launch, code, factory?, opts?)` from `src/doctor.ts`
(connect + attach-retry + close, with the same `McpClientFactory` injection used
in doctor tests), so the pull is unit-testable against a canned dump and needs no
live Studio in CI.

**Known limitation:** the single dump assumes the whole payload fits inside one
`execute_luau` text result. A chunked / per-script (`script_read`) fallback for
very large games is deferred.

## 4. DataModel → filesystem mapping (`layout.ts`, pure)

`planLayout(scripts: PulledScript[], strategy: 'abort' | 'suffix')` returns
`{ files: WriteFile[]; project: ProjectJson; conflicts: Conflict[]; renamed: Renamed[] }`.
It is a pure function — the core of the slice and the bulk of the tests.

**Class → filename suffix:** `Script` → `.server.luau`, `LocalScript` →
`.client.luau`, `ModuleScript` → `.luau`.

**Path:** `fullName.split('.')` → first segment is the service, the rest are
ancestor instance names → directories, last is the script. e.g.
`ServerScriptService.Systems.Combat` (a `Script`) →
`src/ServerScriptService/Systems/Combat.server.luau`.

**Scripts with child scripts (Rojo `init` convention):** if script A's `fullName`
is a strict prefix of another script's `fullName` (A has script descendants), A
becomes a directory and its body goes to `A/init<suffix>.luau` (e.g.
`init.server.luau` for a `Script`, `init.luau` for a `ModuleScript`); its
descendants are written inside `A/`.

**Filename sanitization:** characters illegal in filenames (`/ \ : * ? " < > |`
and control chars) in instance names are replaced with `_`. A sanitized name that
collides with a sibling is treated as a conflict (below).

**Conflicts** (two scripts resolving to the same file path — duplicate sibling
names, which Roblox allows but the filesystem does not, or post-sanitize
collisions):
- `strategy = 'abort'` (default): every colliding script is recorded in
  `conflicts[]`; the writer writes **nothing** (atomic — no half-onboarded tree).
- `strategy = 'suffix'`: colliding files get `_2`, `_3`, … appended before the
  suffix; each rename is recorded in `renamed[]` and everything is written.

**`default.project.json`:** service→directory mapping for each service that has at
least one script:

```json
{
  "name": "<place name or 'blox-game'>",
  "tree": {
    "$className": "DataModel",
    "ServerScriptService": { "$path": "src/ServerScriptService" },
    "ReplicatedStorage":    { "$path": "src/ReplicatedStorage" }
  }
}
```

Rojo's filename conventions then re-create Scripts/LocalScripts/ModuleScripts and
Folders from the directory tree. Subfolders project as Rojo `Folder` instances —
the original container's class is lossy, which is accepted under the hybrid model
(scripts are canonical; non-script instances are not).

## 5. Write + baseline (`write.ts`)

`writePlan(projectPath, plan, opts)`:
1. If `default.project.json` already exists and `--force` is not set → refuse
   (do not clobber an existing Rojo setup); return an error for the report.
2. If `plan.conflicts` is non-empty and strategy is `abort` → write nothing;
   return so the report lists the conflicts.
3. Otherwise `mkdir -p` and write each `WriteFile` plus `default.project.json`.
4. Baseline: `git init` if the dir is not already a repo, then `commitChanges`
   (reused from `src/git/commit.ts`) with message `blox: onboard <name> from Studio`.

Git is shelled out through the same injectable `SpawnFn` seam `commitChanges`
already uses, so the writer is testable in a tmpdir without a real Studio.

## 6. Command + data flow

`blox init [--project <dir>] [--on-conflict abort|suffix] [--force] [--mock]`

```
blox init --project /game
  → connect MCP client (doctor seam) → execute_luau DataModel walk → JSON dump
  → parse → PulledScript[]
  → planLayout(scripts, strategy) → { files, project, conflicts, renamed }
  → conflicts && strategy==abort: formatOnboardReport(conflicts), exit 1, write nothing
  → else writePlan(...) → files + default.project.json + git baseline commit
  → formatOnboardReport: N scripts across M services, K renamed, baseline sha,
    "next: run `rojo serve` + click Connect in Studio, then `blox \"<prompt>\"`"
```

`--mock` swaps in the mock bridge's launch + a canned dump so the whole flow is
exercisable without Studio (mirrors how `--mock` works for runs).

## 7. Error handling

- No Studio attached → doctor-style attach-retry, then a clear "no attached
  Studio" error (exit non-zero).
- Empty dump (no scripts) → "nothing to onboard" report, exit 0, write nothing.
- `execute_luau` error or unparseable dump → surfaced in the report, exit non-zero,
  write nothing.
- Existing `default.project.json` without `--force` → refuse, exit non-zero.

## 8. Components (all small, isolated)

| File | Responsibility | Action |
|------|----------------|--------|
| `src/onboard/pull.ts` | Run the DataModel-walk `execute_luau` via the doctor seam; parse JSON → `PulledScript[]`. The Luau dump is a const here. | Create |
| `src/onboard/layout.ts` | Pure `planLayout` — class→suffix, path mapping, `init` folders, sanitize, conflict abort/suffix, `default.project.json`. | Create |
| `src/onboard/write.ts` | `writePlan` — refuse-on-existing, atomic-on-abort, mkdir+write, git init + baseline commit. | Create |
| `src/onboard/report.ts` | `formatOnboardReport` — counts, renamed, conflicts, next steps. | Create |
| `src/args.ts` | Parse `init` subcommand + `--on-conflict` / `--force`. | Modify |
| `src/cli.ts` | `init` branch: pull → plan → write → report; exit codes. | Modify |

## 9. Testing

- **`layout.ts` (bulk):** class→suffix for all 3 kinds; nesting→dirs; `init.luau`
  folder for a script with a script child; filename sanitization; conflict
  detection with `abort` (collected, nothing written) vs `suffix` (disambiguated +
  renamed recorded); `default.project.json` shape (one entry per script-bearing
  service).
- **`pull.ts`:** a mocked `McpClientFactory` returns a canned `execute_luau` JSON
  dump → assert `PulledScript[]`; malformed dump → error.
- **`write.ts`:** write to a tmpdir → assert files + `default.project.json` on
  disk; refuse when project.json exists and `--force` unset; abort strategy with
  conflicts writes nothing; baseline commit via an injected `SpawnFn`.
- **`args.ts`:** `init` parse + flag validation (`--on-conflict` ∈ {abort,suffix}).
- **Gated live e2e** (`BLOX_LIVE_ONBOARD=1`): `blox init` against a real attached
  place → assert files written and `buildDigest` then succeeds (no throw).

## 10. Non-goals

- Two-way sync; pulling non-script instances; asset pulling; multi-place.
- Chunked / per-script dump fallback for oversized games.
- Interactive conflict resolution (needs the slice-C TTY surface; `--on-conflict`
  + re-run is the one-shot substitute).

## 11. Open items for the plan phase

- Confirm the exact `LuaSourceContainer` walk handles the DataModel root and
  service nodes (services are children of `game`); verify `GetFullName()` starts
  at the service (not `game.`), and strip a leading `game.` if present.
- Confirm `execute_luau` returns the dump as a single text block in
  `LuauProbeResult` and pin its field name when writing the plan.
