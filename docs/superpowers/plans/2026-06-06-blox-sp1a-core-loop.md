# blox SP1a — Core Agentic Code Loop (no playtest) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `blox`, a TypeScript CLI on the Claude Agent SDK that takes a prompt, edits `.luau` files in a Rojo game, validates the Rojo project, commits the result, and prints a run report — proving `prompt → code → sync-check → commit` end-to-end on a minimal fixture game.

**Architecture:** A thin CLI (`src/cli.ts`) wires deterministic, unit-tested modules (config, project digest, Rojo sync wrapper, git commit, report) around the Agent SDK's `query()` loop. The live Roblox Studio MCP server sits behind a `StudioBridge` abstraction with two implementations: a real stdio bridge (official Roblox Studio MCP) and an in-process **mock** bridge for tests/dev with no Studio. Files are canonical; the agent edits them with the SDK's built-in Read/Write/Edit tools. The verify/playtest loop, bounded fix loop, and asset tools are **out of scope** (SP1b).

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥20, `@anthropic-ai/claude-agent-sdk`, `zod`, `vitest`, `tsx`. Rojo CLI (`rojo`) is required at runtime for the sync check but is mocked in all unit tests.

**Spec:** `docs/superpowers/specs/2026-06-06-blox-design.md` (§3 components 1–4, §8 SP1). **MCP reference:** `docs/reference/roblox-studio-mcp.md`.

---

## File Structure

| Path | Responsibility |
|------|----------------|
| `package.json`, `tsconfig.json`, `vitest.config.ts` | Project config, scripts, build |
| `src/cli.ts` | Entry point: parse args → load config → digest → run agent → sync-check → commit → report |
| `src/args.ts` | Pure argv parser |
| `src/config.ts` | Load + validate `BloxConfig` (project path, model, limits) via zod |
| `src/report.ts` | `RunReport` type + `formatReport()` |
| `src/context/digest.ts` | Build `ProjectDigest` from `default.project.json` + `.luau` walk |
| `src/sync/rojo.ts` | `SpawnFn`, `realSpawn`, `syncProject()` (validates Rojo project) |
| `src/git/commit.ts` | `commitChanges()` — stage, commit, return sha + file list |
| `src/bridge/types.ts` | `StudioBridge` interface + `McpServerConfig` type |
| `src/bridge/mcpBridge.ts` | Real bridge → official Roblox Studio MCP (stdio) |
| `src/bridge/mockBridge.ts` | In-process mock Studio bridge (no live Studio needed) |
| `src/agent/systemPrompt.ts` | `buildSystemPrompt(digest)` |
| `src/agent/buildOptions.ts` | Pure `buildQueryOptions()` → Agent SDK options |
| `src/agent/runAgent.ts` | Thin wrapper around `query()`; returns `AgentRunResult` |
| `test-fixtures/game/` | Minimal Rojo fixture game (the SP1a test target) |
| `tests/**/*.test.ts` | Unit tests (mirror `src/`) + gated e2e smoke |

Each module has one responsibility and is small enough to read at once. The agent orchestration is split so the deterministic option-building (`buildQueryOptions`) is unit-tested and the live `query()` loop (`runAgent`) is exercised only by the gated e2e smoke (Task 13).

---

### Task 1: Project scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Test: `tests/scaffold.test.ts`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "blox",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "bin": { "blox": "./dist/cli.js" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "engines": { "node": ">=20" }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.rbxl
*.rbxlx
.env
```

- [ ] **Step 5: Install dependencies**

Run:
```bash
cd /home/myen/blox && npm install @anthropic-ai/claude-agent-sdk zod && npm install -D typescript tsx vitest @types/node
```
Expected: `node_modules/` created, `package.json` gains `dependencies` + `devDependencies`, no errors.

- [ ] **Step 6: Write the scaffold smoke test**

`tests/scaffold.test.ts`:
```ts
import { describe, it, expect } from 'vitest';

