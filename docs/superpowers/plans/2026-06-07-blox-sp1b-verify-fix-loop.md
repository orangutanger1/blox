# blox SP1b — Verify/Fix Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an autonomous tier-1 verify→fix loop (agent runs Luau via `execute_luau`, gated by a blox-owned Rojo-sync hook), expose thin asset-generation tools, and migrate the Studio bridge off the deprecated Rust MCP server to the built-in Studio MCP server.

**Architecture:** The agent drives iteration inside a single Agent SDK `query()` session. Bounding is fully SDK-native (`maxTurns` + `maxBudgetUsd`). The one blox-owned piece of orchestration is a **PreToolUse hook** that runs `syncProject()` (real Rojo) before every `execute_luau` call, so tests always run against current `.luau` files. `runAgent` maps the result `subtype` to a `stopReason` for the report.

**Tech Stack:** TypeScript (ESM, native `tsc` v6), `@anthropic-ai/claude-agent-sdk` (hooks, in-process MCP tools), zod v4, vitest, rojo.

**Spec:** `docs/superpowers/specs/2026-06-07-blox-sp1b-verify-fix-loop-design.md`

**Executor note:** Run each task's *scoped* test command (shown in its steps). The server-name rename (`roblox_studio` → `Roblox_Studio`) means a full `npm test` is briefly red between Task 2 and Task 4 (`buildOptions.test.ts` is realigned in Task 4). The whole suite is green again at Final Verification.

---

## File Structure

**Create:**
- `src/agent/hooks.ts` — `buildSyncHook(projectPath, spawn?)`: the PreToolUse Rojo-sync gate + the `EXECUTE_LUAU_TOOL` constant.
- `tests/hooks.test.ts` — unit tests for the sync hook (injected `SpawnFn`).
- `tests/runAgent.test.ts` — unit tests for `classifyStop`.
- `tests/rojo.integration.test.ts` — real-rojo sourcemap against the fixture (self-skips when rojo absent).

**Modify:**
- `src/bridge/mcpBridge.ts` — server key `Roblox_Studio`, per-platform launch command, expanded `allowedTools`.
- `src/bridge/mockBridge.ts` — `Roblox_Studio` server, `execute_luau` + asset mocks, `sequenceResponder` util, expanded `allowedTools`.
- `src/agent/hooks.ts` — (created above).
- `src/agent/buildOptions.ts` — add `hooks` (keep `maxBudgetUsd`).
- `src/agent/runAgent.ts` — `classifyStop` + `stopReason` on `AgentRunResult`.
- `src/agent/systemPrompt.ts` — verify-loop + asset guidance.
- `src/report.ts` — `stopReason` field + rendering.
- `src/cli.ts` — pass `agent.stopReason` into the report.
- `tests/bridge.test.ts`, `tests/buildOptions.test.ts`, `tests/systemPrompt.test.ts`, `tests/report.test.ts` — updated expectations.

---

## Task 1: Migrate the real Studio bridge to the built-in MCP server

**Files:**
- Modify: `src/bridge/mcpBridge.ts`
- Test: `tests/bridge.test.ts` (the `real studio bridge` describe block)

- [ ] **Step 1: Update the failing tests**

Replace the `describe('real studio bridge', …)` block in `tests/bridge.test.ts` with:

