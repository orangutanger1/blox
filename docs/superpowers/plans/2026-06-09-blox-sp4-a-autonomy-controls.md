# blox SP4-a — Per-Run Autonomy Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-run CLI overrides for turn cap, budget cap, model effort, and a new `--auto`/`--ask` autonomy mode that gates asset-generation and play/input tools via a `canUseTool` deny-with-feedback callback.

**Architecture:** Gating policy lives in a new autonomy module (`src/agent/permission.ts`), not on the bridge. `--auto` keeps today's `bypassPermissions`; `--ask` switches to `permissionMode: 'default'` + a `canUseTool` callback, and removes gated tools from `allowedTools` (which auto-approves) so they route to the callback while staying advertised by the MCP server. Gated denials surface in the result's `permission_denials[]`, which `runAgent` turns into a `'gated'` stop reason and a blocked-action list for the report. `session_id` is captured for a future slice-C `resume`.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` v0.3.168, Zod, Vitest.

---

## Spec → plan reference

Implements `docs/superpowers/specs/2026-06-09-blox-sp4-a-autonomy-controls-design.md`.

**Verified SDK facts (v0.3.168), so no guessing during implementation:**
- `Options.effort?: EffortLevel` where `EffortLevel = 'low'|'medium'|'high'|'xhigh'|'max'` (sdk.d.ts:535). Coexists with `thinking: { type: 'adaptive' }`.
- `CanUseTool = (toolName, input, opts) => Promise<PermissionResult>` (sdk.d.ts:188). `PermissionResult` deny = `{ behavior: 'deny'; message: string; interrupt?: boolean }`; allow = `{ behavior: 'allow'; updatedInput?: ... }` (sdk.d.ts:2033).
- `allowedTools` = "auto-allowed without prompting" (sdk.d.ts:1330 doc) → a gated tool listed there **bypasses** `canUseTool`. Hence `--ask` must exclude gated tools from `allowedTools`. They remain advertised by the connected MCP server, so the model can still call them and the call routes to `canUseTool`.
- `PermissionMode` includes `'default'` and `'bypassPermissions'` (sdk.d.ts:2011).
- SDK result message carries `permission_denials: { tool_name; tool_use_id; tool_input }[]` and `session_id: string` on **both** success and error subtypes (sdk.d.ts:3439, 3549/3555, 3578/3585). A deny **without** `interrupt` feeds an `is_error` tool_result back to the model and the run completes as `subtype: 'success'` — so `'gated'` is derived blox-side from `permission_denials.length > 0`, not from an SDK subtype.

**Refinement vs spec §3.1/§4:** the spec proposed a `gatedTools()` method on the bridge. This plan instead keeps the gated set in `src/agent/permission.ts` (policy belongs in the autonomy layer; the bridge is transport) and guards drift with a unit test asserting the gated names are a subset of the bridge's advertised tools. Same enforcement, cleaner separation, fewer touchpoints.

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/agent/permission.ts` | Gated-set policy + `canUseTool` builder + allow-list filter | Create |
| `src/config.ts` | Schema: add `mode` + `effort`; `overridesFromArgs` helper | Modify |
| `src/args.ts` | Parse + validate `--max-turns`/`--budget`/`--effort`/`--auto`/`--ask` | Modify |
| `src/agent/buildOptions.ts` | Branch on mode; wire effort; filter allow-list in `--ask` | Modify |
| `src/agent/runAgent.ts` | `summarizeResult`: sessionId + gatedActions + `'gated'` stop | Modify |
| `src/report.ts` | Render mode/effort + blocked actions + session + hint | Modify |
| `src/cli.ts` | Thread flags → config → report | Modify |
| `tests/permission.test.ts` | Unit: gated predicate, callback, allow-list filter, drift | Create |
| `tests/config.test.ts` | Unit: mode/effort defaults + `overridesFromArgs` | Modify |
| `tests/args.test.ts` | Unit: flag parsing + validation | Modify |
| `tests/buildOptions.test.ts` | Unit: auto vs ask branch; effort | Modify |
| `tests/runAgent.test.ts` | Unit: `summarizeResult` | Modify |
| `tests/report.test.ts` | Unit: gated render | Modify |
| `tests/e2e/ask-gate.test.ts` | Optional live (`BLOX_E2E=1`) gated-stop smoke | Create |

