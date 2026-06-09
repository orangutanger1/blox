# blox SP2-c — game-map digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace blox's flat startup script dump with a compact, service-grouped, type-tagged, bounded game-map digest, and steer the agent (via system prompt) to filter `search_game_tree` instead of pulling an unfiltered ~22 KB dump.

**Architecture:** All work is in `src/context/digest.ts` (pure filesystem helpers + the `ProjectDigest` shape) and `src/agent/systemPrompt.ts` (rendering + guidance). No MCP call, no live dependency — the digest stays a deterministic, unit-testable function of the filesystem. Pure helpers (`classifyKind`, `collectServicePaths`, `groupScripts`) are exported and tested on synthetic input; `buildDigest` wires them; `buildSystemPrompt` renders `groups`.

**Tech Stack:** TypeScript/ESM, Node ≥20, vitest, `node:fs`/`node:path`.

**Spec:** `docs/superpowers/specs/2026-06-08-blox-sp2-c-game-map-digest-design.md`

---

## File Structure

- Modify `src/context/digest.ts` — new `ScriptKind`/`ScriptEntry`/`ScriptGroup` types + `groups` on `ProjectDigest`; new pure exports `classifyKind`, `collectServicePaths`, `groupScripts`, consts `MAX_PER_GROUP`/`ROOT_GROUP`; `buildDigest` wires them. Retains `scripts: string[]`.
- Modify `src/agent/systemPrompt.ts` — render the grouped game map + add the "Game context" filtered-tree guidance block.
- Modify `tests/digest.test.ts` — unit tests for the new helpers + `buildDigest` groups; keep the existing fixture assertions.
- Modify `tests/systemPrompt.test.ts` — expand the fixture digest to all three kinds; assert the new substrings.
- Modify `tests/buildOptions.test.ts` — add `groups: []` to its `ProjectDigest` literal (new required field).

**Ordering note:** the `groups` field becomes a required `ProjectDigest` member in Task 4. `tests/buildOptions.test.ts` and `tests/systemPrompt.test.ts` construct `ProjectDigest` literals and will stop typechecking until updated — those updates land in Task 4 (buildOptions) and Task 5 (systemPrompt). Run the full `tsc` only in Task 6.

---

## Task 1: Script-kind classification + types

**Files:**
- Modify: `src/context/digest.ts`
- Test: `tests/digest.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/digest.test.ts`, add `classifyKind` to the existing import and add a new `describe` block. The current import line is:

```typescript
import { buildDigest } from '../src/context/digest.js';
```

Change it to:

```typescript
import { buildDigest, classifyKind } from '../src/context/digest.js';
```

Then add this block after the existing `describe('buildDigest', ...)` block:

```typescript
describe('classifyKind', () => {
  it('maps .server.luau/.lua to a server Script', () => {
    expect(classifyKind('src/ServerScriptService/Hello.server.luau')).toBe('Script (server)');
    expect(classifyKind('a/B.server.lua')).toBe('Script (server)');
  });

  it('maps .client.luau/.lua to a LocalScript', () => {
    expect(classifyKind('src/StarterPlayer/Controls.client.luau')).toBe('LocalScript (client)');
    expect(classifyKind('a/B.client.lua')).toBe('LocalScript (client)');
  });

  it('maps a plain .luau/.lua to a ModuleScript', () => {
    expect(classifyKind('src/ReplicatedStorage/Greeter.luau')).toBe('ModuleScript');
    expect(classifyKind('a/B.lua')).toBe('ModuleScript');
  });

  it('is case-insensitive on the extension', () => {
    expect(classifyKind('A.SERVER.LUAU')).toBe('Script (server)');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest.test.ts`
Expected: FAIL — `classifyKind` is not exported (import error / not a function).

- [ ] **Step 3: Write minimal implementation**

In `src/context/digest.ts`, replace the existing `ProjectDigest` interface block (lines 4–8, the `export interface ProjectDigest { name; tree; scripts; }`) with the new types and add `classifyKind` + consts. The top of the file becomes:

