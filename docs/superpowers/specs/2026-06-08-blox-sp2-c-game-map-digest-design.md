# blox SP2-c — game-map digest (richer context) Design

## 1. Goal

Replace blox's flat startup script dump with a compact, **service-grouped,
type-tagged, bounded** game-map digest, and add system-prompt guidance steering
the agent to filter `search_game_tree` instead of pulling an unfiltered dump.

This is the **lean** slice of SP2 "richer context." The master design
(`docs/superpowers/specs/2026-06-06-blox-design.md` §5) defers a dependency graph
and semantic retrieval to SP2 "added only if context proves a bottleneck." Live
testing (below) showed the bottleneck is **noise and a thin digest**, not missing
graph/retrieval — so those stay deferred.

## 2. Motivation — live evidence

Probed against a real attached Studio (place "Place1", 6 scripts + 1 module,
571 Workspace descendants) using the actual MCP tools the agent uses:

- **Flaw A — noisy/verbose startup tree.** `search_game_tree {}` (default) returns
  **~22 KB of JSON truncated at 200 nodes**, dominated by built-in engine services
  (RunService, GuiService, SoundService, MarketplaceService, …). The agent pays
  tokens to skim ~40 engine services to find a handful of user scripts. Encoding
  repeats keys per node (`parentName`/`fullPath`/`name`/`className`).
- **Flaw B — digest ↔ live disconnect.** `buildDigest` reads **local files only**
  (`default.project.json` + a `.luau`/`.lua` filesystem walk) and emits a **flat,
  sorted path list** with no structure, no script-kind, no grouping.
- **Flaw C — no `require()` dependency edges** (latent; one module here → no pain).
- **Flaw D — no semantic "key systems" summary** (latent; mitigated by capable MCP
  tools at this scale).

The MCP tools are already capable: `search_game_tree` exposes `instance_type`
(IsA filter), `keywords`, `path`, `max_depth` (summarizes beyond depth),
`head_limit` (default 200). So flaw A is best fixed by **using those filters**
(guidance), not by blox eating 22 KB at startup.

**Scope decision:** address the two concrete, evidence-backed flaws (A, B); a
service-grouped/type-tagged map gives a partial D for free. Defer C and full D
until a module-heavy game shows real pain.

## 3. Architecture

All changes live in `src/context/digest.ts` (the digest builder) and
`src/agent/systemPrompt.ts` (rendering + guidance). **No MCP call, no new
module, no live dependency** — the digest stays a pure function of the
filesystem, so it is deterministic, fast, buildable before Studio attaches, and
fully unit-testable.

Data flow is unchanged from today: `cli.ts` → `buildDigest(projectPath)` →
`buildQueryOptions(config, bridge, digest)` → `buildSystemPrompt(digest)`. Only
the digest's **shape** and the prompt's **rendering** change.

### 3.1 Script-kind classification

Derived from the file path suffix (Rojo convention), case-insensitive on
extension:

- `*.server.luau` / `*.server.lua` → `Script (server)`
- `*.client.luau` / `*.client.lua` → `LocalScript (client)`
- otherwise `*.luau` / `*.lua` → `ModuleScript`

`init`-named files (Rojo folder-script convention, e.g. `init.luau`,
`init.server.luau`) classify by the same suffix rule — no special folder-collapse
handling in this slice (noted as out-of-scope nuance, §7).

### 3.2 Service grouping

Each script is grouped by the **service it belongs to**, derived from
`default.project.json` — not from a naive "first path segment" (Rojo layouts use a
source root like `src/`, so the literal first segment is usually `src`, not the
service). Rojo projects map paths in two shapes, both of which occur in real
projects (and the repo fixture uses the second):

- a service declares a directory `$path` (e.g.
  `"ReplicatedStorage": { "$path": "src/shared" }`), or
- a service nests named children that each declare a `$path`, possibly pointing
  directly at a file (the fixture:
  `"ReplicatedStorage": { "Greeter": { "$path": "src/ReplicatedStorage/Greeter.luau" } }`).

To handle both, `buildDigest` **recursively walks `proj.tree`** and collects every
`$path` it finds, each tagged with its **top-level service ancestor** (the
`proj.tree` key under `$className: DataModel` whose subtree contains that
`$path`). This yields a list of `{ service, prefix }` mappings, where `prefix` is
either a file path (exact match) or a directory (prefix match).

A script is assigned to the service of the **longest matching `prefix`** (exact
file match counts as the most specific). A script matching no mapping falls into a
`(root)` group. Groups are ordered by the order their service keys appear in
`proj.tree`, with `(root)` and any unknown groups last (alphabetical); scripts
within a group are sorted by path.

The grouping helper is pure: it takes the script path list and the collected
`{ service, prefix }` mappings as inputs, so it is unit-testable on synthetic
input without a temp filesystem (§8).

### 3.3 Bounding (large games)

To keep the prompt bounded regardless of game size:

- Each group lists at most `MAX_PER_GROUP` (= 30) scripts; the remainder is
  summarized as one line: `… +K more (use script_search / glob to list)`.
- The group's count line always shows the true total (e.g. `(42 scripts)`), so a
  truncated group is visibly truncated.

No global cap beyond the per-group cap in this slice; per-group bounding is
sufficient for the observed scale and keeps the rule simple.

## 4. Data shape