Run all unit tests with `npx vitest run` (expected output noted per task).

---

### Task 1: Gated-set policy + permission module

**Files:**
- Create: `src/agent/permission.ts`
- Test: `tests/permission.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/permission.test.ts
import { describe, it, expect } from 'vitest';
import {
  GATED_TOOLS,
  isGated,
  nonGatedAllowedTools,
  denyMessage,
  buildCanUseTool,
} from '../src/agent/permission.js';
import { createMockStudioBridge } from '../src/bridge/mockBridge.js';

describe('isGated', () => {
  it('matches gated tools by bare and MCP-qualified name', () => {
    expect(isGated('generate_mesh')).toBe(true);
    expect(isGated('mcp__Roblox_Studio__generate_mesh')).toBe(true);
    expect(isGated('mcp__Roblox_Studio__insert_from_creator_store')).toBe(true);
    expect(isGated('mcp__Roblox_Studio__start_stop_play')).toBe(true);
    expect(isGated('mcp__Roblox_Studio__user_mouse_input')).toBe(true);
  });

  it('does not gate the inner loop or read-only tools', () => {
    expect(isGated('mcp__Roblox_Studio__execute_luau')).toBe(false);
    expect(isGated('mcp__Roblox_Studio__search_creator_store')).toBe(false);
    expect(isGated('mcp__Roblox_Studio__wait_job_finished')).toBe(false);
    expect(isGated('mcp__Roblox_Studio__get_console_output')).toBe(false);
    expect(isGated('Read')).toBe(false);
    expect(isGated('Write')).toBe(false);
    expect(isGated('Edit')).toBe(false);
  });
});

describe('nonGatedAllowedTools', () => {
  it('strips gated tools but keeps file + non-gated bridge tools', () => {
    const all = ['Read', 'Write', 'mcp__Roblox_Studio__execute_luau', 'mcp__Roblox_Studio__generate_mesh'];
    expect(nonGatedAllowedTools(all)).toEqual(['Read', 'Write', 'mcp__Roblox_Studio__execute_luau']);
  });
});

describe('buildCanUseTool', () => {
  it('denies gated tools with a feedback message', async () => {
    const cb = buildCanUseTool();
    const r = await cb('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.message).toBe(denyMessage('mcp__Roblox_Studio__generate_mesh'));
  });

  it('allows non-gated tools', async () => {
    const cb = buildCanUseTool();
    const r = await cb('mcp__Roblox_Studio__execute_luau', {}, {} as never);
    expect(r.behavior).toBe('allow');
  });
});

describe('drift guard', () => {
  it('every gated name is advertised by the bridge', () => {
    const advertised = createMockStudioBridge().allowedTools();
    for (const g of GATED_TOOLS) {
      expect(advertised).toContain(`mcp__Roblox_Studio__${g}`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/permission.test.ts`
Expected: FAIL — cannot resolve `../src/agent/permission.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/agent/permission.ts
import type { CanUseTool } from '@anthropic-ai/claude-agent-sdk';

// Unqualified names of the tools gated in --ask mode (master design §6 stop-to-ask):
// asset generation (spends Roblox credits, irreversible) + play-mode/input-sim
// (side-effectful, slow). Policy lives here, not on the bridge — the bridge is
// transport; gating is an autonomy concern.
export const GATED_TOOLS = [
  'generate_mesh',
  'generate_material',
  'generate_procedural_model',
  'insert_from_creator_store',
  'start_stop_play',
  'character_navigation',
  'user_keyboard_input',
  'user_mouse_input',
] as const;

// True when `toolName` is gated, accepting the bare name ('generate_mesh') or the
// MCP-qualified form ('mcp__Roblox_Studio__generate_mesh'). Tool names contain only
// single underscores, so the '__' separator before the bare name is unambiguous.
export function isGated(toolName: string): boolean {
  return GATED_TOOLS.some((g) => toolName === g || toolName.endsWith(`__${g}`));
}

// Drop gated tools from an allow-list. allowedTools auto-approves (bypassing
// canUseTool), so gated tools must be excluded to route through the callback;
// they stay advertised by the MCP server and remain callable by the model.
export function nonGatedAllowedTools(tools: string[]): string[] {
  return tools.filter((t) => !isGated(t));
}

export function denyMessage(toolName: string): string {
  return `Action "${toolName}" requires approval and is blocked in --ask mode. Do not retry it. Briefly explain what you intended to do with it and why, then stop.`;
}

// Permission callback for --ask: allow everything except gated tools, which are
// denied with feedback so the agent self-explains and stops. Denials surface in
// the result's permission_denials[] for the report.
export function buildCanUseTool(): CanUseTool {
  return async (toolName) => {
    if (isGated(toolName)) {
      return { behavior: 'deny', message: denyMessage(toolName) };
    }
    return { behavior: 'allow' };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/permission.test.ts`