```ts
describe('real studio bridge', () => {
  it('exposes a stdio MCP server config under Roblox_Studio', () => {
    const b = createStudioMcpBridge();
    const servers = b.mcpServers();
    expect(servers).toHaveProperty('Roblox_Studio');
    const cfg = servers.Roblox_Studio as { type?: string; command: string };
    expect(cfg.type).toBe('stdio');
    expect(typeof cfg.command).toBe('string');
  });

  it('allows only mcp__Roblox_Studio__* tools, incl execute_luau and asset gen', () => {
    const b = createStudioMcpBridge();
    for (const t of b.allowedTools()) {
      expect(t.startsWith('mcp__Roblox_Studio__')).toBe(true);
    }
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__execute_luau');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__generate_mesh');
  });

  it('honors the BLOX_STUDIO_MCP_CMD override', () => {
    const prev = process.env.BLOX_STUDIO_MCP_CMD;
    process.env.BLOX_STUDIO_MCP_CMD = '/custom/StudioMCP';
    try {
      const cfg = createStudioMcpBridge().mcpServers().Roblox_Studio as { command: string };
      expect(cfg.command).toBe('/custom/StudioMCP');
    } finally {
      if (prev === undefined) delete process.env.BLOX_STUDIO_MCP_CMD;
      else process.env.BLOX_STUDIO_MCP_CMD = prev;
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bridge.test.ts`
Expected: FAIL — `expect(servers).toHaveProperty('Roblox_Studio')` fails (current key is `roblox_studio`).

- [ ] **Step 3: Rewrite `src/bridge/mcpBridge.ts`**

```ts
import type { StudioBridge, McpServerConfig } from './types.js';

// Built-in Roblox Studio MCP server (https://create.roblox.com/docs/studio/mcp).
// Transport is stdio. The launch command differs per OS; override via env.
// (The standalone Rust server `rbx-studio-mcp` is deprecated.)
function launcher(): { command: string; args: string[] } {
  const override = process.env.BLOX_STUDIO_MCP_CMD;
  if (override) {
    const args = (process.env.BLOX_STUDIO_MCP_ARGS ?? '').split(' ').filter(Boolean);
    return { command: override, args };
  }
  if (process.platform === 'darwin') {
    return { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] };
  }
  // Windows and WSL (linux) both reach the Windows batch launcher via cmd.exe.
  return { command: 'cmd.exe', args: ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'] };
}

// SP1b tool surface: read/search the game + run Luau + generate prototype assets.
// Out of scope: multi_edit (files are canonical via Rojo) and all tier-2/input/session tools.
const TOOLS = [
  'search_game_tree',
  'inspect_instance',
  'script_read',
  'script_search',
  'script_grep',
  'execute_luau',
  'generate_mesh',
  'generate_material',
  'generate_procedural_model',
  'insert_from_creator_store',
];

export function createStudioMcpBridge(): StudioBridge {
  const { command, args } = launcher();
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      Roblox_Studio: { type: 'stdio', command, args },
    }),
    allowedTools: () => TOOLS.map((t) => `mcp__Roblox_Studio__${t}`),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/bridge.test.ts`
Expected: all `bridge.test.ts` tests PASS — the three updated `real studio bridge` tests match the rewritten `mcpBridge.ts`, and the `mock studio bridge` test still passes because `mockBridge.ts` is untouched until Task 2.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/mcpBridge.ts tests/bridge.test.ts
git commit -m "feat: migrate studio bridge to built-in MCP server

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Enrich the mock bridge + add `sequenceResponder`

**Files:**
- Modify: `src/bridge/mockBridge.ts`
- Test: `tests/bridge.test.ts` (the `mock studio bridge` block + a new `sequenceResponder` block)

- [ ] **Step 1: Update / add the failing tests**

In `tests/bridge.test.ts`, update the import line to include `sequenceResponder`:

```ts
import { createMockStudioBridge, sequenceResponder } from '../src/bridge/mockBridge.js';
```

Replace the `describe('mock studio bridge', …)` block and append a new block:

```ts
describe('mock studio bridge', () => {
  it('exposes a Roblox_Studio server with execute_luau and asset tools', () => {
    const b = createMockStudioBridge();
    expect(b.mcpServers()).toHaveProperty('Roblox_Studio');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__execute_luau');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__generate_material');
  });
});

describe('sequenceResponder', () => {
  it('returns successive entries then repeats the last', () => {
    const next = sequenceResponder(['a', 'b']);
    expect(next()).toBe('a');
    expect(next()).toBe('b');
    expect(next()).toBe('b');
  });

  it('returns empty string when given no entries', () => {
    const next = sequenceResponder([]);
    expect(next()).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/bridge.test.ts`
