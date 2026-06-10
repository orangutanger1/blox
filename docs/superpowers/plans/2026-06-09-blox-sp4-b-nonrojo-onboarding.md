# blox SP4-b — Non-Rojo Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `blox init` — a deterministic one-shot that pulls the live Studio DataModel's scripts into a Rojo project on disk (Rojo-convention `.luau` files + service→directory `default.project.json` + a git baseline commit) so the normal blox loop works on previously non-Rojo games.

**Architecture:** Three pure-ish units under `src/onboard/`: `pull.ts` runs one `execute_luau` DataModel walk through the existing doctor MCP-client seam and parses the JSON dump; `layout.ts` is a pure mapper from pulled scripts to files + project.json (class→suffix, nesting→dirs, Rojo `init` folders, filename sanitize, conflict abort/suffix); `write.ts` writes the plan to disk and makes the git baseline. `args.ts`/`cli.ts` wire the `init` subcommand.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Vitest, `@modelcontextprotocol/sdk` (via the doctor `McpClientFactory` seam), Zod not needed here.

---

## Spec → plan reference

Implements `docs/superpowers/specs/2026-06-09-blox-sp4-b-nonrojo-onboarding-design.md`.

**Grounding facts (verified in the current tree):**
- `probeExecuteLuau(launch, code, factory?, opts?) → Promise<LuauProbeResult>` (`src/doctor.ts:108`). `LuauProbeResult = { text: string; isError: boolean; attempts: number; attached: boolean }` (`src/doctor.ts:68`). It connects, finds the `execute_luau` tool, calls it with `{ code, datamodel_type: 'Edit' }`, retries past the attach race, and returns the tool's text output. `McpClientFactory = (launch: StudioLaunch) => Promise<DoctorClient>` (`src/doctor.ts:15`); `DoctorClient.callTool` returns `CallToolResult { content?: {type;text?}[]; isError? }`.
- `studioLauncher(): StudioLaunch` exported from `src/bridge/mcpBridge.ts` (already imported in `src/cli.ts`).
- `commitChanges(projectPath, message, spawn?) → Promise<{sha,files}>` (`src/git/commit.ts`) does `git add -A` + commit; `SpawnFn` from `src/sync/rojo.ts` is the injectable shell seam (`spawn(cmd, args, {cwd}) → {stdout, code}`).
- `buildDigest` throws without `default.project.json` (`src/context/digest.ts`) — onboarding's output must satisfy it.
- `parseArgs` (`src/args.ts`, post-SP4-a) returns `ParsedArgs` with `command: 'doctor'|'serve'|null`; the `doctor`/`serve` tokens are parsed only when `command === null && positional.length === 0`.

**`Instance:GetFullName()` fact:** returns the path from the top-level service down, NOT prefixed with `game.` (e.g. `workspace.Part` → `"Workspace.Part"`). So the first dotted segment is the service. A defensive `game.`/`Game.` strip is included anyway.

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/onboard/pull.ts` | `PulledScript`, `DUMP_LUAU`, `parseDump`, `pullScripts`, `mockPulledScripts` | Create |
| `src/onboard/layout.ts` | Pure `planLayout` + helpers (`classToSuffix`, `sanitizeName`) + types | Create |
| `src/onboard/write.ts` | `writePlan` — refuse/abort/write + git baseline | Create |
| `src/onboard/report.ts` | `formatOnboardReport` | Create |
| `src/args.ts` | `init` subcommand + `--on-conflict` / `--force` | Modify |
| `src/cli.ts` | `init` branch wiring | Modify |
| `tests/onboard.pull.test.ts` | parseDump + pullScripts (mock factory) | Create |
| `tests/onboard.layout.test.ts` | planLayout (all mapping cases) | Create |
| `tests/onboard.write.test.ts` | writePlan in a tmpdir | Create |
| `tests/onboard.report.test.ts` | formatOnboardReport | Create |
| `tests/args.test.ts` | init parse | Modify |
| `tests/e2e/live-onboard.test.ts` | gated live onboard (`BLOX_LIVE_ONBOARD=1`) | Create |

Run unit tests with `npx vitest run`. Typecheck with `npx tsc --noEmit`.

---

### Task 1: `pull.ts` — DataModel dump + parse

**Files:**
- Create: `src/onboard/pull.ts`
- Test: `tests/onboard.pull.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { parseDump, pullScripts, mockPulledScripts } from '../src/onboard/pull.js';
import type { McpClientFactory } from '../src/doctor.js';