describe('scaffold', () => {
  it('runs vitest', () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `cd /home/myen/blox && npm test`
Expected: PASS — `1 passed`.

- [ ] **Step 8: Commit**

```bash
cd /home/myen/blox && git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore tests/scaffold.test.ts && git commit -m "chore: scaffold blox TypeScript project"
```

---

### Task 2: Minimal Rojo fixture game

**Files:**
- Create: `test-fixtures/game/default.project.json`
- Create: `test-fixtures/game/src/ReplicatedStorage/Greeter.luau`
- Create: `test-fixtures/game/src/ServerScriptService/Hello.server.luau`
- Test: `tests/fixture.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/fixture.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dir = resolve(__dirname, '../test-fixtures/game');

describe('fixture game', () => {
  it('has a valid Rojo project with the expected tree', () => {
    const proj = JSON.parse(readFileSync(resolve(dir, 'default.project.json'), 'utf8'));
    expect(proj.name).toBe('blox-fixture');
    expect(Object.keys(proj.tree)).toContain('ReplicatedStorage');
    expect(Object.keys(proj.tree)).toContain('ServerScriptService');
  });

  it('ships the Greeter and Hello scripts', () => {
    const greeter = readFileSync(resolve(dir, 'src/ReplicatedStorage/Greeter.luau'), 'utf8');
    expect(greeter).toContain('function Greeter.greet');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/fixture.test.ts`
Expected: FAIL — `ENOENT` (files do not exist yet).

- [ ] **Step 3: Create `test-fixtures/game/default.project.json`**

```json
{
  "name": "blox-fixture",
  "tree": {
    "$className": "DataModel",
    "ReplicatedStorage": {
      "$className": "ReplicatedStorage",
      "Greeter": { "$path": "src/ReplicatedStorage/Greeter.luau" }
    },
    "ServerScriptService": {
      "$className": "ServerScriptService",
      "Hello": { "$path": "src/ServerScriptService/Hello.server.luau" }
    }
  }
}
```

- [ ] **Step 4: Create `test-fixtures/game/src/ReplicatedStorage/Greeter.luau`**

```lua
local Greeter = {}

function Greeter.greet(name: string): string
	return "Hello, " .. name .. "!"
end

return Greeter
```

- [ ] **Step 5: Create `test-fixtures/game/src/ServerScriptService/Hello.server.luau`**

```lua
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Greeter = require(ReplicatedStorage.Greeter)

print(Greeter.greet("world"))
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/fixture.test.ts`
Expected: PASS — `2 passed`.

- [ ] **Step 7: Commit**

```bash
cd /home/myen/blox && git add test-fixtures tests/fixture.test.ts && git commit -m "test: add minimal Rojo fixture game"
```

---

### Task 3: Config loader

**Files:**
- Create: `src/config.ts`
- Test: `tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/config.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when no config file exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    const cfg = loadConfig(dir);
    expect(cfg.projectPath).toBe(dir);
    expect(cfg.model).toBe('claude-opus-4-8');
    expect(cfg.maxTurns).toBe(40);
    expect(cfg.maxBudgetUsd).toBe(5);
  });

  it('reads blox.config.json and lets overrides win', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({ maxTurns: 10 }));
    const cfg = loadConfig(dir, { model: 'claude-opus-4-8', maxTurns: undefined });
    expect(cfg.maxTurns).toBe(10);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Write the implementation**

`src/config.ts`:
```ts
import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const BloxConfigSchema = z.object({
  projectPath: z.string(),
  model: z.string().default('claude-opus-4-8'),
  maxTurns: z.number().int().positive().default(40),
  maxBudgetUsd: z.number().positive().default(5),
});

export type BloxConfig = z.infer<typeof BloxConfigSchema>;

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(o).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

export function loadConfig(cwd: string, overrides: Partial<BloxConfig> = {}): BloxConfig {
  const file = resolve(cwd, 'blox.config.json');
  const fromFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const merged = { projectPath: cwd, ...fromFile, ...stripUndefined(overrides) };
  return BloxConfigSchema.parse(merged);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/config.test.ts`
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/myen/blox && git add src/config.ts tests/config.test.ts && git commit -m "feat: add config loader"
```

---

### Task 4: Run report type + formatter

**Files:**
- Create: `src/report.ts`
- Test: `tests/report.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/report.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { formatReport, type RunReport } from '../src/report.js';

describe('formatReport', () => {
  it('renders a success report with files and commit', () => {
    const r: RunReport = {
      prompt: 'add a comment',
      changedFiles: ['src/ReplicatedStorage/Greeter.luau'],
      commitSha: 'abc123',
      numTurns: 3,
      costUsd: 0.0123,
      status: 'success',
    };
    const out = formatReport(r);
    expect(out).toContain('blox run — success');
    expect(out).toContain('add a comment');
    expect(out).toContain('src/ReplicatedStorage/Greeter.luau');
    expect(out).toContain('commit: abc123');
    expect(out).toContain('$0.0123');
  });

  it('shows "(none)" when there is no commit', () => {
    const r: RunReport = {
      prompt: 'noop',
      changedFiles: [],
      commitSha: null,
      numTurns: 1,
      costUsd: 0,
      status: 'success',
    };
    expect(formatReport(r)).toContain('commit: (none)');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/report.test.ts`
Expected: FAIL — cannot resolve `../src/report.js`.

- [ ] **Step 3: Write the implementation**

`src/report.ts`:
```ts
export interface RunReport {
  prompt: string;
  changedFiles: string[];
  commitSha: string | null;
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  detail?: string;
}

export function formatReport(r: RunReport): string {
  const lines = [
    `blox run — ${r.status}`,
    `prompt: ${r.prompt}`,
    `turns: ${r.numTurns}  cost: $${r.costUsd.toFixed(4)}`,
    `changed files (${r.changedFiles.length}):`,
    ...r.changedFiles.map((f) => `  ${f}`),
    r.commitSha ? `commit: ${r.commitSha}` : 'commit: (none)',
  ];
  if (r.detail) lines.push(`detail: ${r.detail}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/report.test.ts`
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/myen/blox && git add src/report.ts tests/report.test.ts && git commit -m "feat: add run report formatter"
```

---

### Task 5: Project digest builder

**Files:**
- Create: `src/context/digest.ts`
- Test: `tests/digest.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/digest.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { buildDigest } from '../src/context/digest.js';

const game = resolve(__dirname, '../test-fixtures/game');

describe('buildDigest', () => {
  it('summarizes the fixture game', () => {
    const d = buildDigest(game);
    expect(d.name).toBe('blox-fixture');
    expect(d.tree).toEqual(expect.arrayContaining(['ReplicatedStorage', 'ServerScriptService']));
    expect(d.tree).not.toContain('$className');
    expect(d.scripts).toEqual(
      expect.arrayContaining([
        'src/ReplicatedStorage/Greeter.luau',
        'src/ServerScriptService/Hello.server.luau',
      ]),
    );
  });

  it('throws when there is no project file', () => {
    expect(() => buildDigest('/nonexistent')).toThrow(/default\.project\.json/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/digest.test.ts`
Expected: FAIL — cannot resolve `../src/context/digest.js`.

- [ ] **Step 3: Write the implementation**

`src/context/digest.ts`:
```ts
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';

export interface ProjectDigest {
  name: string;
  tree: string[];
  scripts: string[];
}

function walkLuau(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walkLuau(full));
    else if (entry.endsWith('.luau') || entry.endsWith('.lua')) out.push(full);
  }
  return out;
}

export function buildDigest(projectPath: string): ProjectDigest {
  const projFile = resolve(projectPath, 'default.project.json');
  if (!existsSync(projFile)) {
    throw new Error(`No default.project.json in ${projectPath}`);
  }
  const proj = JSON.parse(readFileSync(projFile, 'utf8')) as {
    name?: string;
    tree?: Record<string, unknown>;
  };
  const tree = Object.keys(proj.tree ?? {}).filter((k) => !k.startsWith('$'));
  const scripts = walkLuau(projectPath)
    .map((p) => relative(projectPath, p))
    .sort();
  return { name: proj.name ?? 'unnamed', tree, scripts };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/digest.test.ts`
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/myen/blox && git add src/context/digest.ts tests/digest.test.ts && git commit -m "feat: add project digest builder"
```

---

### Task 6: Rojo sync wrapper

**Files:**
- Create: `src/sync/rojo.ts`
- Test: `tests/rojo.test.ts`

The wrapper validates that the Rojo project is well-formed by running `rojo sourcemap` (exit 0 = valid project that would sync). The live sync (`rojo serve` + the Studio Rojo plugin) is a **manual** step documented in the README. `spawn` is injectable so tests never touch the real `rojo` binary.

- [ ] **Step 1: Write the failing test**

`tests/rojo.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { syncProject, type SpawnFn } from '../src/sync/rojo.js';

const okSpawn: SpawnFn = async () => ({ code: 0, stdout: '{}', stderr: '' });
const failSpawn: SpawnFn = async () => ({ code: 1, stdout: '', stderr: 'bad project' });

describe('syncProject', () => {
  it('reports ok when rojo sourcemap succeeds', async () => {
    const res = await syncProject('/game', okSpawn);
    expect(res.ok).toBe(true);
  });

  it('reports failure with stderr detail', async () => {
    const res = await syncProject('/game', failSpawn);
    expect(res.ok).toBe(false);
    expect(res.detail).toContain('bad project');
  });

  it('invokes rojo sourcemap in the project dir', async () => {
    const calls: Array<{ cmd: string; args: string[]; cwd: string }> = [];
    const spy: SpawnFn = async (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { code: 0, stdout: '{}', stderr: '' };
    };
    await syncProject('/game', spy);
    expect(calls[0]).toEqual({ cmd: 'rojo', args: ['sourcemap'], cwd: '/game' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/rojo.test.ts`
Expected: FAIL — cannot resolve `../src/sync/rojo.js`.

- [ ] **Step 3: Write the implementation**

`src/sync/rojo.ts`:
```ts
import { spawn as nodeSpawn } from 'node:child_process';

export type SpawnResult = { code: number; stdout: string; stderr: string };
export type SpawnFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string },
) => Promise<SpawnResult>;

export const realSpawn: SpawnFn = (cmd, args, opts) =>
  new Promise((resolveP) => {
    const child = nodeSpawn(cmd, args, { cwd: opts.cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => resolveP({ code: 1, stdout, stderr: stderr + String(e) }));
    child.on('close', (code) => resolveP({ code: code ?? 1, stdout, stderr }));
  });

export interface SyncResult {
  ok: boolean;
  detail: string;
}

export async function syncProject(
  projectPath: string,
  spawn: SpawnFn = realSpawn,
): Promise<SyncResult> {
  const res = await spawn('rojo', ['sourcemap'], { cwd: projectPath });
  if (res.code === 0) return { ok: true, detail: 'rojo sourcemap ok' };
  return { ok: false, detail: `rojo sourcemap failed: ${res.stderr.trim() || res.stdout.trim()}` };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/rojo.test.ts`
Expected: PASS — `3 passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/myen/blox && git add src/sync/rojo.ts tests/rojo.test.ts && git commit -m "feat: add rojo sync wrapper"
```

---

### Task 7: Git commit helper

**Files:**
- Create: `src/git/commit.ts`
- Test: `tests/commit.test.ts`

Reuses `SpawnFn`/`realSpawn` from `src/sync/rojo.ts`. The test runs against a **real temp git repo** so the git plumbing is exercised end-to-end.

- [ ] **Step 1: Write the failing test**

`tests/commit.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitChanges } from '../src/git/commit.js';
import { realSpawn } from '../src/sync/rojo.js';

async function initRepo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'blox-git-'));
  await realSpawn('git', ['init'], { cwd: dir });
  await realSpawn('git', ['config', 'user.email', 'test@blox.dev'], { cwd: dir });
  await realSpawn('git', ['config', 'user.name', 'blox test'], { cwd: dir });
  return dir;
}

describe('commitChanges', () => {
  it('returns null sha and empty files when nothing changed', async () => {
    const dir = await initRepo();
    const res = await commitChanges(dir, 'noop');
    expect(res.sha).toBeNull();
    expect(res.files).toEqual([]);
  });

  it('stages and commits changed files, returning the sha', async () => {
    const dir = await initRepo();
    writeFileSync(join(dir, 'a.luau'), 'return 1\n');
    const res = await commitChanges(dir, 'add a.luau');
    expect(res.files).toContain('a.luau');
    expect(res.sha).toMatch(/^[0-9a-f]{7,40}$/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/commit.test.ts`
Expected: FAIL — cannot resolve `../src/git/commit.js`.

- [ ] **Step 3: Write the implementation**

`src/git/commit.ts`:
```ts
import { realSpawn, type SpawnFn } from '../sync/rojo.js';

export interface CommitResult {
  sha: string | null;
  files: string[];
}

export async function commitChanges(
  projectPath: string,
  message: string,
  spawn: SpawnFn = realSpawn,
): Promise<CommitResult> {
  const status = await spawn('git', ['status', '--porcelain'], { cwd: projectPath });
  const files = status.stdout
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  if (files.length === 0) return { sha: null, files: [] };

  await spawn('git', ['add', '-A'], { cwd: projectPath });
  const commit = await spawn('git', ['commit', '-m', message], { cwd: projectPath });
  if (commit.code !== 0) return { sha: null, files };

  const rev = await spawn('git', ['rev-parse', 'HEAD'], { cwd: projectPath });
  return { sha: rev.stdout.trim() || null, files };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/commit.test.ts`
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/myen/blox && git add src/git/commit.ts tests/commit.test.ts && git commit -m "feat: add git commit helper"
```

---

### Task 8: Studio bridge abstraction (types + real + mock)

**Files:**
- Create: `src/bridge/types.ts`
- Create: `src/bridge/mcpBridge.ts`
- Create: `src/bridge/mockBridge.ts`
- Test: `tests/bridge.test.ts`

The `StudioBridge` interface hides whether the live DataModel comes from the official Roblox Studio MCP (stdio) or an in-process mock. The real bridge's command is env-configurable (`BLOX_STUDIO_MCP_CMD` / `BLOX_STUDIO_MCP_ARGS`) because the official server's binary name/path is environment-specific — see README. The mock exposes stub `search_game_tree` / `inspect_instance` tools so the agent loop runs with no live Studio.

- [ ] **Step 1: Write the failing test**

`tests/bridge.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { createStudioMcpBridge } from '../src/bridge/mcpBridge.js';
import { createMockStudioBridge } from '../src/bridge/mockBridge.js';

describe('real studio bridge', () => {
  it('exposes a stdio MCP server config under roblox_studio', () => {
    const b = createStudioMcpBridge();
    const servers = b.mcpServers();
    expect(servers).toHaveProperty('roblox_studio');
    const cfg = servers.roblox_studio as { type?: string; command: string };
    expect(cfg.type).toBe('stdio');
    expect(typeof cfg.command).toBe('string');
  });

  it('allows only mcp__roblox_studio__* tools', () => {
    const b = createStudioMcpBridge();
    for (const t of b.allowedTools()) {
      expect(t.startsWith('mcp__roblox_studio__')).toBe(true);
    }
  });
});

describe('mock studio bridge', () => {
  it('exposes an in-process server and read-only tools', () => {
    const b = createMockStudioBridge();
    expect(b.mcpServers()).toHaveProperty('roblox_studio');
    expect(b.allowedTools()).toContain('mcp__roblox_studio__search_game_tree');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/bridge.test.ts`
Expected: FAIL — cannot resolve the bridge modules.

- [ ] **Step 3: Write `src/bridge/types.ts`**

```ts
export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'sse' | 'http'; url: string; headers?: Record<string, string> }
  | Record<string, unknown>;

export interface StudioBridge {
  /** MCP servers exposed to the agent, keyed by server name. */
  mcpServers(): Record<string, McpServerConfig>;
  /** Fully-qualified tool names the agent may call without prompting. */
  allowedTools(): string[];
}
```

- [ ] **Step 4: Write `src/bridge/mcpBridge.ts`**

```ts
import type { StudioBridge, McpServerConfig } from './types.js';

// Real bridge → official Roblox Studio MCP server over stdio.
// The binary name/path is environment-specific; configure via env.
export function createStudioMcpBridge(): StudioBridge {
  const command = process.env.BLOX_STUDIO_MCP_CMD ?? 'rbx-studio-mcp';
  // Official server speaks MCP over stdio when launched with --stdio.
  const args = (process.env.BLOX_STUDIO_MCP_ARGS ?? '--stdio').split(' ').filter(Boolean);
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      roblox_studio: { type: 'stdio', command, args },
    }),
    allowedTools: () => [
      'mcp__roblox_studio__search_game_tree',
      'mcp__roblox_studio__inspect_instance',
      'mcp__roblox_studio__script_read',
    ],
  };
}
```

- [ ] **Step 5: Write `src/bridge/mockBridge.ts`**

```ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { StudioBridge, McpServerConfig } from './types.js';

// In-process fake Studio bridge for tests/dev without a live Studio.
export function createMockStudioBridge(): StudioBridge {
  const server = createSdkMcpServer({
    name: 'roblox_studio',
    version: '0.0.0',
    tools: [
      tool(
        'search_game_tree',
        'Return the (fake) DataModel tree',
        { query: z.string().optional() },
        async () => ({
          content: [
            { type: 'text', text: '[mock] Workspace, ReplicatedStorage, ServerScriptService' },
          ],
        }),
      ),
      tool(
        'inspect_instance',
        'Return (fake) instance details',
        { path: z.string() },
        async ({ path }) => ({
          content: [{ type: 'text', text: `[mock] instance ${path}: {}` }],
        }),
      ),
    ],
  });
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      roblox_studio: server as unknown as McpServerConfig,
    }),
    allowedTools: () => [
      'mcp__roblox_studio__search_game_tree',
      'mcp__roblox_studio__inspect_instance',
    ],
  };
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/bridge.test.ts`
Expected: PASS — `3 passed`.

- [ ] **Step 7: Commit**

```bash
cd /home/myen/blox && git add src/bridge tests/bridge.test.ts && git commit -m "feat: add studio bridge abstraction with real and mock implementations"
```

---

### Task 9: System prompt builder

**Files:**
- Create: `src/agent/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/systemPrompt.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../src/agent/systemPrompt.js';
import type { ProjectDigest } from '../src/context/digest.js';

const digest: ProjectDigest = {
  name: 'blox-fixture',
  tree: ['ReplicatedStorage', 'ServerScriptService'],
  scripts: ['src/ReplicatedStorage/Greeter.luau'],
};

describe('buildSystemPrompt', () => {
  it('orients the agent to Roblox/Luau and embeds the digest', () => {
    const p = buildSystemPrompt(digest);
    expect(p).toContain('blox');
    expect(p).toContain('Luau');
    expect(p).toContain('Rojo');
    expect(p).toContain('blox-fixture');
    expect(p).toContain('ReplicatedStorage, ServerScriptService');
    expect(p).toContain('src/ReplicatedStorage/Greeter.luau');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/systemPrompt.test.ts`
Expected: FAIL — cannot resolve `../src/agent/systemPrompt.js`.

- [ ] **Step 3: Write the implementation**

`src/agent/systemPrompt.ts`:
```ts
import type { ProjectDigest } from '../context/digest.js';

export function buildSystemPrompt(digest: ProjectDigest): string {
  return [
    'You are blox, an agentic coding assistant for Roblox games.',
    'You write idiomatic Luau and edit .luau files on disk. Files are canonical;',
    'Rojo one-way syncs them into Roblox Studio. Do NOT edit instances directly —',
    'only the Studio MCP tools may read the live DataModel.',
    '',
    'Rules:',
    '- Edit only .luau/.lua files using the Read/Write/Edit tools.',
    '- Keep changes minimal and scoped to the request.',
    '- Match the existing code style (tabs, naming, typing).',
    '',
    `Project: ${digest.name}`,
    `Top-level tree: ${digest.tree.join(', ') || '(none)'}`,
    `Scripts (${digest.scripts.length}):`,
    ...digest.scripts.map((s) => `  ${s}`),
  ].join('\n');
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/systemPrompt.test.ts`
Expected: PASS — `1 passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/myen/blox && git add src/agent/systemPrompt.ts tests/systemPrompt.test.ts && git commit -m "feat: add system prompt builder"
```

---

### Task 10: Agent query options builder

**Files:**
- Create: `src/agent/buildOptions.ts`
- Test: `tests/buildOptions.test.ts`

This is the pure, fully-tested core of the agent wiring. It assembles the Agent SDK options object. `settingSources: []` isolates blox from the user's Claude Code settings; `permissionMode: 'bypassPermissions'` makes the single-shot CLI non-interactive; the tool whitelist is the built-in file tools plus the bridge's read-only Studio tools (no Bash — sync and commit are done by the harness).

- [ ] **Step 1: Write the failing test**

`tests/buildOptions.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { buildQueryOptions } from '../src/agent/buildOptions.js';
import { createMockStudioBridge } from '../src/bridge/mockBridge.js';
import type { BloxConfig } from '../src/config.js';
import type { ProjectDigest } from '../src/context/digest.js';

const config: BloxConfig = {
  projectPath: '/game',
  model: 'claude-opus-4-8',
  maxTurns: 40,
  maxBudgetUsd: 5,
};
const digest: ProjectDigest = { name: 'g', tree: [], scripts: [] };

describe('buildQueryOptions', () => {
  it('maps config to Agent SDK options', () => {
    const o = buildQueryOptions(config, createMockStudioBridge(), digest);
    expect(o.model).toBe('claude-opus-4-8');
    expect(o.cwd).toBe('/game');
    expect(o.maxTurns).toBe(40);
    expect(o.maxBudgetUsd).toBe(5);
    expect(o.permissionMode).toBe('bypassPermissions');
    expect(o.settingSources).toEqual([]);
    expect(o.thinking).toEqual({ type: 'adaptive' });
    expect(typeof o.systemPrompt).toBe('string');
  });

  it('whitelists file tools plus bridge tools and no Bash', () => {
    const o = buildQueryOptions(config, createMockStudioBridge(), digest);
    expect(o.allowedTools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Grep', 'Glob']));
    expect(o.allowedTools).toContain('mcp__roblox_studio__search_game_tree');
    expect(o.allowedTools).not.toContain('Bash');
    expect(o.mcpServers).toHaveProperty('roblox_studio');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/buildOptions.test.ts`
Expected: FAIL — cannot resolve `../src/agent/buildOptions.js`.

- [ ] **Step 3: Write the implementation**

`src/agent/buildOptions.ts`:
```ts
import type { BloxConfig } from '../config.js';
import type { StudioBridge, McpServerConfig } from '../bridge/types.js';
import type { ProjectDigest } from '../context/digest.js';
import { buildSystemPrompt } from './systemPrompt.js';

export interface QueryOptionsLike {
  model: string;
  cwd: string;
  systemPrompt: string;
  maxTurns: number;
  maxBudgetUsd: number;
  permissionMode: 'bypassPermissions';
  settingSources: never[];
  thinking: { type: 'adaptive' };
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
}

const FILE_TOOLS = ['Read', 'Write', 'Edit', 'Grep', 'Glob'];

export function buildQueryOptions(
  config: BloxConfig,
  bridge: StudioBridge,
  digest: ProjectDigest,
): QueryOptionsLike {
  return {
    model: config.model,
    cwd: config.projectPath,
    systemPrompt: buildSystemPrompt(digest),
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    permissionMode: 'bypassPermissions',
    settingSources: [],
    thinking: { type: 'adaptive' },
    allowedTools: [...FILE_TOOLS, ...bridge.allowedTools()],
    mcpServers: bridge.mcpServers(),
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/buildOptions.test.ts`
Expected: PASS — `2 passed`.

- [ ] **Step 5: Commit**

```bash
cd /home/myen/blox && git add src/agent/buildOptions.ts tests/buildOptions.test.ts && git commit -m "feat: add agent query options builder"
```

---

### Task 11: Agent runner (query() wrapper)

**Files:**
- Create: `src/agent/runAgent.ts`

This is a thin wrapper over the SDK's `query()` async generator; it has no pure logic to unit-test in isolation (it requires a live API call), so it is covered by the gated e2e smoke in Task 13. Keep it minimal.

- [ ] **Step 1: Write the implementation**

`src/agent/runAgent.ts`:
```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryOptionsLike } from './buildOptions.js';

export interface AgentRunResult {
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  detail: string;
}

export async function runAgent(
  prompt: string,
  options: QueryOptionsLike,
): Promise<AgentRunResult> {
  let result: AgentRunResult = { numTurns: 0, costUsd: 0, status: 'error', detail: 'no result' };
  for await (const message of query({ prompt, options: options as never })) {
    if (message.type === 'result') {
      result = {
        numTurns: message.num_turns,
        costUsd: message.total_cost_usd,
        status: message.subtype === 'success' ? 'success' : 'error',
        detail: message.subtype,
      };
    }
  }
  return result;
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd /home/myen/blox && npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /home/myen/blox && git add src/agent/runAgent.ts && git commit -m "feat: add agent query runner"
```

---

### Task 12: CLI entry point + arg parser

**Files:**
- Create: `src/args.ts`
- Create: `src/cli.ts`
- Test: `tests/args.test.ts`

- [ ] **Step 1: Write the failing test for the arg parser**

`tests/args.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('joins positional words into the prompt', () => {
    const a = parseArgs(['add', 'a', 'comment']);
    expect(a.prompt).toBe('add a comment');
    expect(a.mock).toBe(false);
    expect(a.projectPath).toBeNull();
  });

  it('parses --mock and --project', () => {
    const a = parseArgs(['--mock', '--project', '/game', 'do', 'thing']);
    expect(a.mock).toBe(true);
    expect(a.projectPath).toBe('/game');
    expect(a.prompt).toBe('do thing');
  });

  it('returns null prompt when none given', () => {
    expect(parseArgs(['--mock']).prompt).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd /home/myen/blox && npx vitest run tests/args.test.ts`
Expected: FAIL — cannot resolve `../src/args.js`.

- [ ] **Step 3: Write `src/args.ts`**

```ts
export interface ParsedArgs {
  prompt: string | null;
  mock: boolean;
  projectPath: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let mock = false;
  let projectPath: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') mock = true;
    else if (a === '--project') projectPath = argv[++i] ?? null;
    else positional.push(a);
  }
  return { prompt: positional.join(' ').trim() || null, mock, projectPath };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd /home/myen/blox && npx vitest run tests/args.test.ts`
Expected: PASS — `3 passed`.

- [ ] **Step 5: Write `src/cli.ts`**

```ts
#!/usr/bin/env node
import { parseArgs } from './args.js';
import { loadConfig } from './config.js';
import { buildDigest } from './context/digest.js';
import { syncProject } from './sync/rojo.js';
import { commitChanges } from './git/commit.js';
import { createStudioMcpBridge } from './bridge/mcpBridge.js';
import { createMockStudioBridge } from './bridge/mockBridge.js';
import { buildQueryOptions } from './agent/buildOptions.js';
import { runAgent } from './agent/runAgent.js';
import { formatReport, type RunReport } from './report.js';

async function main(): Promise<void> {
  const { prompt, mock, projectPath } = parseArgs(process.argv.slice(2));
  if (!prompt) {
    console.error('usage: blox "<prompt>" [--mock] [--project <dir>]');
    process.exit(2);
  }

  const cwd = projectPath ?? process.cwd();
  const config = loadConfig(cwd, projectPath ? { projectPath } : {});
  const digest = buildDigest(config.projectPath);
  const bridge = mock ? createMockStudioBridge() : createStudioMcpBridge();
  const options = buildQueryOptions(config, bridge, digest);

  const agent = await runAgent(prompt, options);
  const sync = await syncProject(config.projectPath);
  const commit = sync.ok
    ? await commitChanges(config.projectPath, `blox: ${prompt}`.slice(0, 72))
    : { sha: null, files: [] };

  const report: RunReport = {
    prompt,
    changedFiles: commit.files,
    commitSha: commit.sha,
    numTurns: agent.numTurns,
    costUsd: agent.costUsd,
    status: agent.status === 'success' && sync.ok ? 'success' : 'error',
    detail: sync.ok ? agent.detail : sync.detail,
  };
  console.log(formatReport(report));
  process.exit(report.status === 'success' ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 6: Build and confirm the CLI prints usage**

Run: `cd /home/myen/blox && npm run build && node dist/cli.js`
Expected: prints `usage: blox "<prompt>" [--mock] [--project <dir>]` and exits non-zero.

- [ ] **Step 7: Run the full test suite**

Run: `cd /home/myen/blox && npm test`
Expected: PASS — all unit tests green (scaffold, fixture, config, report, digest, rojo, commit, bridge, systemPrompt, buildOptions, args).

- [ ] **Step 8: Commit**

```bash
cd /home/myen/blox && git add src/args.ts src/cli.ts tests/args.test.ts && git commit -m "feat: wire blox CLI entry point"
```

---

### Task 13: Gated end-to-end smoke + README

**Files:**
- Create: `tests/e2e/smoke.test.ts`
- Create: `README.md`

The smoke test is the **manual live checkpoint**: it runs the real CLI (real Agent SDK + API) against a temp copy of the fixture game, using `--mock` for the Studio bridge so no live Studio is needed. It is skipped unless `BLOX_E2E=1` and `ANTHROPIC_API_KEY` are set, so CI stays green without credentials.

- [ ] **Step 1: Write the gated smoke test**

`tests/e2e/smoke.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { realSpawn } from '../../src/sync/rojo.js';

const enabled = process.env.BLOX_E2E === '1' && !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!enabled)('blox e2e smoke', () => {
  it('edits a script and commits via the built CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-e2e-'));
    cpSync(resolve(__dirname, '../../test-fixtures/game'), dir, { recursive: true });
    await realSpawn('git', ['init'], { cwd: dir });
    await realSpawn('git', ['config', 'user.email', 'e2e@blox.dev'], { cwd: dir });
    await realSpawn('git', ['config', 'user.name', 'blox e2e'], { cwd: dir });
    await realSpawn('git', ['add', '-A'], { cwd: dir });
    await realSpawn('git', ['commit', '-m', 'init'], { cwd: dir });

    const cli = resolve(__dirname, '../../dist/cli.js');
    const res = await realSpawn(
      'node',
      [cli, '--mock', '--project', dir, 'Add a one-line comment to the top of Greeter.luau'],
      { cwd: dir },
    );
    expect(res.code).toBe(0);

    const log = await realSpawn('git', ['log', '--oneline'], { cwd: dir });
    expect(log.stdout).toMatch(/blox:/);
  }, 180_000);
});
```

- [ ] **Step 2: Confirm the smoke test is skipped without env**

Run: `cd /home/myen/blox && npx vitest run tests/e2e/smoke.test.ts`
Expected: the test is **skipped** (`1 skipped`), suite passes.

- [ ] **Step 3: Run the live smoke (manual checkpoint — requires `ANTHROPIC_API_KEY` + rojo installed)**

Run:
```bash
cd /home/myen/blox && npm run build && BLOX_E2E=1 npx vitest run tests/e2e/smoke.test.ts
```
Expected: PASS — a `blox:` commit appears in the temp repo's git log. If `rojo` is not installed, install it first (`cargo install rojo` or download a release binary) — the sync check requires it.

> If you cannot run the live smoke now, leave Step 3 unchecked and note it. The skipped run in Step 2 is sufficient to merge SP1a; the live run is the manual verification gate.

- [ ] **Step 4: Write `README.md`**

````markdown
# blox

Agentic coding tool for Roblox Studio (SP1a — core code loop).

## Install

```bash
npm install
npm run build
```

Requirements: Node ≥20, `rojo` on PATH, `ANTHROPIC_API_KEY` in the environment.

## Run

```bash
# Against the fixture game with the mock Studio bridge (no live Studio):
node dist/cli.js --mock --project test-fixtures/game "Add a greeting helper to Greeter.luau"

# Against your own Rojo game with the live Studio MCP bridge:
export BLOX_STUDIO_MCP_CMD=rbx-studio-mcp   # path/name of the official Roblox Studio MCP server
node dist/cli.js --project /path/to/game "..."
```

blox edits `.luau` files, validates the Rojo project (`rojo sourcemap`), commits the
change, and prints a report.

## Live Studio sync (manual)

The CLI only *validates* the Rojo project. To push edits into a running Studio,
run `rojo serve` in the project dir and connect the Rojo plugin in Studio. Enable
the Roblox Studio MCP server in Studio's Assistant settings so the live bridge can
read the DataModel.

## Test

```bash
npm test                              # unit tests (no API key, no Studio)
BLOX_E2E=1 npx vitest run tests/e2e   # live end-to-end smoke (needs API key + rojo)
```

## Scope

SP1a is the core loop: prompt → edit `.luau` → Rojo project check → commit → report.
The verify/playtest loop, bounded fix loop, and asset generation are SP1b.
````

- [ ] **Step 5: Commit**

```bash
cd /home/myen/blox && git add tests/e2e/smoke.test.ts README.md && git commit -m "test: add gated e2e smoke and README"
```

---

## Definition of Done (SP1a)

- `npm test` passes (all unit tests; e2e skipped without env).
- `npm run build` produces `dist/cli.js`; `node dist/cli.js` prints usage.
- Running blox against the fixture game with `--mock` edits a `.luau` file and produces a `blox:` git commit (verified by the live smoke, Task 13 Step 3).
- The Studio bridge is abstracted (`StudioBridge`) with real + mock implementations, ready for SP1b to add verify/playtest tools.

## Out of scope (SP1b)

Headless code-test tier (`execute_luau` / `run_script_in_play_mode`), play-session tier (`start_stop_play` / `console_output` / `playtest_subagent`), bounded autonomous fix loop, and asset generation tools (`generate_mesh` / `generate_material` / `generate_procedural_model` / `insert_from_creator_store`).