Expected: PASS (4 describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/agent/permission.ts tests/permission.test.ts
git commit -m "feat(sp4-a): gated-set policy + canUseTool deny-with-feedback builder"
```

---

### Task 2: Config schema — `mode` + `effort` + `overridesFromArgs`

**Files:**
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `tests/buildOptions.test.ts` (existing `BloxConfig` literal needs `mode`)

- [ ] **Step 1: Write the failing test** — append to `tests/config.test.ts`

```ts
import { overridesFromArgs } from '../src/config.js';

describe('mode + effort schema', () => {
  it('defaults mode to auto and leaves effort unset', () => {
    const c = loadConfig('/game', {});
    expect(c.mode).toBe('auto');
    expect(c.effort).toBeUndefined();
  });

  it('accepts ask mode and an effort level', () => {
    const c = loadConfig('/game', { mode: 'ask', effort: 'xhigh' });
    expect(c.mode).toBe('ask');
    expect(c.effort).toBe('xhigh');
  });

  it('rejects an invalid mode', () => {
    expect(() => loadConfig('/game', { mode: 'yolo' as never })).toThrow();
  });
});

describe('overridesFromArgs', () => {
  it('includes only the flags that were set', () => {
    expect(overridesFromArgs({ projectPath: null, maxTurns: null, maxBudgetUsd: null, effort: null, mode: null })).toEqual({});
    expect(
      overridesFromArgs({ projectPath: '/g', maxTurns: 10, maxBudgetUsd: 2.5, effort: 'high', mode: 'ask' }),
    ).toEqual({ projectPath: '/g', maxTurns: 10, maxBudgetUsd: 2.5, effort: 'high', mode: 'ask' });
  });
});
```

> Note: `tests/config.test.ts` already imports `loadConfig`; add `overridesFromArgs` to that import or use the separate import shown above.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `overridesFromArgs` is not exported; `c.mode` is undefined.

- [ ] **Step 3: Write minimal implementation** — edit `src/config.ts`

Extend the schema:

```ts
export const BloxConfigSchema = z.object({
  projectPath: z.string(),
  model: z.string().default('claude-opus-4-8'),
  maxTurns: z.number().int().positive().default(40),
  maxBudgetUsd: z.number().positive().default(5),
  mode: z.enum(['auto', 'ask']).default('auto'),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
});
```

Add the helper at the end of the file:

```ts
// Map parsed CLI flags to config overrides, including only flags that were set so
// that unset flags fall through to blox.config.json / schema defaults.
export function overridesFromArgs(a: {
  projectPath: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  effort: 'high' | 'xhigh' | null;
  mode: 'auto' | 'ask' | null;
}): Partial<BloxConfig> {
  const o: Partial<BloxConfig> = {};
  if (a.projectPath) o.projectPath = a.projectPath;
  if (a.maxTurns != null) o.maxTurns = a.maxTurns;
  if (a.maxBudgetUsd != null) o.maxBudgetUsd = a.maxBudgetUsd;
  if (a.effort != null) o.effort = a.effort;
  if (a.mode != null) o.mode = a.mode;
  return o;
}
```

- [ ] **Step 4: Fix the existing `BloxConfig` literal** — edit `tests/buildOptions.test.ts`

The `BloxConfig` output type now requires `mode`. Update the shared literal:

```ts
const config: BloxConfig = {
  projectPath: '/game',
  model: 'claude-opus-4-8',
  maxTurns: 40,
  maxBudgetUsd: 5,
  mode: 'auto',
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts tests/buildOptions.test.ts`
Expected: PASS. (buildOptions still green because `auto` is the default path — Task 4 adds the `ask` assertions.)

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts tests/buildOptions.test.ts
git commit -m "feat(sp4-a): config mode/effort fields + overridesFromArgs helper"
```

---

### Task 3: Arg parsing — `--max-turns` / `--budget` / `--effort` / `--auto` / `--ask`

**Files:**
- Modify: `src/args.ts`
- Modify: `tests/args.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/args.test.ts`

```ts
describe('autonomy flags', () => {
  it('parses numeric + effort + mode flags', () => {
    const a = parseArgs(['--max-turns', '12', '--budget', '2.5', '--effort', 'xhigh', '--ask', 'do', 'x']);
    expect(a.maxTurns).toBe(12);
    expect(a.maxBudgetUsd).toBe(2.5);
    expect(a.effort).toBe('xhigh');
    expect(a.mode).toBe('ask');
    expect(a.prompt).toBe('do x');
  });

  it('defaults the new flags to null', () => {
    const a = parseArgs(['hi']);
    expect(a.maxTurns).toBeNull();
    expect(a.maxBudgetUsd).toBeNull();
    expect(a.effort).toBeNull();
    expect(a.mode).toBeNull();
  });

  it('parses --auto', () => {
    expect(parseArgs(['--auto', 'hi']).mode).toBe('auto');
  });

  it('rejects invalid values', () => {
    expect(() => parseArgs(['--max-turns', '0'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--max-turns', 'abc'])).toThrow(/positive integer/);
    expect(() => parseArgs(['--budget', '-1'])).toThrow(/positive number/);
    expect(() => parseArgs(['--effort', 'medium'])).toThrow(/high or xhigh/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/args.test.ts`
Expected: FAIL — `a.maxTurns` etc. are `undefined`; parser does not throw.

- [ ] **Step 3: Write minimal implementation** — replace the body of `src/args.ts`

```ts
export interface ParsedArgs {
  command: 'doctor' | 'serve' | null;
  prompt: string | null;
  mock: boolean;
  projectPath: string | null;
  maxTurns: number | null;
  maxBudgetUsd: number | null;
  effort: 'high' | 'xhigh' | null;
  mode: 'auto' | 'ask' | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let mock = false;
  let projectPath: string | null = null;
  let command: 'doctor' | 'serve' | null = null;
  let maxTurns: number | null = null;
  let maxBudgetUsd: number | null = null;
  let effort: 'high' | 'xhigh' | null = null;
  let mode: 'auto' | 'ask' | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') mock = true;
    else if (a === '--project') projectPath = argv[++i] ?? null;
    else if (a === '--max-turns') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error('--max-turns must be a positive integer');
      maxTurns = n;
    } else if (a === '--budget') {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) throw new Error('--budget must be a positive number');
      maxBudgetUsd = n;
    } else if (a === '--effort') {
      const v = argv[++i];
      if (v !== 'high' && v !== 'xhigh') throw new Error('--effort must be high or xhigh');
      effort = v;
    } else if (a === '--auto') mode = 'auto';
    else if (a === '--ask') mode = 'ask';
    else if (a === 'doctor' && command === null && positional.length === 0) command = 'doctor';
    else if (a === 'serve' && command === null && positional.length === 0) command = 'serve';
    else positional.push(a);
  }
  return {
    command,
    prompt: positional.join(' ').trim() || null,
    mock,
    projectPath,
    maxTurns,
    maxBudgetUsd,
    effort,
    mode,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/args.test.ts`
Expected: PASS (existing positional/`--mock`/`--project`/doctor tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/args.ts tests/args.test.ts
git commit -m "feat(sp4-a): parse + validate per-run autonomy flags"
```

---

### Task 4: buildOptions — auto/ask branch + effort wiring

**Files:**
- Modify: `src/agent/buildOptions.ts`
- Modify: `tests/buildOptions.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/buildOptions.test.ts`

```ts
const askConfig: BloxConfig = { ...config, mode: 'ask', effort: 'xhigh' };

describe('buildQueryOptions — ask mode', () => {
  it('uses default permission mode + a canUseTool callback', () => {
    const o = buildQueryOptions(askConfig, createMockStudioBridge(), digest);
    expect(o.permissionMode).toBe('default');
    expect(o.allowDangerouslySkipPermissions).toBeUndefined();
    expect(typeof o.canUseTool).toBe('function');
  });

  it('drops gated tools from the allow-list but keeps the inner loop', () => {
    const o = buildQueryOptions(askConfig, createMockStudioBridge(), digest);
    expect(o.allowedTools).not.toContain('mcp__Roblox_Studio__generate_mesh');
    expect(o.allowedTools).not.toContain('mcp__Roblox_Studio__start_stop_play');
    expect(o.allowedTools).toContain('mcp__Roblox_Studio__execute_luau');
    expect(o.allowedTools).toEqual(expect.arrayContaining(['Read', 'Write', 'Edit']));
  });

  it('passes effort when set and omits it when unset', () => {
    expect(buildQueryOptions(askConfig, createMockStudioBridge(), digest).effort).toBe('xhigh');
    expect(buildQueryOptions(config, createMockStudioBridge(), digest).effort).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/buildOptions.test.ts`
Expected: FAIL — `permissionMode` is always `'bypassPermissions'`; `canUseTool`/`effort` absent; gated tools still present.

- [ ] **Step 3: Write minimal implementation** — edit `src/agent/buildOptions.ts`

Add imports near the top:

```ts
import type { CanUseTool, EffortLevel } from '@anthropic-ai/claude-agent-sdk';
import { buildCanUseTool, nonGatedAllowedTools } from './permission.js';
```

Replace the `QueryOptionsLike` interface fields for permission/effort:

```ts
export interface QueryOptionsLike {
  model: string;
  cwd: string;
  systemPrompt: string;
  maxTurns: number;
  // Native SDK option: the query stops with an error_max_budget_usd result
  // once this USD cap is exceeded.
  maxBudgetUsd: number;
  permissionMode: 'bypassPermissions' | 'default';
  // Present only in --auto; required by the SDK whenever permissionMode is
  // 'bypassPermissions'.
  allowDangerouslySkipPermissions?: true;
  // Present only in --ask; consulted because gated tools are kept out of allowedTools.
  canUseTool?: CanUseTool;
  // Reasoning effort; omitted when unset so the SDK default ('high') applies.
  effort?: EffortLevel;
  settingSources: never[];
  thinking: { type: 'adaptive' };
  allowedTools: string[];
  mcpServers: Record<string, McpServerConfig>;
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
}
```

Replace the `buildQueryOptions` return:

```ts
export function buildQueryOptions(
  config: BloxConfig,
  bridge: StudioBridge,
  digest: ProjectDigest,
): QueryOptionsLike {
  const allTools = [...FILE_TOOLS, ...bridge.allowedTools()];
  const ask = config.mode === 'ask';
  return {
    model: config.model,
    cwd: config.projectPath,
    systemPrompt: buildSystemPrompt(digest),
    maxTurns: config.maxTurns,
    maxBudgetUsd: config.maxBudgetUsd,
    permissionMode: ask ? 'default' : 'bypassPermissions',
    ...(ask
      ? { canUseTool: buildCanUseTool() }
      : { allowDangerouslySkipPermissions: true as const }),
    ...(config.effort ? { effort: config.effort } : {}),
    settingSources: [],
    thinking: { type: 'adaptive' },
    allowedTools: ask ? nonGatedAllowedTools(allTools) : allTools,
    mcpServers: bridge.mcpServers(),
    hooks: {
      PreToolUse: [
        { matcher: EXECUTE_LUAU_TOOL, hooks: [buildSyncHook(config.projectPath)] },
      ],
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/buildOptions.test.ts`
Expected: PASS — both the original auto-mode assertions and the new ask-mode assertions.

- [ ] **Step 5: Commit**

```bash
git add src/agent/buildOptions.ts tests/buildOptions.test.ts
git commit -m "feat(sp4-a): buildOptions auto/ask branch + effort wiring"
```

---

### Task 5: runAgent — `summarizeResult` (sessionId + gatedActions + `'gated'` stop)

**Files:**
- Modify: `src/agent/runAgent.ts`
- Modify: `tests/runAgent.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/runAgent.test.ts`

```ts
import { summarizeResult } from '../src/agent/runAgent.js';

const base = {
  subtype: 'success',
  num_turns: 3,
  total_cost_usd: 0.5,
  session_id: 'sess-123',
  permission_denials: [],
};

describe('summarizeResult', () => {
  it('passes through a clean success with the session id', () => {
    const r = summarizeResult(base);
    expect(r.status).toBe('success');
    expect(r.stopReason).toBe('completed');
    expect(r.sessionId).toBe('sess-123');
    expect(r.gatedActions).toEqual([]);
  });

  it('derives a gated stop from permission_denials and forces error status', () => {
    const r = summarizeResult({
      ...base,
      permission_denials: [
        { tool_name: 'mcp__Roblox_Studio__generate_mesh', tool_use_id: 't1', tool_input: { prompt: 'rock' } },
      ],
    });
    expect(r.stopReason).toBe('gated');
    expect(r.status).toBe('error');
    expect(r.gatedActions).toEqual([{ tool: 'mcp__Roblox_Studio__generate_mesh', input: { prompt: 'rock' } }]);
  });

  it('maps budget/turn subtypes when there are no denials', () => {
    expect(summarizeResult({ ...base, subtype: 'error_max_budget_usd' }).stopReason).toBe('budget');
    expect(summarizeResult({ ...base, subtype: 'error_max_turns' }).stopReason).toBe('maxTurns');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runAgent.test.ts`
Expected: FAIL — `summarizeResult` is not exported.

- [ ] **Step 3: Write minimal implementation** — edit `src/agent/runAgent.ts`

Update the `StopReason` union, add types + `summarizeResult`, and route `runAgent` through it:

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryOptionsLike } from './buildOptions.js';

export type StopReason = 'completed' | 'maxTurns' | 'budget' | 'gated' | 'error';

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

export interface GatedAction {
  tool: string;
  input: Record<string, unknown>;
}

export interface AgentRunResult {
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  stopReason: StopReason;
  detail: string;
  sessionId: string | null;
  gatedActions: GatedAction[];
}

interface ResultMessageLike {
  subtype: string;
  num_turns: number;
  total_cost_usd: number;
  session_id: string;
  permission_denials?: { tool_name: string; tool_input: Record<string, unknown> }[];
}

// Build the run result from an SDK 'result' message. Gated denials (collected in
// permission_denials[] by the canUseTool deny path) override the stop reason and
// force a non-zero status: the task did not complete without approval.
export function summarizeResult(message: ResultMessageLike): AgentRunResult {
  const gatedActions = (message.permission_denials ?? []).map((d) => ({
    tool: d.tool_name,
    input: d.tool_input,
  }));
  const gated = gatedActions.length > 0;
  const baseStatus: 'success' | 'error' = message.subtype === 'success' ? 'success' : 'error';
  return {
    numTurns: message.num_turns,
    costUsd: message.total_cost_usd,
    status: gated ? 'error' : baseStatus,
    stopReason: gated ? 'gated' : classifyStop(message.subtype),
    detail: gated ? 'gated' : message.subtype,
    sessionId: message.session_id,
    gatedActions,
  };
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
    sessionId: null,
    gatedActions: [],
  };
  for await (const message of query({ prompt, options: options as never })) {
    if (message.type === 'result') {
      result = summarizeResult(message as unknown as ResultMessageLike);
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/runAgent.test.ts`
Expected: PASS (original `classifyStop` test + new `summarizeResult` tests).

- [ ] **Step 5: Commit**

```bash
git add src/agent/runAgent.ts tests/runAgent.test.ts
git commit -m "feat(sp4-a): summarizeResult derives gated stop + captures session id"
```

---

### Task 6: report — render mode/effort + blocked actions + session + hint

**Files:**
- Modify: `src/report.ts`
- Modify: `tests/report.test.ts`

- [ ] **Step 1: Write the failing test** — append to `tests/report.test.ts`

```ts
describe('formatReport — autonomy', () => {
  it('renders mode + effort lines when present', () => {
    const out = formatReport({
      prompt: 'p',
      changedFiles: [],
      commitSha: null,
      numTurns: 1,
      costUsd: 0,
      status: 'success',
      mode: 'ask',
      effort: 'xhigh',
    });
    expect(out).toContain('mode: ask');
    expect(out).toContain('effort: xhigh');
  });

  it('lists blocked actions, the session id, and the re-run hint on a gated stop', () => {
    const out = formatReport({
      prompt: 'make a rock',
      changedFiles: [],
      commitSha: null,
      numTurns: 2,
      costUsd: 0.1,
      status: 'error',
      stopReason: 'gated',
      mode: 'ask',
      sessionId: 'sess-9',
      gatedActions: [{ tool: 'mcp__Roblox_Studio__generate_mesh', input: { prompt: 'rock' } }],
    });
    expect(out).toContain('blocked (needs approval):');
    expect(out).toContain('mcp__Roblox_Studio__generate_mesh');
    expect(out).toContain('session: sess-9');
    expect(out).toContain('--auto');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/report.test.ts`
Expected: FAIL — `RunReport` has no `mode`/`gatedActions`; output lacks the new lines.

- [ ] **Step 3: Write minimal implementation** — replace `src/report.ts`

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
  mode?: 'auto' | 'ask';
  effort?: string;
  sessionId?: string | null;
  gatedActions?: { tool: string; input: Record<string, unknown> }[];
}

export function formatReport(r: RunReport): string {
  const lines = [
    `blox run — ${r.status}`,
    `prompt: ${r.prompt}`,
    ...(r.mode ? [`mode: ${r.mode}${r.effort ? `  effort: ${r.effort}` : ''}`] : []),
    `turns: ${r.numTurns}  cost: $${r.costUsd.toFixed(4)}`,
    ...(r.stopReason ? [`stop: ${r.stopReason}`] : []),
    ...(r.gatedActions && r.gatedActions.length
      ? [
          `blocked (needs approval):`,
          ...r.gatedActions.map((g) => `  ${g.tool}`),
          ...(r.sessionId ? [`session: ${r.sessionId}`] : []),
          `→ re-run with --auto to allow these actions`,
        ]
      : []),
    `changed files (${r.changedFiles.length}):`,
    ...r.changedFiles.map((f) => `  ${f}`),
    r.commitSha ? `commit: ${r.commitSha}` : 'commit: (none)',
  ];
  if (r.detail) lines.push(`detail: ${r.detail}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/report.test.ts`
Expected: PASS (original success/no-commit tests + the two new ones).

- [ ] **Step 5: Commit**

```bash
git add src/report.ts tests/report.test.ts
git commit -m "feat(sp4-a): report renders mode/effort + gated blocked actions"
```

---

### Task 7: cli wiring — thread flags → config → report

**Files:**
- Modify: `src/cli.ts`

(No unit test: `cli.ts` is the entry-point glue, untested in this repo by convention. The pure pieces it composes — `overridesFromArgs`, `summarizeResult`, `formatReport` — are covered by Tasks 2/5/6. Task 8 is the optional live check.)

- [ ] **Step 1: Capture the full args + use overrides**

In `src/cli.ts`, add `overridesFromArgs` to the config import:

```ts
import { loadConfig, overridesFromArgs } from './config.js';
```

Replace the destructure + config load at the top of `main` and in the run path. Change:

```ts
  const { command, prompt, mock, projectPath } = parseArgs(process.argv.slice(2));
```

to:

```ts
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    process.exit(2);
  }
  const { command, prompt, mock, projectPath } = args;
```

- [ ] **Step 2: Use overrides in the run path**

Replace:

```ts
  const cwd = projectPath ?? process.cwd();
  const config = loadConfig(cwd, projectPath ? { projectPath } : {});
```

with:

```ts
  const cwd = projectPath ?? process.cwd();
  const config = loadConfig(cwd, overridesFromArgs(args));
```

- [ ] **Step 3: Thread autonomy fields into the report**

Replace the `report` object literal:

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
      mode: config.mode,
      effort: config.effort,
      sessionId: agent.sessionId,
      gatedActions: agent.gatedActions,
    };
```

- [ ] **Step 4: Build + full unit suite + typecheck**

Run: `npm run build && npx vitest run`
Expected: build succeeds; all unit tests PASS (no `tests/e2e/*` run without env flags).

- [ ] **Step 5: Manual smoke (mock bridge, real API key)**

Run: `node dist/cli.js --mock --project test-fixtures/game --ask "Generate a mesh of a rock and insert it into Workspace"`
Expected: run ends with `stop: gated`, a `blocked (needs approval):` block naming a `generate_*` tool, a `session:` line, and the `--auto` hint. Exit code 1.

Run: `node dist/cli.js --mock --project test-fixtures/game --max-turns 3 "Add a comment to Greeter.luau"`
Expected: `mode: auto` line, normal success report, unchanged behavior.

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat(sp4-a): wire per-run autonomy flags through cli to report"
```

---

### Task 8 (optional): live gated-stop e2e

Run only when a live API key is available; gated behind `BLOX_E2E=1` like `tests/e2e/smoke.test.ts`. Uses the mock bridge (fake tools) with the real model: the model calls `generate_mesh`, `canUseTool` denies it before execution, and the run stops gated.

**Files:**
- Create: `tests/e2e/ask-gate.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from 'vitest';
import { buildQueryOptions } from '../../src/agent/buildOptions.js';
import { runAgent } from '../../src/agent/runAgent.js';
import { createMockStudioBridge } from '../../src/bridge/mockBridge.js';
import { loadConfig } from '../../src/config.js';
import type { ProjectDigest } from '../../src/context/digest.js';

const RUN = process.env.BLOX_E2E === '1';

describe.runIf(RUN)('--ask gates asset generation (live)', () => {
  it('stops gated when the agent reaches generate_mesh', async () => {
    const config = loadConfig(process.cwd(), { mode: 'ask', maxTurns: 8, maxBudgetUsd: 1 });
    const digest: ProjectDigest = { name: 'g', tree: [], scripts: [], groups: [] };
    const options = buildQueryOptions(config, createMockStudioBridge(), digest);
    const r = await runAgent(
      'Generate a mesh of a small rock and insert it into Workspace. Use the generate_mesh tool.',
      options,
    );
    expect(r.stopReason).toBe('gated');
    expect(r.gatedActions.some((g) => g.tool.includes('generate'))).toBe(true);
    expect(typeof r.sessionId).toBe('string');
  }, 120_000);
});
```

- [ ] **Step 2: Run it (only with a key)**

Run: `BLOX_E2E=1 npx vitest run tests/e2e/ask-gate.test.ts`
Expected: PASS (skipped when `BLOX_E2E` unset).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/ask-gate.test.ts
git commit -m "test(sp4-a): gated live e2e for --ask asset gating (BLOX_E2E)"
```

---

## Final verification

- [ ] `npm run build` — clean compile (types updated in args/config/buildOptions/runAgent/report).
- [ ] `npx vitest run` — full unit suite green.
- [ ] Update `README.md` "Run" + a short "Autonomy" subsection documenting `--max-turns`, `--budget`, `--effort high|xhigh`, `--auto` (default) / `--ask`, the gated set, and the gated-stop behavior. Commit `docs: document per-run autonomy flags`.

## Self-review notes (author)

- **Spec coverage:** turn cap (Task 3/4), budget cap (Task 3/4), effort (Task 2/3/4), mode + gating (Tasks 1/4), stop+report via deny-with-feedback (Tasks 1/5/6), session-id capture (Task 5/6), default `auto` (Task 2), gated set = asset-gen + play/input only, inner loop ungated (Task 1 tests). All present.
- **Type consistency:** `GatedAction { tool; input }` used identically in `runAgent.ts` and `report.ts`; `mode: 'auto'|'ask'`, `effort: EffortLevel`/`'high'|'xhigh'` consistent across args/config/buildOptions; `permission_denials` field shape matches the verified SDK type.
- **Non-goals honored:** no readline/TTY, no `resume` implementation (only `session_id` capture), no per-tool allowlists.