describe('parseDump', () => {
  it('parses a JSON array of scripts', () => {
    const text = JSON.stringify([
      { fullName: 'ServerScriptService.Hello', className: 'Script', source: 'print(1)' },
    ]);
    expect(parseDump(text)).toEqual([
      { fullName: 'ServerScriptService.Hello', className: 'Script', source: 'print(1)' },
    ]);
  });

  it('throws on malformed JSON', () => {
    expect(() => parseDump('not json')).toThrow(/parse/i);
  });

  it('throws when an entry is missing fields', () => {
    expect(() => parseDump(JSON.stringify([{ fullName: 'X' }]))).toThrow(/invalid/i);
  });
});

// A fake DoctorClient that advertises execute_luau and returns a canned dump.
function fakeFactory(dumpJson: string, isError = false): McpClientFactory {
  return async () => ({
    serverInfo: () => ({ name: 'fake', version: '0' }),
    listTools: async () => ({ tools: [{ name: 'mcp__Roblox_Studio__execute_luau' }] }),
    callTool: async () => ({ content: [{ type: 'text', text: dumpJson }], isError }),
    close: async () => {},
  });
}

const launch = { command: 'x', args: [] };

describe('pullScripts', () => {
  it('returns parsed scripts when attached', async () => {
    const dump = JSON.stringify([
      { fullName: 'ReplicatedStorage.Mod', className: 'ModuleScript', source: 'return {}' },
    ]);
    const scripts = await pullScripts(launch, fakeFactory(dump), { probeAttempts: 1, probeDelayMs: 0 });
    expect(scripts).toHaveLength(1);
    expect(scripts[0].className).toBe('ModuleScript');
  });

  it('throws when no Studio attaches', async () => {
    await expect(
      pullScripts(launch, fakeFactory('no active studio', false), { probeAttempts: 1, probeDelayMs: 0 }),
    ).rejects.toThrow(/studio/i);
  });

  it('mockPulledScripts returns a non-empty sample', () => {
    expect(mockPulledScripts().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/onboard.pull.test.ts`
Expected: FAIL — cannot resolve `../src/onboard/pull.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/onboard/pull.ts
import type { StudioLaunch } from '../bridge/types.js';
import { probeExecuteLuau, type McpClientFactory, type DoctorOptions } from '../doctor.js';

export interface PulledScript {
  fullName: string;
  className: 'Script' | 'LocalScript' | 'ModuleScript';
  source: string;
}

// Luau run inside Studio (edit mode) that walks the DataModel and JSON-encodes
// every script instance. execute_luau returns this string as its text output.
export const DUMP_LUAU = `local HttpService = game:GetService("HttpService")
local out = {}
for _, inst in ipairs(game:GetDescendants()) do
  if inst:IsA("LuaSourceContainer") then
    table.insert(out, { fullName = inst:GetFullName(), className = inst.ClassName, source = inst.Source })
  end
end
return HttpService:JSONEncode(out)`;

const KINDS = new Set(['Script', 'LocalScript', 'ModuleScript']);

export function parseDump(text: string): PulledScript[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse script dump: ${(e as Error).message}`);
  }
  if (!Array.isArray(data)) throw new Error('invalid dump: expected a JSON array');
  return data.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    if (typeof r.fullName !== 'string' || typeof r.source !== 'string' || typeof r.className !== 'string' || !KINDS.has(r.className)) {
      throw new Error(`invalid dump entry at index ${i}`);
    }
    return { fullName: r.fullName, className: r.className as PulledScript['className'], source: r.source };
  });
}

export async function pullScripts(
  launch: StudioLaunch,
  factory?: McpClientFactory,
  opts: DoctorOptions = {},
): Promise<PulledScript[]> {
  const res = await probeExecuteLuau(launch, DUMP_LUAU, factory, opts);
  if (!res.attached || res.isError) {
    throw new Error(`could not read scripts from Studio: ${res.text}`);
  }
  return parseDump(res.text);
}

// Canned sample for `blox init --mock` and tests — exercises nesting + all kinds.
export function mockPulledScripts(): PulledScript[] {
  return [
    { fullName: 'ReplicatedStorage.Greeter', className: 'ModuleScript', source: 'return function() return "hi" end' },
    { fullName: 'ServerScriptService.Hello', className: 'Script', source: 'print("hello")' },
    { fullName: 'StarterPlayer.StarterPlayerScripts.Controller', className: 'LocalScript', source: 'print("client")' },
  ];
}
```

> Note: `probeExecuteLuau` requires `McpClientFactory`/`DoctorOptions` to be exported from `src/doctor.ts` — they already are (`src/doctor.ts:15,57`). When `factory` is undefined, `probeExecuteLuau` falls back to its `defaultClientFactory`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/onboard.pull.test.ts`
Expected: PASS (3 describe blocks).

- [ ] **Step 5: Commit**

```bash
git add src/onboard/pull.ts tests/onboard.pull.test.ts
git commit -m "feat(sp4-b): DataModel script dump + parse (onboard pull)"
```

---

### Task 2: `layout.ts` — pure DataModel→filesystem mapper

**Files:**
- Create: `src/onboard/layout.ts`
- Test: `tests/onboard.layout.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { planLayout, classToSuffix, sanitizeName } from '../src/onboard/layout.js';
import type { PulledScript } from '../src/onboard/pull.js';

const s = (fullName: string, className: PulledScript['className'], source = 'x'): PulledScript => ({ fullName, className, source });

describe('classToSuffix', () => {
  it('maps each script class to its Rojo suffix', () => {
    expect(classToSuffix('Script')).toBe('.server.luau');
    expect(classToSuffix('LocalScript')).toBe('.client.luau');
    expect(classToSuffix('ModuleScript')).toBe('.luau');
  });
});

describe('sanitizeName', () => {
  it('replaces filesystem-illegal characters with underscore', () => {
    expect(sanitizeName('a/b:c*?')).toBe('a_b_c__');
  });
});

describe('planLayout — paths', () => {
  it('maps top-level scripts under src/<service> with the class suffix', () => {
    const plan = planLayout([s('ServerScriptService.Hello', 'Script')], 'abort', 'g');
    expect(plan.files).toEqual([{ path: 'src/ServerScriptService/Hello.server.luau', source: 'x' }]);
    expect(plan.conflicts).toEqual([]);
  });

  it('nests ancestor instances as directories', () => {
    const plan = planLayout([s('ReplicatedStorage.Systems.Combat', 'ModuleScript')], 'abort', 'g');
    expect(plan.files[0].path).toBe('src/ReplicatedStorage/Systems/Combat.luau');
  });

  it('uses the Rojo init convention for a script that contains a script', () => {
    const plan = planLayout(
      [s('ServerScriptService.Manager', 'Script'), s('ServerScriptService.Manager.Helper', 'ModuleScript')],
      'abort', 'g',
    );
    const paths = plan.files.map((f) => f.path).sort();
    expect(paths).toEqual([
      'src/ServerScriptService/Manager/Helper.luau',
      'src/ServerScriptService/Manager/init.server.luau',
    ]);
  });

  it('sanitizes illegal characters in instance names', () => {
    const plan = planLayout([s('ReplicatedStorage.a/b', 'ModuleScript')], 'abort', 'g');
    expect(plan.files[0].path).toBe('src/ReplicatedStorage/a_b.luau');
  });
});

describe('planLayout — conflicts', () => {
  const dupes = [s('ReplicatedStorage.Dup', 'ModuleScript', 'A'), s('ReplicatedStorage.Dup', 'ModuleScript', 'B')];

  it('abort: collects conflicts and emits no files', () => {
    const plan = planLayout(dupes, 'abort', 'g');
    expect(plan.files).toEqual([]);
    expect(plan.conflicts).toHaveLength(2);
    expect(plan.conflicts[0].path).toBe('src/ReplicatedStorage/Dup.luau');
  });

  it('suffix: disambiguates colliding files and records the renames', () => {
    const plan = planLayout(dupes, 'suffix', 'g');
    const paths = plan.files.map((f) => f.path).sort();
    expect(paths).toEqual(['src/ReplicatedStorage/Dup.luau', 'src/ReplicatedStorage/Dup_2.luau']);
    expect(plan.conflicts).toEqual([]);
    expect(plan.renamed).toHaveLength(1);
  });
});

describe('planLayout — project.json', () => {
  it('emits one tree entry per script-bearing service plus the DataModel root', () => {
    const plan = planLayout(
      [s('ServerScriptService.Hello', 'Script'), s('ReplicatedStorage.Mod', 'ModuleScript')],
      'abort', 'mygame',
    );
    expect(plan.project).toEqual({
      name: 'mygame',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { $path: 'src/ReplicatedStorage' },
        ServerScriptService: { $path: 'src/ServerScriptService' },
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/onboard.layout.test.ts`
Expected: FAIL — cannot resolve `../src/onboard/layout.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/onboard/layout.ts
import type { PulledScript } from './pull.js';

export type ConflictStrategy = 'abort' | 'suffix';

export interface WriteFile {
  path: string; // project-relative, POSIX separators
  source: string;
}
export interface Conflict {
  fullName: string;
  path: string;
  reason: 'duplicate-path';
}
export interface Renamed {
  fullName: string;
  from: string;
  to: string;
}
export interface ProjectJson {
  name: string;
  tree: Record<string, unknown>;
}
export interface LayoutPlan {
  files: WriteFile[];
  project: ProjectJson;
  conflicts: Conflict[];
  renamed: Renamed[];
}

export function classToSuffix(className: PulledScript['className']): string {
  if (className === 'Script') return '.server.luau';
  if (className === 'LocalScript') return '.client.luau';
  return '.luau';
}

const ILLEGAL = /[/\\:*?"<>|\x00-\x1f]/g;
export function sanitizeName(name: string): string {
  return name.replace(ILLEGAL, '_');
}

function stripGamePrefix(fullName: string): string {
  return fullName.replace(/^game\./i, '');
}

// Build the POSIX file path for a script. A script that is itself an ancestor of
// another script becomes a directory holding init<suffix>.luau (Rojo convention).
function filePathFor(script: PulledScript, allFullNames: Set<string>): string {
  const full = stripGamePrefix(script.fullName);
  const parts = full.split('.');
  const suffix = classToSuffix(script.className);
  const dirSegs = parts.slice(0, -1).map(sanitizeName); // service + ancestor dirs
  const leaf = sanitizeName(parts[parts.length - 1]);
  const isContainer = [...allFullNames].some((n) => stripGamePrefix(n).startsWith(full + '.'));
  if (isContainer) {
    return ['src', ...dirSegs, leaf, `init${suffix}`].join('/');
  }
  return ['src', ...dirSegs, `${leaf}${suffix}`].join('/');
}

export function planLayout(
  scripts: PulledScript[],
  strategy: ConflictStrategy,
  name: string,
): LayoutPlan {
  const allFullNames = new Set(scripts.map((s) => s.fullName));
  // Pair each script with its desired path, in stable input order.
  const desired = scripts.map((s) => ({ script: s, path: filePathFor(s, allFullNames) }));

  // Group by path to find collisions.
  const byPath = new Map<string, typeof desired>();
  for (const d of desired) {
    const arr = byPath.get(d.path);
    if (arr) arr.push(d);
    else byPath.set(d.path, [d]);
  }

  const files: WriteFile[] = [];
  const conflicts: Conflict[] = [];
  const renamed: Renamed[] = [];

  for (const d of desired) {
    const group = byPath.get(d.path)!;
    if (group.length === 1) {
      files.push({ path: d.path, source: d.script.source });
      continue;
    }
    // Collision.
    if (strategy === 'abort') {
      conflicts.push({ fullName: d.script.fullName, path: d.path, reason: 'duplicate-path' });
      continue;
    }
    // suffix: first occurrence keeps the path; later ones get _2, _3, ... inserted
    // before the Rojo suffix (.server.luau / .client.luau / .luau).
    const idx = group.indexOf(d);
    if (idx === 0) {
      files.push({ path: d.path, source: d.script.source });
    } else {
      const m = d.path.match(/^(.*?)(\.(?:server|client)\.luau|\.luau)$/)!;
      const to = `${m[1]}_${idx + 1}${m[2]}`;
      files.push({ path: to, source: d.script.source });
      renamed.push({ fullName: d.script.fullName, from: d.path, to });
    }
  }

  // project.json: one entry per service that contributed at least one written file.
  // On an abort-with-conflicts plan, `files` is empty, so only the DataModel root
  // is emitted (the writer writes nothing anyway).
  const writtenServices = new Set(files.map((f) => f.path.split('/')[1]));
  const tree: Record<string, unknown> = { $className: 'DataModel' };
  for (const svc of [...writtenServices].sort()) {
    tree[svc] = { $path: `src/${svc}` };
  }

  return { files, project: { name, tree }, conflicts, renamed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/onboard.layout.test.ts`
Expected: PASS (all 5 describe blocks). Also run `npx tsc --noEmit` — must be clean (remove the placeholder bindings noted above so there are no unused-variable / no-unused TS errors).

- [ ] **Step 5: Commit**

```bash
git add src/onboard/layout.ts tests/onboard.layout.test.ts
git commit -m "feat(sp4-b): pure DataModel->filesystem layout mapper"
```

---

### Task 3: `write.ts` — write plan + git baseline

**Files:**
- Create: `src/onboard/write.ts`
- Test: `tests/onboard.write.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePlan } from '../src/onboard/write.js';
import type { LayoutPlan } from '../src/onboard/layout.js';
import type { SpawnFn } from '../src/sync/rojo.js';

const plan: LayoutPlan = {
  files: [{ path: 'src/ReplicatedStorage/Mod.luau', source: 'return 1' }],
  project: { name: 'g', tree: { $className: 'DataModel', ReplicatedStorage: { $path: 'src/ReplicatedStorage' } } },
  conflicts: [],
  renamed: [],
};

// Records git invocations, always succeeds.
function fakeSpawn(): { fn: SpawnFn; calls: string[][] } {
  const calls: string[][] = [];
  const fn: SpawnFn = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'status') return { stdout: ' M src/ReplicatedStorage/Mod.luau', stderr: '', code: 0 };
    if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'abc123', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 0 };
  };
  return { fn, calls };
}

describe('writePlan', () => {
  it('writes files + default.project.json and makes a baseline commit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-onboard-'));
    const { fn, calls } = fakeSpawn();
    const r = await writePlan(dir, plan, { force: false, spawn: fn });
    expect(existsSync(join(dir, 'src/ReplicatedStorage/Mod.luau'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'default.project.json'), 'utf8')).name).toBe('g');
    expect(r.written).toContain('src/ReplicatedStorage/Mod.luau');
    expect(r.baselineSha).toBe('abc123');
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'init')).toBe(true);
  });

  it('refuses when default.project.json exists and force is false', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-onboard-'));
    writeFileSync(join(dir, 'default.project.json'), '{}');
    const { fn } = fakeSpawn();
    const r = await writePlan(dir, plan, { force: false, spawn: fn });
    expect(r.refused).toBe(true);
    expect(r.written).toEqual([]);
  });

  it('writes nothing when an abort plan has conflicts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-onboard-'));
    const { fn } = fakeSpawn();
    const conflicted: LayoutPlan = { ...plan, files: [], conflicts: [{ fullName: 'X.Dup', path: 'src/X/Dup.luau', reason: 'duplicate-path' }] };
    const r = await writePlan(dir, conflicted, { force: false, spawn: fn });
    expect(r.conflictsAborted).toBe(true);
    expect(existsSync(join(dir, 'default.project.json'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/onboard.write.test.ts`
Expected: FAIL — cannot resolve `../src/onboard/write.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/onboard/write.ts
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { realSpawn, type SpawnFn } from '../sync/rojo.js';
import { commitChanges } from '../git/commit.js';
import type { LayoutPlan } from './layout.js';

export interface WriteOptions {
  force: boolean;
  spawn?: SpawnFn;
}
export interface WriteResult {
  written: string[];
  baselineSha: string | null;
  refused?: boolean;
  conflictsAborted?: boolean;
}

export async function writePlan(
  projectPath: string,
  plan: LayoutPlan,
  opts: WriteOptions,
): Promise<WriteResult> {
  const spawn = opts.spawn ?? realSpawn;

  if (plan.conflicts.length > 0) {
    return { written: [], baselineSha: null, conflictsAborted: true };
  }
  if (existsSync(join(projectPath, 'default.project.json')) && !opts.force) {
    return { written: [], baselineSha: null, refused: true };
  }

  const written: string[] = [];
  for (const f of plan.files) {
    const abs = join(projectPath, ...f.path.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.source, 'utf8');
    written.push(f.path);
  }
  writeFileSync(
    join(projectPath, 'default.project.json'),
    JSON.stringify(plan.project, null, 2) + '\n',
    'utf8',
  );

  // git baseline: init (idempotent) then commit the pulled state.
  await spawn('git', ['init'], { cwd: projectPath });
  const commit = await commitChanges(projectPath, `blox: onboard ${plan.project.name} from Studio`, spawn);
  return { written, baselineSha: commit.sha };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/onboard.write.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/onboard/write.ts tests/onboard.write.test.ts
git commit -m "feat(sp4-b): write onboard plan to disk + git baseline"
```

---

### Task 4: `report.ts` — onboard report

**Files:**
- Create: `src/onboard/report.ts`
- Test: `tests/onboard.report.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { formatOnboardReport } from '../src/onboard/report.js';

describe('formatOnboardReport', () => {
  it('summarizes a successful onboard with next steps', () => {
    const out = formatOnboardReport({
      written: ['src/ReplicatedStorage/Mod.luau', 'src/ServerScriptService/Hello.server.luau'],
      baselineSha: 'abc123',
      renamed: [],
      conflicts: [],
    });
    expect(out).toContain('onboarded 2 scripts');
    expect(out).toContain('baseline: abc123');
    expect(out).toContain('rojo serve');
  });

  it('lists conflicts and tells the user how to resolve them', () => {
    const out = formatOnboardReport({
      written: [],
      baselineSha: null,
      renamed: [],
      conflicts: [{ fullName: 'ReplicatedStorage.Dup', path: 'src/ReplicatedStorage/Dup.luau', reason: 'duplicate-path' }],
    });
    expect(out).toContain('conflicts (nothing written):');
    expect(out).toContain('ReplicatedStorage.Dup');
    expect(out).toContain('--on-conflict suffix');
  });

  it('reports renames under the suffix strategy', () => {
    const out = formatOnboardReport({
      written: ['src/X/Dup.luau', 'src/X/Dup_2.luau'],
      baselineSha: 'sha',
      renamed: [{ fullName: 'X.Dup', from: 'src/X/Dup.luau', to: 'src/X/Dup_2.luau' }],
      conflicts: [],
    });
    expect(out).toContain('renamed 1');
  });

  it('handles the empty (nothing to onboard) case', () => {
    const out = formatOnboardReport({ written: [], baselineSha: null, renamed: [], conflicts: [] });
    expect(out).toContain('nothing to onboard');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/onboard.report.test.ts`
Expected: FAIL — cannot resolve `../src/onboard/report.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/onboard/report.ts
import type { Conflict, Renamed } from './layout.js';

export interface OnboardReportData {
  written: string[];
  baselineSha: string | null;
  renamed: Renamed[];
  conflicts: Conflict[];
}

export function formatOnboardReport(d: OnboardReportData): string {
  if (d.conflicts.length > 0) {
    return [
      `blox init — conflicts (nothing written):`,
      ...d.conflicts.map((c) => `  ${c.fullName} → ${c.path}`),
      `→ rename the duplicate(s) in Studio and re-run, or re-run with --on-conflict suffix`,
    ].join('\n');
  }
  if (d.written.length === 0) {
    return 'blox init — nothing to onboard (no scripts found in the DataModel)';
  }
  const lines = [
    `blox init — onboarded ${d.written.length} scripts`,
    ...(d.renamed.length ? [`renamed ${d.renamed.length} to avoid collisions:`, ...d.renamed.map((r) => `  ${r.from} → ${r.to}`)] : []),
    `baseline: ${d.baselineSha ?? '(no commit)'}`,
    `→ next: run \`rojo serve\` and click Connect in Studio's Rojo plugin, then \`blox "<prompt>"\``,
  ];
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/onboard.report.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/onboard/report.ts tests/onboard.report.test.ts
git commit -m "feat(sp4-b): onboard report formatter"
```

---

### Task 5: `args.ts` — `init` subcommand + flags

**Files:**
- Modify: `src/args.ts`
- Test: `tests/args.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/args.test.ts`

```ts
describe('init subcommand', () => {
  it('parses a leading init token into command', () => {
    const a = parseArgs(['init']);
    expect(a.command).toBe('init');
    expect(a.onConflict).toBeNull();
    expect(a.force).toBe(false);
  });

  it('parses --on-conflict and --force with init', () => {
    const a = parseArgs(['init', '--project', '/game', '--on-conflict', 'suffix', '--force']);
    expect(a.command).toBe('init');
    expect(a.projectPath).toBe('/game');
    expect(a.onConflict).toBe('suffix');
    expect(a.force).toBe(true);
  });

  it('rejects an invalid --on-conflict value', () => {
    expect(() => parseArgs(['init', '--on-conflict', 'nope'])).toThrow(/on-conflict/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/args.test.ts`
Expected: FAIL — `command` is not `'init'`; `onConflict`/`force` undefined.

- [ ] **Step 3: Write minimal implementation** — edit `src/args.ts`

Change the `command` type on `ParsedArgs` and add two fields:

```ts
export interface ParsedArgs {
  command: 'doctor' | 'serve' | 'init' | null;
  prompt: string | null;
  mock: boolean;
  projectPath: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  effort: 'high' | 'xhigh' | null;
  mode: 'auto' | 'ask' | null;
  onConflict: 'abort' | 'suffix' | null;
  force: boolean;
}
```

In `parseArgs`, add locals and parsing. Add near the other `let` declarations:

```ts
  let onConflict: 'abort' | 'suffix' | null = null;
  let force = false;
```

Inside the loop, add an `init` token branch alongside `doctor`/`serve`, and the two flags (place the flag branches before the `doctor`/`serve`/positional branches):

```ts
    else if (a === '--on-conflict') {
      const v = argv[++i];
      if (v !== 'abort' && v !== 'suffix') throw new Error('--on-conflict must be abort or suffix');
      onConflict = v;
    } else if (a === '--force') force = true;
    else if (a === 'init' && command === null && positional.length === 0) command = 'init';
```

And add `onConflict` + `force` to the returned object:

```ts
  return {
    command,
    prompt: positional.join(' ').trim() || null,
    mock,
    projectPath,
    maxTurns,
    maxBudgetUsd,
    effort,
    mode,
    onConflict,
    force,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/args.test.ts`
Expected: PASS (existing args tests + 3 new init tests).

- [ ] **Step 5: Commit**

```bash
git add src/args.ts tests/args.test.ts
git commit -m "feat(sp4-b): parse init subcommand + --on-conflict/--force"
```

---

### Task 6: `cli.ts` — wire the `init` branch

**Files:**
- Modify: `src/cli.ts`

(No unit test — entry glue; covered by the pure units above + Task 7 live e2e + a manual `--mock` smoke.)

- [ ] **Step 1: Add imports** at the top of `src/cli.ts`

```ts
import { basename } from 'node:path';
import { pullScripts, mockPulledScripts } from './onboard/pull.js';
import { planLayout } from './onboard/layout.js';
import { writePlan } from './onboard/write.js';
import { formatOnboardReport } from './onboard/report.js';
```

- [ ] **Step 2: Add the `init` branch** in `main`, immediately after the existing `serve` command block (and before the `if (!prompt)` usage check):

```ts
  if (command === 'init') {
    const dir = projectPath ?? process.cwd();
    const strategy = args.onConflict ?? 'abort';
    const name = basename(dir) || 'blox-game';
    let scripts;
    try {
      scripts = mock ? mockPulledScripts() : await pullScripts(studioLauncher());
    } catch (e) {
      console.error(`blox init failed: ${(e as Error).message}`);
      process.exit(1);
    }
    const plan = planLayout(scripts, strategy, name);
    const result = await writePlan(dir, plan, { force: args.force });
    if (result.refused) {
      console.error(`default.project.json already exists in ${dir} — re-run with --force to overwrite`);
      process.exit(1);
    }
    console.log(
      formatOnboardReport({
        written: result.written,
        baselineSha: result.baselineSha,
        renamed: plan.renamed,
        conflicts: plan.conflicts,
      }),
    );
    process.exit(plan.conflicts.length > 0 ? 1 : 0);
  }
```

> `studioLauncher`, `args`, `command`, `mock`, `projectPath` are all already in scope in `main` (imported / destructured from `parseArgs` in the SP4-a wiring).

- [ ] **Step 3: Build + full suite**

Run: `npm run build && npx vitest run`
Expected: build clean; all unit tests PASS (no e2e without env flags).

- [ ] **Step 4: Manual `--mock` smoke** (no Studio needed)

```bash
rm -rf /tmp/blox-init-demo && mkdir -p /tmp/blox-init-demo
node dist/cli.js init --mock --project /tmp/blox-init-demo
find /tmp/blox-init-demo -type f -not -path '*/.git/*' | sort
```
Expected: report "onboarded 3 scripts" + baseline sha; files present:
`/tmp/blox-init-demo/default.project.json`,
`/tmp/blox-init-demo/src/ReplicatedStorage/Greeter.luau`,
`/tmp/blox-init-demo/src/ServerScriptService/Hello.server.luau`,
`/tmp/blox-init-demo/src/StarterPlayer/StarterPlayerScripts/Controller.client.luau`.

Then confirm the output satisfies `buildDigest`:
```bash
node -e "import('/home/myen/blox/dist/context/digest.js').then(m=>console.log(m.buildDigest('/tmp/blox-init-demo').groups.length))"
```
Expected: a number ≥ 1 (no throw).

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts
git commit -m "feat(sp4-b): wire blox init (pull -> plan -> write -> report)"
```

---

### Task 7: gated live e2e + README + final

**Files:**
- Create: `tests/e2e/live-onboard.test.ts`

- [ ] **Step 1: Write the gated live test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullScripts } from '../../src/onboard/pull.js';
import { planLayout } from '../../src/onboard/layout.js';
import { writePlan } from '../../src/onboard/write.js';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { buildDigest } from '../../src/context/digest.js';

const RUN = process.env.BLOX_LIVE_ONBOARD === '1';

describe.runIf(RUN)('blox init against a live Studio', () => {
  it('pulls scripts, writes a Rojo project, and buildDigest succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-live-onboard-'));
    const scripts = await pullScripts(studioLauncher());
    expect(scripts.length).toBeGreaterThan(0);
    const plan = planLayout(scripts, 'suffix', 'live');
    const result = await writePlan(dir, plan, { force: false });
    expect(result.written.length).toBeGreaterThan(0);
    expect(() => buildDigest(dir)).not.toThrow();
  }, 120_000);
});
```

- [ ] **Step 2: Run it (only with a live Studio)**

Run: `BLOX_LIVE_ONBOARD=1 npx vitest run tests/e2e/live-onboard.test.ts`
Expected: PASS with an attached Studio; skipped when the env flag is unset.

- [ ] **Step 3: README** — add a "Non-Rojo onboarding" subsection under the existing "Run" section documenting:
  - `blox init [--project <dir>] [--on-conflict abort|suffix] [--force]` pulls the live DataModel's scripts into a Rojo project + commits a baseline.
  - Requires an attached Studio with the MCP server enabled (same as `blox doctor`).
  - After `blox init`, run `rojo serve` + Connect, then use `blox "<prompt>"` normally.
  - Note scripts-only scope + the `--on-conflict` behavior.

Commit: `git commit -am "docs: document blox init onboarding"` (after staging README).

- [ ] **Step 4: Commit the e2e**

```bash
git add tests/e2e/live-onboard.test.ts
git commit -m "test(sp4-b): gated live onboarding e2e (BLOX_LIVE_ONBOARD)"
```

---

## Final verification

- [ ] `npm run build` — clean compile (note the `command` union widened to include `'init'`; ensure the `serve`/`doctor`/`init` branches all still typecheck).
- [ ] `npx vitest run` — full unit suite green; onboard e2e skipped.
- [ ] `node dist/cli.js init --mock --project /tmp/blox-init-demo` produces a `buildDigest`-valid project (Task 6 Step 4).

## Self-review notes (author)

- **Spec coverage:** deterministic dump (Task 1, spec §3), pure mapper incl. class→suffix / nesting / init-folders / sanitize / conflict abort+suffix / project.json (Task 2, spec §4), write + refuse + abort + git baseline (Task 3, spec §5), report incl. conflicts + next-steps (Task 4, spec §6), `blox init` + `--on-conflict`/`--force` (Task 5/6, spec §6), error handling — no-attach/empty/error/existing (Tasks 1/3/6, spec §7), gated live e2e + buildDigest assertion (Task 7, spec §9). All present.
- **Type consistency:** `PulledScript` (pull) consumed by `planLayout` (layout) and the e2e; `LayoutPlan`/`Conflict`/`Renamed`/`WriteFile`/`ProjectJson` defined in layout and consumed by write + report + cli; `WriteResult` fields (`written`/`baselineSha`/`refused`/`conflictsAborted`) consistent between write.ts and cli.ts; `SpawnFn` reused from `sync/rojo`.
- **Non-goals honored:** scripts only; no two-way sync; single-dump (no chunked fallback); no interactive conflict resolution.