Expected: FAIL — `sequenceResponder` is not exported; mock asserts the old name.

- [ ] **Step 3: Rewrite `src/bridge/mockBridge.ts`**

```ts
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { StudioBridge, McpServerConfig } from './types.js';

// Returns successive entries; repeats the last once exhausted.
// Lets a dev/gated run script a fix loop (e.g. fail -> fail -> pass).
export function sequenceResponder(results: string[]): () => string {
  let i = 0;
  return () => {
    const v = results[Math.min(i, results.length - 1)] ?? '';
    i++;
    return v;
  };
}

export interface MockBridgeOptions {
  /** Successive execute_luau outputs; the last repeats. */
  luauResults?: string[];
}

// In-process fake Studio bridge for tests/dev without a live Studio.
export function createMockStudioBridge(opts: MockBridgeOptions = {}): StudioBridge {
  const nextLuau = sequenceResponder(opts.luauResults ?? ['[mock] ok: tests passed']);
  const server = createSdkMcpServer({
    name: 'Roblox_Studio',
    version: '0.0.0',
    tools: [
      tool('search_game_tree', 'Return the (fake) DataModel tree', { query: z.string().optional() },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] Workspace, ReplicatedStorage, ServerScriptService' }] })),
      tool('inspect_instance', 'Return (fake) instance details', { path: z.string() },
        async ({ path }) => ({ content: [{ type: 'text' as const, text: `[mock] instance ${path}: {}` }] })),
      tool('execute_luau', 'Run (fake) Luau and return canned output', { code: z.string() },
        async () => ({ content: [{ type: 'text' as const, text: nextLuau() }] })),
      tool('generate_mesh', 'Return a (fake) generated mesh id', { prompt: z.string() },
        async ({ prompt }) => ({ content: [{ type: 'text' as const, text: `[mock] mesh for: ${prompt}` }] })),
      tool('generate_material', 'Return a (fake) generated material id', { prompt: z.string() },
        async ({ prompt }) => ({ content: [{ type: 'text' as const, text: `[mock] material for: ${prompt}` }] })),
      tool('generate_procedural_model', 'Return a (fake) procedural model', { prompt: z.string() },
        async ({ prompt }) => ({ content: [{ type: 'text' as const, text: `[mock] model for: ${prompt}` }] })),
      tool('insert_from_creator_store', 'Insert a (fake) creator-store asset', { assetId: z.string() },
        async ({ assetId }) => ({ content: [{ type: 'text' as const, text: `[mock] inserted ${assetId}` }] })),
    ],
  });
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      Roblox_Studio: server as unknown as McpServerConfig,
    }),
    allowedTools: () =>
      [
        'search_game_tree', 'inspect_instance', 'execute_luau',
        'generate_mesh', 'generate_material', 'generate_procedural_model', 'insert_from_creator_store',
      ].map((t) => `mcp__Roblox_Studio__${t}`),
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/bridge.test.ts`
Expected: PASS (all bridge + sequenceResponder tests).

- [ ] **Step 5: Commit**

```bash
git add src/bridge/mockBridge.ts tests/bridge.test.ts
git commit -m "feat: enrich mock bridge with execute_luau and asset tools

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: The PreToolUse Rojo-sync hook

**Files:**
- Create: `src/agent/hooks.ts`
- Test: `tests/hooks.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/hooks.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildSyncHook } from '../src/agent/hooks.js';
import type { SpawnFn } from '../src/sync/rojo.js';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

type SyncOut = { continue?: boolean; hookSpecificOutput?: { additionalContext?: string } };

const preExecuteLuau = {
  hook_event_name: 'PreToolUse',
  tool_name: 'mcp__Roblox_Studio__execute_luau',
  tool_input: {},
  tool_use_id: 't1',
  session_id: 's',
  transcript_path: '',
  cwd: '/game',
} as unknown as HookInput;