```typescript
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

export type ScriptKind = 'Script (server)' | 'LocalScript (client)' | 'ModuleScript';

export interface ScriptEntry {
  path: string; // project-relative, as today
  kind: ScriptKind;
}

export interface ScriptGroup {
  service: string;        // e.g. 'ReplicatedStorage', or ROOT_GROUP
  scripts: ScriptEntry[]; // sorted by path; truncated to MAX_PER_GROUP
  total: number;          // true count before truncation
}

export interface ProjectDigest {
  name: string;
  tree: string[];
  scripts: string[];     // retained flat path list (back-compat)
  groups: ScriptGroup[]; // grouped, type-tagged, bounded
}

// Max scripts listed per service group; the overflow is summarized.
export const MAX_PER_GROUP = 30;

// Group name for scripts matching no service $path mapping.
export const ROOT_GROUP = '(root)';

// Classify a script by its Rojo filename suffix (case-insensitive extension).
export function classifyKind(path: string): ScriptKind {
  const lower = path.toLowerCase();
  if (lower.endsWith('.server.luau') || lower.endsWith('.server.lua')) return 'Script (server)';
  if (lower.endsWith('.client.luau') || lower.endsWith('.client.lua')) return 'LocalScript (client)';
  return 'ModuleScript';
}
```

NOTE: leave `walkLuau` and `buildDigest` as they are for now — `buildDigest` does not yet set `groups`, so it will not typecheck against the new interface until Task 4. The unit tests for `classifyKind` (Step 1) do not exercise `buildDigest`, so `npx vitest run tests/digest.test.ts` can still run the `classifyKind` block. Do NOT run the full `tsc` in this task.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/digest.test.ts -t classifyKind`
Expected: PASS — all four `classifyKind` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/context/digest.ts tests/digest.test.ts
git commit -m "feat: script-kind classification + digest group types"
```

---

## Task 2: Collect service→path mappings from the project tree

**Files:**
- Modify: `src/context/digest.ts`
- Test: `tests/digest.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/digest.test.ts`, add `collectServicePaths` (and the `ServicePath` type is not needed in the test) to the import:

```typescript
import { buildDigest, classifyKind, collectServicePaths } from '../src/context/digest.js';
```

Add this block after the `classifyKind` describe:

```typescript
describe('collectServicePaths', () => {
  it('collects a top-level service directory $path', () => {
    const tree = {
      $className: 'DataModel',
      ReplicatedStorage: { $className: 'ReplicatedStorage', $path: 'src/shared' },
    };
    expect(collectServicePaths(tree)).toEqual([
      { service: 'ReplicatedStorage', prefix: 'src/shared' },
    ]);
  });

  it('collects nested child $path tagged with its top-level service (fixture shape)', () => {
    const tree = {
      $className: 'DataModel',
      ReplicatedStorage: {
        $className: 'ReplicatedStorage',
        Greeter: { $path: 'src/ReplicatedStorage/Greeter.luau' },
      },
      ServerScriptService: {
        $className: 'ServerScriptService',
        Hello: { $path: 'src/ServerScriptService/Hello.server.luau' },
      },
    };
    expect(collectServicePaths(tree)).toEqual([
      { service: 'ReplicatedStorage', prefix: 'src/ReplicatedStorage/Greeter.luau' },
      { service: 'ServerScriptService', prefix: 'src/ServerScriptService/Hello.server.luau' },
    ]);
  });

  it('normalizes backslashes and trailing slashes', () => {
    const tree = { $className: 'DataModel', Foo: { $path: 'src\\\\foo\\\\' } };
    expect(collectServicePaths(tree)).toEqual([{ service: 'Foo', prefix: 'src/foo' }]);
  });

  it('ignores $-keys as service names', () => {
    const tree = { $className: 'DataModel', $ignoreUnknownInstances: true };
    expect(collectServicePaths(tree)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest.test.ts -t collectServicePaths`