```typescript
export type ScriptKind = 'Script (server)' | 'LocalScript (client)' | 'ModuleScript';

export interface ScriptEntry {
  path: string;       // project-relative, as today
  kind: ScriptKind;
}

export interface ScriptGroup {
  service: string;        // e.g. 'ReplicatedStorage', or '(root)'
  scripts: ScriptEntry[]; // sorted by path; already truncated to MAX_PER_GROUP
  total: number;          // true count before truncation
}

export interface ProjectDigest {
  name: string;
  tree: string[];          // top-level services (unchanged)
  scripts: string[];       // RETAINED: flat path list (back-compat, see §4.1)
  groups: ScriptGroup[];   // NEW: grouped, type-tagged, bounded
}
```

### 4.1 Back-compat

`scripts: string[]` is **retained** (full, untruncated flat list) so nothing that
reads it breaks and so a single source of truth for "all script paths" exists.
`groups` is additive. `buildSystemPrompt` switches to rendering `groups`.

## 5. Rendered prompt format

`buildSystemPrompt` replaces the current trailing block:

```
Project: <name>
Top-level tree: <services>
Scripts (<n>):
  <flat path>
  ...
```

with:

```
Project: <name>
Top-level tree: <services>
Game map (<total> scripts):
  <service>/  (<n> <noun>)
    <basename> — <kind>
    … +K more (use script_search / glob to list)
  <service>/  (<n> <noun>)
    ...
```

- `<noun>` is a human count label: `module`/`modules`, `server script(s)`,
  `client script(s)`, or mixed → `scripts`. Keep it simple: if a group is all one
  kind use that kind's noun, else `scripts`.
- `<basename>` is the file's basename (the `<service>/` header already gives
  location); the full relative path remains available to the agent via the
  retained flat list mindset and the file tools.
- Empty project (no scripts): render `Game map (0 scripts): (none)`.

The exact wording is fixed by the tests in §6 (substrings `Game map`,
`ModuleScript`, `Script (server)`, `LocalScript (client)`).

## 6. System-prompt guidance (flaw A)

Add a short "Game context" block to `buildSystemPrompt` (near the existing
project/tree rendering, before the digest map or right after the rules):

- The digest above lists the on-disk scripts (what you edit). For **live game
  structure** (instances, models, GUIs, parts), use `search_game_tree`.
- Always **filter** `search_game_tree`: pass `instance_type` (IsA, e.g.
  `BasePart`, `Model`, `BaseScript`), `keywords`, and/or a `path` start point, and
  keep `max_depth` small. An unfiltered call returns ~200 nodes dominated by
  built-in engine services and is truncated — filter to user content instead.
- Use `inspect_instance` for one instance's properties/children on demand.

Required substrings for the test: `search_game_tree`, `instance_type`, `filter`.

## 7. Out of scope (deferred)

- **Dependency graph (flaw C):** parsing `require()` edges from sources. Deferred
  until a module-heavy game proves the need.
- **Semantic retrieval / vector index (flaw D):** no embedding, no index.
- **Live-DataModel digest via MCP:** the digest stays filesystem-only this slice.
- **Non-Rojo place onboarding:** a place with no local files (e.g. "Place1") still
  yields an empty digest; non-Rojo onboarding is SP4 scope.
- **`init.luau` folder-collapse nuance:** classified by suffix only, not folded
  into its parent folder's name.
- **Per-system "what it does" summaries:** beyond the kind/grouping map.

## 8. Testing

Pure-filesystem unit tests (no live Studio), in `tests/digest.test.ts` (new or
existing) and `tests/systemPrompt.test.ts`:

1. **Kind classification:** `.server.luau` → `Script (server)`, `.client.luau` →
   `LocalScript (client)`, `.luau` → `ModuleScript` (and `.lua` variants).
2. **Service grouping:** scripts grouped by the service whose `$path` (from
   `default.project.json`) is the longest matching prefix; group order follows the
   `proj.tree` key order with `(root)`/unknown last; `(root)` fallback for a script
   matching no service `$path`.
3. **Bounding:** a group with > `MAX_PER_GROUP` scripts truncates the listed
   entries, shows the true total, and emits the `… +K more` line.
4. **Back-compat:** `digest.scripts` still holds the full flat list.
5. **Empty project:** no scripts → `groups` empty, renders `(none)`.
6. **Rendered prompt:** `buildSystemPrompt` output contains `Game map`,
   `ModuleScript`, `Script (server)`, `LocalScript (client)`, and the §6 guidance
   substrings (`search_game_tree`, `instance_type`, `filter`).

A small fixture (a few scripts across two services, plus an oversized group for
bounding) can be built with a temp dir or by exercising the classification/
grouping/render helpers directly on synthetic path lists — prefer testing the
pure helpers on synthetic input so no temp filesystem is required.

Full-suite verification: `npm test` (all unit pass, gated live tests skip),
`npx tsc -p tsconfig.json --noEmit`, `npm run build` → `dist/cli.js`.

## 9. Success criteria

1. `ProjectDigest` carries `groups` (service-grouped, type-tagged, per-group
   bounded) while retaining `scripts` (flat, back-compat).
2. Script kind is correctly derived from suffix for server/client/module.
3. `buildSystemPrompt` renders the grouped game map and the filtered-tree
   guidance; the §6/§8 substrings are present.
4. Large groups are bounded with a visible truncation line and true totals.
5. All unit tests pass; tsc clean; build produces `dist/cli.js`. No live test
   added (the digest is pure filesystem).