const preOtherTool = {
  ...preExecuteLuau,
  tool_name: 'mcp__Roblox_Studio__search_game_tree',
} as unknown as HookInput;

const signal = new AbortController().signal;

describe('buildSyncHook', () => {
  it('runs rojo sourcemap before execute_luau and continues', async () => {
    const calls: string[] = [];
    const spy: SpawnFn = async (cmd, args, opts) => {
      calls.push(`${cmd} ${args.join(' ')} @${opts.cwd}`);
      return { code: 0, stdout: '{}', stderr: '' };
    };
    const hook = buildSyncHook('/game', spy);
    const out = (await hook(preExecuteLuau, 't1', { signal })) as SyncOut;
    expect(calls).toEqual(['rojo sourcemap @/game']);
    expect(out.continue).toBe(true);
  });

  it('does not sync for other tools', async () => {
    const calls: string[] = [];
    const spy: SpawnFn = async () => {
      calls.push('x');
      return { code: 0, stdout: '', stderr: '' };
    };
    const hook = buildSyncHook('/game', spy);
    const out = (await hook(preOtherTool, 't1', { signal })) as SyncOut;
    expect(calls).toEqual([]);
    expect(out.continue).toBe(true);
  });

  it('surfaces a sync failure via additionalContext but still continues', async () => {
    const failSpawn: SpawnFn = async () => ({ code: 1, stdout: '', stderr: 'bad project' });
    const hook = buildSyncHook('/game', failSpawn);
    const out = (await hook(preExecuteLuau, 't1', { signal })) as SyncOut;
    expect(out.continue).toBe(true);
    expect(out.hookSpecificOutput?.additionalContext).toContain('bad project');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/hooks.test.ts`
Expected: FAIL — `Cannot find module '../src/agent/hooks.js'`.

- [ ] **Step 3: Create `src/agent/hooks.ts`**

```ts
import type { HookCallback, HookInput, HookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { syncProject, realSpawn, type SpawnFn } from '../sync/rojo.js';

export const EXECUTE_LUAU_TOOL = 'mcp__Roblox_Studio__execute_luau';

// PreToolUse gate: push .luau files to Studio via Rojo before the agent runs
// Luau tests, so execute_luau always sees current files. blox owns sync; the
// agent owns when/what to test.
export function buildSyncHook(projectPath: string, spawn: SpawnFn = realSpawn): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return { continue: true };
    if (input.tool_name !== EXECUTE_LUAU_TOOL) return { continue: true };

    const res = await syncProject(projectPath, spawn);
    if (res.ok) return { continue: true };

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `Rojo sync failed before running tests: ${res.detail}. Files may be stale in Studio.`,
      },
    };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/hooks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/hooks.ts tests/hooks.test.ts
git commit -m "feat: add PreToolUse rojo-sync hook for execute_luau

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Wire the sync hook into the query options

**Files:**
- Modify: `src/agent/buildOptions.ts`
- Test: `tests/buildOptions.test.ts`

- [ ] **Step 1: Update the failing test**

In `tests/buildOptions.test.ts`, replace the two `roblox_studio` references and add hook assertions. The full updated file:

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
    expect(o.allowDangerouslySkipPermissions).toBe(true);
    expect(o.settingSources).toEqual([]);
    expect(o.thinking).toEqual({ type: 'adaptive' });
    expect(typeof o.systemPrompt).toBe('string');
  });

  it('whitelists file tools plus bridge tools and no Bash', () => {
    const o = buildQueryOptions(config, createMockStudioBridge(), digest);
    expect(o.allowedTools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit', 'Grep', 'Glob']));
    expect(o.allowedTools).toContain('mcp__Roblox_Studio__search_game_tree');
    expect(o.allowedTools).not.toContain('Bash');
    expect(o.mcpServers).toHaveProperty('Roblox_Studio');
  });

  it('registers a PreToolUse sync hook for execute_luau', () => {
    const o = buildQueryOptions(config, createMockStudioBridge(), digest);
    const pre = o.hooks.PreToolUse;
    expect(pre).toBeDefined();
    expect(pre?.[0].matcher).toBe('mcp__Roblox_Studio__execute_luau');
    expect(pre?.[0].hooks).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/buildOptions.test.ts`
Expected: FAIL — `o.hooks` is undefined; `mcpServers` lacks `Roblox_Studio`.

- [ ] **Step 3: Update `src/agent/buildOptions.ts`**

```ts
import type { BloxConfig } from '../config.js';
import type { StudioBridge, McpServerConfig } from '../bridge/types.js';
import type { ProjectDigest } from '../context/digest.js';
import type { HookCallbackMatcher, HookEvent } from '@anthropic-ai/claude-agent-sdk';
import { buildSystemPrompt } from './systemPrompt.js';
import { buildSyncHook, EXECUTE_LUAU_TOOL } from './hooks.js';

export interface QueryOptionsLike {
  model: string;
  cwd: string;
  systemPrompt: string;
  maxTurns: number;
  // Native SDK option: the query stops with an error_max_budget_usd result
  // once this USD cap is exceeded.
  maxBudgetUsd: number;
  permissionMode: 'bypassPermissions';
  // Required by the Agent SDK whenever permissionMode is 'bypassPermissions'.
  allowDangerouslySkipPermissions: true;
  settingSources: never[];
  thinking: { type: 'adaptive' };
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
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
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    thinking: { type: 'adaptive' },
    allowedTools: [...FILE_TOOLS, ...bridge.allowedTools()],
    mcpServers: bridge.mcpServers(),
    hooks: {
      PreToolUse: [
        { matcher: EXECUTE_LUAU_TOOL, hooks: [buildSyncHook(config.projectPath)] },
      ],
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/buildOptions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/buildOptions.ts tests/buildOptions.test.ts
git commit -m "feat: register rojo-sync hook in query options

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: `classifyStop` + `stopReason` in `runAgent`

**Files:**
- Modify: `src/agent/runAgent.ts`
- Test: `tests/runAgent.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/runAgent.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { classifyStop } from '../src/agent/runAgent.js';

describe('classifyStop', () => {
  it('maps SDK result subtypes to stop reasons', () => {
    expect(classifyStop('success')).toBe('completed');
    expect(classifyStop('error_max_turns')).toBe('maxTurns');
    expect(classifyStop('error_max_budget_usd')).toBe('budget');
    expect(classifyStop('error_during_execution')).toBe('error');
    expect(classifyStop('anything_else')).toBe('error');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/runAgent.test.ts`
Expected: FAIL — `classifyStop` is not exported.

- [ ] **Step 3: Update `src/agent/runAgent.ts`**

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryOptionsLike } from './buildOptions.js';

export type StopReason = 'completed' | 'maxTurns' | 'budget' | 'error';

// Map an SDK result-message subtype to a coarse stop reason for the report.
export function classifyStop(subtype: string): StopReason {
  switch (subtype) {
    case 'success':
      return 'completed';
    case 'error_max_turns':
      return 'maxTurns';
    case 'error_max_budget_usd':
      return 'budget';
    default:
      return 'error';
  }
}

export interface AgentRunResult {
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  stopReason: StopReason;
  detail: string;
}

export async function runAgent(
  prompt: string,
  options: QueryOptionsLike,
): Promise<AgentRunResult> {
  let result: AgentRunResult = {
    numTurns: 0,
    costUsd: 0,
    status: 'error',
    stopReason: 'error',
    detail: 'no result',
  };
  for await (const message of query({ prompt, options: options as never })) {
    if (message.type === 'result') {
      const subtype = message.subtype as string;
      result = {
        numTurns: message.num_turns,
        costUsd: message.total_cost_usd,
        status: subtype === 'success' ? 'success' : 'error',
        stopReason: classifyStop(subtype),
        detail: subtype,
      };
    }
  }
  return result;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/runAgent.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/runAgent.ts tests/runAgent.test.ts
git commit -m "feat: classify agent stop reason from result subtype

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Verify-loop + asset guidance in the system prompt

**Files:**
- Modify: `src/agent/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts`

- [ ] **Step 1: Update the failing test**

In `tests/systemPrompt.test.ts`, add assertions to the existing `it(...)` (after the current `expect` lines):

```ts
    expect(p).toContain('Verify loop');
    expect(p).toContain('execute_luau');
    expect(p).toContain('generate_mesh');
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: FAIL — prompt does not yet contain "Verify loop".

- [ ] **Step 3: Update `src/agent/systemPrompt.ts`**

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
    'Verify loop:',
    '- After editing, run your changes in Studio with the execute_luau tool: load',
    '  the affected modules, exercise them, assert expected results, and capture',
    '  any errors or output. Rojo syncs your files automatically before each run.',
    '- If a test fails, read the error, fix the .luau files, and call execute_luau',
    '  again. Repeat until tests pass.',
    '- The run is bounded by a turn count and a USD budget. If you are close to',
    '  the limit, make your most important fix and stop.',
    '- Never use multi_edit; edit .luau files on disk so Rojo stays the source of truth.',
    '',
    'Assets: when the task needs prototype assets, use generate_mesh,',
    'generate_material, generate_procedural_model, or insert_from_creator_store.',
    '',
    `Project: ${digest.name}`,
    `Top-level tree: ${digest.tree.join(', ') || '(none)'}`,
    `Scripts (${digest.scripts.length}):`,
    ...digest.scripts.map((s) => `  ${s}`),
  ].join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/agent/systemPrompt.ts tests/systemPrompt.test.ts
git commit -m "feat: add verify-loop and asset guidance to system prompt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: Surface `stopReason` in the run report

**Files:**
- Modify: `src/report.ts`
- Test: `tests/report.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/report.test.ts` inside `describe('formatReport', …)`:

```ts
  it('renders the stop reason when present', () => {
    const r: RunReport = {
      prompt: 'x',
      changedFiles: [],
      commitSha: null,
      numTurns: 2,
      costUsd: 0,
      status: 'error',
      stopReason: 'budget',
    };
    expect(formatReport(r)).toContain('stop: budget');
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/report.test.ts`
Expected: FAIL — `stopReason` is not a property of `RunReport` (type error) / not rendered.

- [ ] **Step 3: Update `src/report.ts`**

```ts
export interface RunReport {
  prompt: string;
  changedFiles: string[];
  commitSha: string | null;
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  stopReason?: string;
  detail?: string;
}

export function formatReport(r: RunReport): string {
  const lines = [
    `blox run — ${r.status}`,
    `prompt: ${r.prompt}`,
    `turns: ${r.numTurns}  cost: $${r.costUsd.toFixed(4)}`,
    ...(r.stopReason ? [`stop: ${r.stopReason}`] : []),
    `changed files (${r.changedFiles.length}):`,
    ...r.changedFiles.map((f) => `  ${f}`),
    r.commitSha ? `commit: ${r.commitSha}` : 'commit: (none)',
  ];
  if (r.detail) lines.push(`detail: ${r.detail}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/report.test.ts`
Expected: PASS (all formatReport tests).

- [ ] **Step 5: Commit**

```bash
git add src/report.ts tests/report.test.ts
git commit -m "feat: render stop reason in run report

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 8: Wire `stopReason` through the CLI

**Files:**
- Modify: `src/cli.ts`

- [ ] **Step 1: Add `stopReason` to the report object**

In `src/cli.ts`, update the `report` literal to include `stopReason`:

```ts
  const report: RunReport = {
    prompt,
    changedFiles: commit.files,
    commitSha: commit.sha,
    numTurns: agent.numTurns,
    costUsd: agent.costUsd,
    status: agent.status === 'success' && sync.ok ? 'success' : 'error',
    stopReason: agent.stopReason,
    detail: sync.ok ? agent.detail : sync.detail,
  };
```

- [ ] **Step 2: Type-check the whole project**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Step 3: Build and smoke-run against the fixture (mock bridge)**

Run:
```bash
npm run build
node dist/cli.js --mock --project test-fixtures/game "say hello" || true
```
Expected: `npm run build` succeeds and produces `dist/cli.js`; the run prints a `blox run — …` report that includes a `stop:` line. (A non-zero exit is fine here — there is no API key wired in this smoke; the point is the report renders and nothing throws at startup.)

- [ ] **Step 4: Commit**

```bash
git add src/cli.ts
git commit -m "feat: pass agent stop reason into the run report

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 9: Real-rojo integration test (install rojo in WSL)

**Files:**
- Create: `tests/rojo.integration.test.ts`

- [ ] **Step 1: Install rojo in WSL**

Run (primary):
```bash
command -v rojo || cargo install rojo
rojo --version
```
If `cargo` is unavailable, download the latest Linux release instead:
```bash
# Visit https://github.com/rojo-rbx/rojo/releases/latest and grab the
# linux x86_64 zip, then:
mkdir -p ~/.local/bin
# unzip the downloaded archive's `rojo` binary into ~/.local/bin, then:
chmod +x ~/.local/bin/rojo
export PATH="$HOME/.local/bin:$PATH"
rojo --version
```
Expected: `rojo --version` prints a version (e.g. `Rojo 7.x.x`).

- [ ] **Step 2: Write the integration test**

Create `tests/rojo.integration.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { syncProject } from '../src/sync/rojo.js';

function rojoAvailable(): boolean {
  try {
    execSync('rojo --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Self-skips when rojo is not installed, so CI without rojo stays green.
describe.skipIf(!rojoAvailable())('syncProject (real rojo)', () => {
  it('produces a sourcemap for the fixture game', async () => {
    const fixture = resolve(__dirname, '../test-fixtures/game');
    const res = await syncProject(fixture);
    expect(res.ok).toBe(true);
    expect(res.detail).toContain('ok');
  });

  it('fails cleanly on a directory with no Rojo project', async () => {
    const res = await syncProject(resolve(__dirname, '..'));
    expect(res.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run the integration test**

Run: `npx vitest run tests/rojo.integration.test.ts`
Expected: with rojo installed, both tests PASS (the first proves real `rojo sourcemap` works against the fixture; the second proves clean failure). Without rojo, the describe block is skipped.

- [ ] **Step 4: Commit**

```bash
git add tests/rojo.integration.test.ts
git commit -m "test: exercise real rojo sourcemap against the fixture

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] **Full test suite**

Run: `npm test`
Expected: all unit tests pass; the gated e2e (`tests/e2e/smoke.test.ts`) is skipped (no `BLOX_E2E=1`); the rojo integration test passes (rojo installed) or is skipped.

- [ ] **Type-check**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors.

- [ ] **Build**

Run: `npm run build`
Expected: `dist/cli.js` is produced.

- [ ] **Confirm the done bar (spec §7):** mock unit tests green + real-rojo integration green + gated live e2e skipped + `tsc` clean + build OK.

---

## Spec Coverage Map

- §3 bridge migration (server name, launch command, tool surface) → Task 1, Task 2.
- §5 / §6.2 sync gate (PreToolUse hook) → Task 3, wired in Task 4.
- §5 / §6.4 native bounding + `stopReason` → Task 5 (`classifyStop`), Task 7/8 (report).
- §6.3 buildOptions keeps `maxBudgetUsd`, adds hooks → Task 4.
- §6.5 system prompt verify-loop + assets → Task 6.
- §6.6 mock bridge + `sequenceResponder` → Task 2.
- §6.7 / §7 real-rojo integration (rojo in WSL) → Task 9.
- §7 done bar (mock + real rojo, tsc, build, gated e2e skipped) → Final Verification.
- §8 deferred items (tier-2, input, session, live e2e) → intentionally absent from this plan.