Expected: FAIL — `collectServicePaths` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/context/digest.ts`, add this after `classifyKind` (and before `walkLuau`):

```typescript
export interface ServicePath {
  service: string;
  prefix: string; // a file path (exact match) or a directory (prefix match)
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

// Recursively collect every $path in the project tree, each tagged with its
// top-level service ancestor (the DataModel child key it lives under).
export function collectServicePaths(tree: Record<string, unknown>): ServicePath[] {
  const out: ServicePath[] = [];
  for (const [key, val] of Object.entries(tree)) {
    if (key.startsWith('$')) continue;
    walkService(key, val, out);
  }
  return out;
}

function walkService(service: string, node: unknown, out: ServicePath[]): void {
  if (node === null || typeof node !== 'object') return;
  const rec = node as Record<string, unknown>;
  const p = rec['$path'];
  if (typeof p === 'string') out.push({ service, prefix: normalizePath(p) });
  for (const [k, v] of Object.entries(rec)) {
    if (k.startsWith('$')) continue;
    walkService(service, v, out);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/digest.test.ts -t collectServicePaths`
Expected: PASS — all four `collectServicePaths` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/context/digest.ts tests/digest.test.ts
git commit -m "feat: collect service path mappings from project tree"
```

---

## Task 3: Group scripts by service, with bounding

**Files:**
- Modify: `src/context/digest.ts`
- Test: `tests/digest.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/digest.test.ts`, add `groupScripts` and `MAX_PER_GROUP` to the import:

```typescript
import {
  buildDigest, classifyKind, collectServicePaths, groupScripts, MAX_PER_GROUP,
} from '../src/context/digest.js';
```

Add this block after the `collectServicePaths` describe:

```typescript
describe('groupScripts', () => {
  const mappings = [
    { service: 'ReplicatedStorage', prefix: 'src/ReplicatedStorage' },
    { service: 'ServerScriptService', prefix: 'src/ServerScriptService' },
  ];
  const order = ['ReplicatedStorage', 'ServerScriptService'];

  it('groups scripts by longest matching prefix and tags kind', () => {
    const groups = groupScripts(
      ['src/ServerScriptService/Hello.server.luau', 'src/ReplicatedStorage/Greeter.luau'],
      mappings,
      order,
    );
    expect(groups).toEqual([
      {
        service: 'ReplicatedStorage',
        total: 1,
        scripts: [{ path: 'src/ReplicatedStorage/Greeter.luau', kind: 'ModuleScript' }],
      },
      {
        service: 'ServerScriptService',
        total: 1,
        scripts: [{ path: 'src/ServerScriptService/Hello.server.luau', kind: 'Script (server)' }],
      },
    ]);
  });

  it('puts unmatched scripts in the (root) group, ordered last', () => {
    const groups = groupScripts(['loose/Thing.luau', 'src/ReplicatedStorage/A.luau'], mappings, order);
    expect(groups.map((g) => g.service)).toEqual(['ReplicatedStorage', '(root)']);
  });

  it('prefers the longest (most specific) matching prefix', () => {
    const m = [
      { service: 'Shared', prefix: 'src' },
      { service: 'Net', prefix: 'src/net' },
    ];
    const groups = groupScripts(['src/net/Remote.luau'], m, ['Shared', 'Net']);
    expect(groups[0]).toMatchObject({ service: 'Net', total: 1 });
  });

  it('bounds a group at MAX_PER_GROUP and reports the true total', () => {
    const many = Array.from({ length: MAX_PER_GROUP + 5 }, (_, i) =>
      `src/ReplicatedStorage/M${String(i).padStart(2, '0')}.luau`);
    const groups = groupScripts(many, mappings, order);
    expect(groups[0].total).toBe(MAX_PER_GROUP + 5);
    expect(groups[0].scripts).toHaveLength(MAX_PER_GROUP);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest.test.ts -t groupScripts`
Expected: FAIL — `groupScripts` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/context/digest.ts`, add this after `walkService` (and before `walkLuau`):

```typescript
// Group scripts by the service of their longest-matching $path prefix.
// Pure: takes the script list, the collected mappings, and the service order.
export function groupScripts(
  scripts: string[],
  mappings: ServicePath[],
  serviceOrder: string[],
): ScriptGroup[] {
  const sorted = [...mappings].sort((a, b) => b.prefix.length - a.prefix.length);
  const byService = new Map<string, ScriptEntry[]>();
  for (const path of [...scripts].sort()) {
    const norm = path.replace(/\\/g, '/');
    const m = sorted.find((sp) => norm === sp.prefix || norm.startsWith(sp.prefix + '/'));
    const service = m ? m.service : ROOT_GROUP;
    const entry: ScriptEntry = { path, kind: classifyKind(path) };
    const arr = byService.get(service);
    if (arr) arr.push(entry);
    else byService.set(service, [entry]);
  }
  const present = [...byService.keys()];
  const known = serviceOrder.filter((s) => byService.has(s));
  const rest = present.filter((s) => !known.includes(s)).sort();
  return [...known, ...rest].map((service) => {
    const all = byService.get(service) ?? [];
    return { service, total: all.length, scripts: all.slice(0, MAX_PER_GROUP) };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/digest.test.ts -t groupScripts`
Expected: PASS — all four `groupScripts` tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/context/digest.ts tests/digest.test.ts
git commit -m "feat: group scripts by service with per-group bounding"
```

---

## Task 4: Wire buildDigest + update buildOptions test literal

**Files:**
- Modify: `src/context/digest.ts` (`buildDigest`)
- Modify: `tests/buildOptions.test.ts` (add `groups: []` to its literal)
- Test: `tests/digest.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/digest.test.ts`, add assertions to the existing `it('summarizes the fixture game', ...)` test, right before its closing `});`:

```typescript
    // groups: the fixture has Greeter (module) under ReplicatedStorage and
    // Hello (server script) under ServerScriptService.
    const services = d.groups.map((g) => g.service);
    expect(services).toContain('ReplicatedStorage');
    expect(services).toContain('ServerScriptService');
    const rep = d.groups.find((g) => g.service === 'ReplicatedStorage');
    expect(rep?.scripts).toEqual([
      { path: 'src/ReplicatedStorage/Greeter.luau', kind: 'ModuleScript' },
    ]);
    const ss = d.groups.find((g) => g.service === 'ServerScriptService');
    expect(ss?.scripts[0].kind).toBe('Script (server)');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/digest.test.ts -t "summarizes the fixture"`
Expected: FAIL — `d.groups` is `undefined` (buildDigest does not set it yet).

- [ ] **Step 3: Write minimal implementation**

In `src/context/digest.ts`, replace the body of `buildDigest` so it collects mappings and builds groups. The new function:

```typescript
export function buildDigest(projectPath: string): ProjectDigest {
  const projFile = resolve(projectPath, 'default.project.json');
  if (!existsSync(projFile)) {
    throw new Error(`No default.project.json in ${projectPath}`);
  }
  const proj = JSON.parse(readFileSync(projFile, 'utf8')) as {
    name?: string;
    tree?: Record<string, unknown>;
  };
  const treeObj = proj.tree ?? {};
  const tree = Object.keys(treeObj).filter((k) => !k.startsWith('$'));
  const scripts = walkLuau(projectPath)
    .map((p) => relative(projectPath, p))
    .sort();
  const groups = groupScripts(scripts, collectServicePaths(treeObj), tree);
  return { name: proj.name ?? 'unnamed', tree, scripts, groups };
}
```

Then update `tests/buildOptions.test.ts`: its `ProjectDigest` literal now needs the required `groups` field. Change:

```typescript
const digest: ProjectDigest = { name: 'g', tree: [], scripts: [] };
```

to:

```typescript
const digest: ProjectDigest = { name: 'g', tree: [], scripts: [], groups: [] };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/digest.test.ts tests/buildOptions.test.ts`
Expected: PASS — the fixture group assertions pass and buildOptions still passes.

- [ ] **Step 5: Commit**

```bash
git add src/context/digest.ts tests/digest.test.ts tests/buildOptions.test.ts
git commit -m "feat: buildDigest emits service-grouped game map"
```

---

## Task 5: Render the game map + filtered-tree guidance in the system prompt

**Files:**
- Modify: `src/agent/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/systemPrompt.test.ts`, first replace the fixture `digest` literal so it exercises all three kinds and carries `groups`. Replace:

```typescript
const digest: ProjectDigest = {
  name: 'blox-fixture',
  tree: ['ReplicatedStorage', 'ServerScriptService'],
  scripts: ['src/ReplicatedStorage/Greeter.luau'],
};
```

with:

```typescript
const digest: ProjectDigest = {
  name: 'blox-fixture',
  tree: ['ReplicatedStorage', 'ServerScriptService', 'StarterPlayer'],
  scripts: [
    'src/ReplicatedStorage/Greeter.luau',
    'src/ServerScriptService/Hello.server.luau',
    'src/StarterPlayer/StarterPlayerScripts/Controls.client.luau',
  ],
  groups: [
    {
      service: 'ReplicatedStorage',
      total: 1,
      scripts: [{ path: 'src/ReplicatedStorage/Greeter.luau', kind: 'ModuleScript' }],
    },
    {
      service: 'ServerScriptService',
      total: 1,
      scripts: [{ path: 'src/ServerScriptService/Hello.server.luau', kind: 'Script (server)' }],
    },
    {
      service: 'StarterPlayer',
      total: 1,
      scripts: [
        { path: 'src/StarterPlayer/StarterPlayerScripts/Controls.client.luau', kind: 'LocalScript (client)' },
      ],
    },
  ],
};
```

Then replace the existing flat-scripts assertion. Find and remove:

```typescript
    expect(p).toContain('src/ReplicatedStorage/Greeter.luau');
```

and add these assertions in its place (inside the same `it(...)`):

```typescript
    expect(p).toContain('Game map');
    expect(p).toContain('Greeter.luau — ModuleScript');
    expect(p).toContain('Hello.server.luau — Script (server)');
    expect(p).toContain('Controls.client.luau — LocalScript (client)');
    // flaw-A guidance
    expect(p).toContain('search_game_tree');
    expect(p).toContain('instance_type');
    expect(p).toContain('filter');
```

NOTE: keep the other existing assertions (`blox`, `Luau`, `Rojo`, `blox-fixture`, the play/input/visual phrases, etc.) untouched. Only the single `src/ReplicatedStorage/Greeter.luau` line is replaced.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: FAIL — the prompt does not yet contain `Game map` / the `— <kind>` lines / the guidance substrings.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/systemPrompt.ts`, update the import to pull the new types and `basename`:

```typescript
import { basename } from 'node:path';
import type { ProjectDigest, ScriptGroup } from '../context/digest.js';
```

Add these two render helpers above `buildSystemPrompt`:

```typescript
function groupNoun(group: ScriptGroup): string {
  const n = group.total;
  const plural = (s: string) => `${s}${n === 1 ? '' : 's'}`;
  const truncated = group.total > group.scripts.length;
  const kinds = new Set(group.scripts.map((s) => s.kind));
  if (!truncated && kinds.size === 1) {
    const k = group.scripts[0].kind;
    if (k === 'ModuleScript') return plural('module');
    if (k === 'Script (server)') return plural('server script');
    if (k === 'LocalScript (client)') return plural('client script');
  }
  return plural('script');
}

function renderGameMap(digest: ProjectDigest): string[] {
  const total = digest.scripts.length;
  if (total === 0) return ['Game map (0 scripts): (none)'];
  const lines = [`Game map (${total} scripts):`];
  for (const g of digest.groups) {
    if (g.total === 0) continue;
    lines.push(`  ${g.service}/  (${g.total} ${groupNoun(g)})`);
    for (const s of g.scripts) {
      lines.push(`    ${basename(s.path)} — ${s.kind}`);
    }
    const hidden = g.total - g.scripts.length;
    if (hidden > 0) lines.push(`    … +${hidden} more (use script_search / glob to list)`);
  }
  return lines;
}
```

Then replace the trailing three lines of the prompt array. Find:

```typescript
    `Project: ${digest.name}`,
    `Top-level tree: ${digest.tree.join(', ') || '(none)'}`,
    `Scripts (${digest.scripts.length}):`,
    ...digest.scripts.map((s) => `  ${s}`),
```

and replace with:

```typescript
    'Game context:',
    '- The game map below lists the on-disk scripts you edit. For live game',
    '  structure (instances, models, GUIs, parts), use search_game_tree.',
    '- Always filter search_game_tree: pass instance_type (IsA, e.g. BasePart,',
    '  Model, BaseScript), keywords, and/or a path start point, and keep max_depth',
    '  small. An unfiltered call returns ~200 nodes dominated by built-in engine',
    '  services and is truncated — filter to user content instead.',
    '- Use inspect_instance for one instance\'s properties/children on demand.',
    '',
    `Project: ${digest.name}`,
    `Top-level tree: ${digest.tree.join(', ') || '(none)'}`,
    ...renderGameMap(digest),
```

IMPORTANT: READ `src/agent/systemPrompt.ts` first and match the exact trailing lines (the four lines above are the current ending of the array, before the closing `].join('\n');`). Keep the array-of-strings formatting and indentation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: PASS — `Game map`, the three `— <kind>` lines, and the guidance substrings are all present.

- [ ] **Step 5: Commit**

```bash
git add src/agent/systemPrompt.ts tests/systemPrompt.test.ts
git commit -m "feat: render game-map digest + filtered-tree guidance in prompt"
```

---

## Task 6: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: all unit tests pass; gated live tests (`live-studio`, `live-sync`, `live-serve`, `live-play`, `live-input`, `live-capture`) skip. Pass count rose by the new digest helper tests (Tasks 1–4) and the systemPrompt assertions (Task 5).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: no type errors (this is the first full `tsc`; it confirms every `ProjectDigest` literal now carries `groups`); `dist/cli.js` is produced.

- [ ] **Step 3: Final commit if anything was adjusted**

Only if Steps 1–2 forced a fix:

```bash
git add -A
git commit -m "chore: SP2-c game-map digest verification fixes"
```

---

## Self-Review Notes

**Spec coverage:**
- §3 architecture (digest.ts + systemPrompt.ts, pure FS, no MCP) → Tasks 1–5.
- §3.1 kind classification (suffix → server/client/module, case-insensitive) → Task 1.
- §3.2 service grouping (recursive `$path` collect tagged by top-level ancestor; longest-prefix match; `(root)` fallback; tree-order then alphabetical) → Tasks 2 (collect) + 3 (group/order).
- §3.3 bounding (`MAX_PER_GROUP=30`, true total, `… +K more` line) → Task 3 (bounding) + Task 5 (render of the `… +K more` line).
- §4 data shape (`ScriptKind`/`ScriptEntry`/`ScriptGroup`, `groups` added, `scripts` retained) → Task 1 (types) + Task 4 (populate).
- §4.1 back-compat (`scripts` full flat list retained) → Task 4 (asserted by the existing fixture test + new Task 4 assertions).
- §5 rendered format (`Game map`, `<service>/ (<n> <noun>)`, `<basename> — <kind>`, `… +K more`, empty → `(none)`) → Task 5.
- §6 guidance substrings (`search_game_tree`, `instance_type`, `filter`) → Task 5.
- §8 tests (kind, grouping, bounding, back-compat, empty, rendered prompt) → Tasks 1–5; §8 full-suite/tsc/build → Task 6.
- §7 out-of-scope: nothing implemented (no require-graph, no retrieval, no MCP digest, no init-collapse) — correct.
- §9 success criteria 1–5 → Tasks 1–6.

**Empty-project rendering note:** §5/§8 require empty → `Game map (0 scripts): (none)`. `renderGameMap` returns that exact string when `digest.scripts.length === 0`. No dedicated unit test is required by the spec's substring list, but `renderGameMap`'s empty branch is exercised indirectly; if a reviewer wants it pinned, add `expect(buildSystemPrompt({name:'x',tree:[],scripts:[],groups:[]})).toContain('Game map (0 scripts): (none)')` to `tests/systemPrompt.test.ts`.

**Placeholder scan:** none — every code step shows full code; Task 6 is verification-only.

**Type consistency:** `ScriptKind`/`ScriptEntry`/`ScriptGroup`/`ServicePath` defined in Tasks 1–2 are used unchanged in Tasks 3–5. `classifyKind(path)→ScriptKind`, `collectServicePaths(tree)→ServicePath[]`, `groupScripts(scripts, mappings, serviceOrder)→ScriptGroup[]`, `MAX_PER_GROUP`/`ROOT_GROUP` consts — names and signatures match across the digest tests, `buildDigest`, and the systemPrompt render helpers. The `groups` field is required on `ProjectDigest` from Task 1; the two test literals that construct `ProjectDigest` are updated in Task 4 (`tests/buildOptions.test.ts`) and Task 5 (`tests/systemPrompt.test.ts`); the full `tsc` runs only in Task 6, after both are fixed.
