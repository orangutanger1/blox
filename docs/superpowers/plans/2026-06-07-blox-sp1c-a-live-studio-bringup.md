# blox SP1c-a Live Studio Bring-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a `blox doctor` preflight that diagnoses the live WSL→Windows Studio MCP hop (proxy layer + Studio-attached layer), harden the bridge launch, and un-gate a real live e2e — grounded in the SP1c-a spike findings.

**Architecture:** One new pure unit (`src/doctor.ts`) does a layered MCP check via an injected client factory (default wraps `@modelcontextprotocol/sdk` `Client`+`StdioClientTransport`); a `doctor` CLI subcommand formats its report. The bridge gains an exported `studioLauncher()` (shared by CLI run + doctor) and a Windows-side `cwd` to suppress the UNC warning. All logic is unit-tested against a fake client; only the final gated e2e needs a live Studio.

**Tech Stack:** TypeScript v6 (ESM, native compiler), vitest, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk` (promoted to a direct dep).

**Spec:** `docs/superpowers/specs/2026-06-07-blox-sp1c-a-live-studio-bringup-design.md`

---

## File Structure

- `src/bridge/mcpBridge.ts` — **modify**: export `studioLauncher(): StudioLaunch`; add Windows `cwd`; `createStudioMcpBridge` reuses it.
- `src/bridge/types.ts` — **modify**: add `cwd?: string` to the stdio `McpServerConfig` member; add/export `StudioLaunch`.
- `src/doctor.ts` — **create**: `DoctorReport`, `DoctorClient`, `McpClientFactory`, `defaultClientFactory`, `runDoctor`, `formatDoctorReport`.
- `src/args.ts` — **modify**: parse a leading `doctor` subcommand into `command`.
- `src/cli.ts` — **modify**: route `doctor` to `runDoctor` before the prompt path.
- `tests/doctor.test.ts` — **create**: unit tests for `runDoctor`/`formatDoctorReport` against a fake client.
- `tests/args.test.ts` — **modify**: assert `doctor` parses to `command: 'doctor'`.
- `tests/bridge.test.ts` — **modify**: assert `studioLauncher()` shape + `cwd` default.
- `tests/e2e/live-studio.test.ts` — **create**: gated (`BLOX_LIVE_STUDIO=1`) real-bridge e2e.
- `docs/reference/roblox-studio-mcp.md` — **modify**: correct tool table + envelope + two-layer note.
- `scripts/spike-handshake.mjs` — **delete** at the end.
- `package.json` — **modify**: add `@modelcontextprotocol/sdk` to `dependencies`.

---

## Task 1: Promote the MCP SDK to a direct dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the dependency at the resolved version**

Run: `npm pkg set dependencies.@modelcontextprotocol/sdk="^1.29.0"`

- [ ] **Step 2: Verify it resolves without a reinstall surprise**

Run: `npm ls @modelcontextprotocol/sdk`
Expected: shows `@modelcontextprotocol/sdk@1.29.0` (now also a direct dep), no `UNMET`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: make @modelcontextprotocol/sdk a direct dependency"
```

---

## Task 2: Export a shared launcher from the bridge

**Files:**
- Modify: `src/bridge/types.ts`
- Modify: `src/bridge/mcpBridge.ts`
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/bridge.test.ts`)

```typescript
import { createStudioMcpBridge, studioLauncher } from '../src/bridge/mcpBridge.js';

describe('studioLauncher', () => {
  it('returns the same command/args the bridge server config uses', () => {
    const l = studioLauncher();
    const cfg = createStudioMcpBridge().mcpServers().Roblox_Studio as {
      command: string; args?: string[];
    };
    expect(l.command).toBe(cfg.command);
    expect(l.args).toEqual(cfg.args ?? []);
  });

  it('defaults to a Windows-side cwd on the cmd.exe path (no override)', () => {
    const prev = process.env.BLOX_STUDIO_MCP_CMD;
    delete process.env.BLOX_STUDIO_MCP_CMD;
    try {
      const l = studioLauncher();
      // linux/WSL + win32 reach mcp.bat via cmd.exe and get a Windows cwd.
      if (process.platform !== 'darwin') {
        expect(l.command).toBe('cmd.exe');
        expect(l.cwd).toBeDefined();
      }
    } finally {
      if (prev === undefined) delete process.env.BLOX_STUDIO_MCP_CMD;
      else process.env.BLOX_STUDIO_MCP_CMD = prev;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/bridge.test.ts`
Expected: FAIL — `studioLauncher` is not exported.

- [ ] **Step 3: Add `StudioLaunch` + `cwd` to types** (`src/bridge/types.ts`)

```typescript
export type McpServerConfig =
  | { type?: 'stdio'; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
  | { type: 'sse' | 'http'; url: string; headers?: Record<string, string> }
  | Record<string, unknown>;

export interface StudioLaunch {
  command: string;
  args: string[];
  cwd?: string;
}

export interface StudioBridge {
  /** MCP servers exposed to the agent, keyed by server name. */
  mcpServers(): Record<string, McpServerConfig>;
  /** Fully-qualified tool names the agent may call without prompting. */
  allowedTools(): string[];
}
```

- [ ] **Step 4: Export `studioLauncher` and reuse it** (`src/bridge/mcpBridge.ts`)

Replace the private `launcher()` and `createStudioMcpBridge()` with:

```typescript
import type { StudioBridge, McpServerConfig, StudioLaunch } from './types.js';

// Built-in Roblox Studio MCP server (https://create.roblox.com/docs/studio/mcp).
// stdio transport; a per-OS launcher. The standalone Rust server is deprecated.
// On WSL/Windows the launched process is a *proxy* (StudioMCP.exe) that brokers to
// a running Studio; a Windows-side cwd avoids cmd.exe's "UNC paths not supported"
// warning when spawned from a \\wsl.localhost path.
export function studioLauncher(): StudioLaunch {
  const override = process.env.BLOX_STUDIO_MCP_CMD;
  if (override) {
    const args = (process.env.BLOX_STUDIO_MCP_ARGS ?? '').split(' ').filter(Boolean);
    return { command: override, args };
  }
  if (process.platform === 'darwin') {
    return { command: '/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP', args: [] };
  }
  // Windows and WSL (linux) both reach the Windows batch launcher via cmd.exe.
  const cwd = process.env.BLOX_STUDIO_MCP_CWD ?? '/mnt/c';
  return { command: 'cmd.exe', args: ['/c', '%LOCALAPPDATA%\\Roblox\\mcp.bat'], cwd };
}
```

Keep the existing `TOOLS` array unchanged, and update `createStudioMcpBridge`:

```typescript
export function createStudioMcpBridge(): StudioBridge {
  const { command, args, cwd } = studioLauncher();
  return {
    mcpServers: (): Record<string, McpServerConfig> => ({
      Roblox_Studio: { type: 'stdio', command, args, ...(cwd ? { cwd } : {}) },
    }),
    allowedTools: () => TOOLS.map((t) => `mcp__Roblox_Studio__${t}`),
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/bridge.test.ts`
Expected: PASS (all bridge tests, incl. the new `studioLauncher` block).

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. If `Options.mcpServers` rejects `cwd`, cast the server config object `as McpServerConfig` at the `buildOptions` call site (it already consumes `bridge.mcpServers()`); re-run.

- [ ] **Step 7: Commit**

```bash
git add src/bridge/types.ts src/bridge/mcpBridge.ts tests/bridge.test.ts
git commit -m "feat: export studioLauncher and set a Windows cwd for the MCP hop"
```

---

## Task 3: Doctor core — `runDoctor` against a fake client

**Files:**
- Create: `src/doctor.ts`
- Test: `tests/doctor.test.ts`

- [ ] **Step 1: Write the failing tests** (`tests/doctor.test.ts`)

```typescript
import { describe, it, expect } from 'vitest';
import { runDoctor, formatDoctorReport, type DoctorClient, type McpClientFactory } from '../src/doctor.js';

const launch = { command: 'cmd.exe', args: ['/c', 'x'], cwd: '/mnt/c' };

function fakeFactory(client: Partial<DoctorClient> & { connectThrows?: string }): McpClientFactory {
  return async () => {
    if (client.connectThrows) throw new Error(client.connectThrows);
    return {
      serverInfo: client.serverInfo ?? (() => ({ name: 'RobloxStudio', version: '0.1.0' })),
      listTools: client.listTools ?? (async () => ({ tools: [{ name: 'mcp__Roblox_Studio__execute_luau' }] })),
      callTool: client.callTool ?? (async () => ({ content: [{ type: 'text', text: '2' }], isError: false })),
      close: client.close ?? (async () => {}),
    };
  };
}

describe('runDoctor', () => {
  it('reports not connected when the factory throws', async () => {
    const r = await runDoctor(launch, fakeFactory({ connectThrows: 'spawn cmd.exe ENOENT' }));
    expect(r.connected).toBe(false);
    expect(r.detail).toMatch(/ENOENT/);
  });

  it('reports proxy up but no Studio when execute_luau isError', async () => {
    const r = await runDoctor(launch, fakeFactory({
      callTool: async () => ({ content: [{ type: 'text', text: 'Unable to find an active Studio instance' }], isError: true }),
    }));
    expect(r.connected).toBe(true);
    expect(r.studioAttached).toBe(false);
    expect(r.detail).toMatch(/no Studio attached/i);
  });

  it('reports Studio attached and echoes the luau result', async () => {
    const r = await runDoctor(launch, fakeFactory({}));
    expect(r.connected).toBe(true);
    expect(r.studioAttached).toBe(true);
    expect(r.toolCount).toBe(1);
    expect(r.detail).toMatch(/-> 2/);
  });

  it('still reports connected when no execute_luau tool is advertised', async () => {
    const r = await runDoctor(launch, fakeFactory({
      listTools: async () => ({ tools: [{ name: 'mcp__Roblox_Studio__script_read' }] }),
    }));
    expect(r.connected).toBe(true);
    expect(r.studioAttached).toBeUndefined();
  });
});

describe('formatDoctorReport', () => {
  it('renders a not-connected report', () => {
    const out = formatDoctorReport({ connected: false, detail: 'cannot reach Studio MCP: boom' });
    expect(out).toMatch(/NOT CONNECTED/);
    expect(out).toMatch(/boom/);
  });

  it('renders an attached report with tool count and latency', () => {
    const out = formatDoctorReport({
      connected: true, serverName: 'RobloxStudio', serverVersion: '0.1.0',
      toolCount: 26, tools: ['execute_luau'], connectLatencyMs: 120,
      studioAttached: true, probeLatencyMs: 2, detail: 'Studio attached; execute_luau -> 2',
    });
    expect(out).toMatch(/RobloxStudio/);
    expect(out).toMatch(/26 tools/);
    expect(out).toMatch(/Studio attached/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/doctor.test.ts`
Expected: FAIL — `src/doctor.ts` does not exist.

- [ ] **Step 3: Implement `src/doctor.ts`**

```typescript
import type { StudioLaunch } from './bridge/types.js';

export interface CallToolResult {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

export interface DoctorClient {
  serverInfo(): { name?: string; version?: string } | undefined;
  listTools(): Promise<{ tools: { name: string }[] }>;
  callTool(req: { name: string; arguments: Record<string, unknown> }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type McpClientFactory = (launch: StudioLaunch) => Promise<DoctorClient>;

export interface DoctorReport {
  connected: boolean;
  serverName?: string;
  serverVersion?: string;
  toolCount?: number;
  tools?: string[];
  connectLatencyMs?: number;
  studioAttached?: boolean;
  probeLatencyMs?: number;
  detail: string;
}

// Default factory: real MCP stdio client over the launcher's cmd.exe->mcp.bat hop.
export const defaultClientFactory: McpClientFactory = async (launch) => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const transport = new StdioClientTransport({
    command: launch.command,
    args: launch.args,
    ...(launch.cwd ? { cwd: launch.cwd } : {}),
  });
  const client = new Client({ name: 'blox-doctor', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return {
    serverInfo: () => client.getServerVersion() as { name?: string; version?: string } | undefined,
    listTools: () => client.listTools(),
    callTool: (req) => client.callTool(req) as Promise<CallToolResult>,
    close: () => client.close(),
  };
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

const NO_STUDIO = /no active studio|unable to find an active studio|no studio available/i;

export async function runDoctor(
  launch: StudioLaunch,
  factory: McpClientFactory = defaultClientFactory,
  timeoutMs = 20_000,
): Promise<DoctorReport> {
  const t0 = Date.now();
  let client: DoctorClient | undefined;
  try {
    client = await withTimeout(factory(launch), timeoutMs, 'connect');
    const connectLatencyMs = Date.now() - t0;
    const info = client.serverInfo();
    const listed = await withTimeout(client.listTools(), timeoutMs, 'listTools');
    const tools = listed.tools.map((t) => t.name);

    const luau = tools.find((n) => n.endsWith('execute_luau'));
    if (!luau) {
      return {
        connected: true, serverName: info?.name, serverVersion: info?.version,
        toolCount: tools.length, tools, connectLatencyMs,
        detail: `proxy up: ${info?.name ?? '?'} v${info?.version ?? '?'}, ${tools.length} tools (no execute_luau advertised)`,
      };
    }

    const t1 = Date.now();
    const res = await withTimeout(
      client.callTool({ name: luau, arguments: { code: 'return 1 + 1' } }),
      timeoutMs, 'execute_luau',
    );
    const probeLatencyMs = Date.now() - t1;
    const text = (res.content ?? []).map((c) => c.text ?? '').join('').trim();
    const studioAttached = res.isError !== true && !NO_STUDIO.test(text);
    const detail = studioAttached
      ? `Studio attached; execute_luau -> ${text}`
      : `proxy up but no Studio attached: ${text || '(isError)'}`;

    return {
      connected: true, serverName: info?.name, serverVersion: info?.version,
      toolCount: tools.length, tools, connectLatencyMs, studioAttached, probeLatencyMs, detail,
    };
  } catch (err) {
    return { connected: false, detail: `cannot reach Studio MCP: ${(err as Error)?.message ?? String(err)}` };
  } finally {
    await client?.close().catch(() => {});
  }
}

export function formatDoctorReport(r: DoctorReport): string {
  if (!r.connected) {
    return ['blox doctor', '  status:  NOT CONNECTED', `  detail:  ${r.detail}`].join('\n');
  }
  const lines = [
    'blox doctor',
    '  status:  CONNECTED (proxy)',
    `  server:  ${r.serverName ?? '?'} v${r.serverVersion ?? '?'}`,
    `  tools:   ${r.toolCount ?? 0} tools`,
    `  connect: ${r.connectLatencyMs ?? '?'}ms`,
  ];
  if (r.studioAttached !== undefined) {
    lines.push(`  studio:  ${r.studioAttached ? 'ATTACHED' : 'NOT ATTACHED'}`);
    if (r.probeLatencyMs !== undefined) lines.push(`  probe:   ${r.probeLatencyMs}ms`);
  }
  lines.push(`  detail:  ${r.detail}`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/doctor.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/doctor.ts tests/doctor.test.ts
git commit -m "feat: add layered runDoctor MCP preflight with injected client"
```

---

## Task 4: Wire the `doctor` subcommand into args + CLI

**Files:**
- Modify: `src/args.ts`
- Modify: `src/cli.ts`
- Test: `tests/args.test.ts`

- [ ] **Step 1: Write the failing test** (append to `tests/args.test.ts`)

```typescript
import { parseArgs } from '../src/args.js';

describe('doctor subcommand', () => {
  it('parses a leading doctor token into command', () => {
    const a = parseArgs(['doctor']);
    expect(a.command).toBe('doctor');
    expect(a.prompt).toBeNull();
  });

  it('leaves command null for a normal prompt', () => {
    const a = parseArgs(['Add a comment']);
    expect(a.command).toBeNull();
    expect(a.prompt).toBe('Add a comment');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/args.test.ts`
Expected: FAIL — `command` is not on `ParsedArgs`.

- [ ] **Step 3: Add `command` to `parseArgs`** (`src/args.ts`)

```typescript
export interface ParsedArgs {
  command: 'doctor' | null;
  prompt: string | null;
  mock: boolean;
  projectPath: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  let mock = false;
  let projectPath: string | null = null;
  let command: 'doctor' | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') mock = true;
    else if (a === '--project') projectPath = argv[++i] ?? null;
    else if (a === 'doctor' && command === null && positional.length === 0) command = 'doctor';
    else positional.push(a);
  }
  return { command, prompt: positional.join(' ').trim() || null, mock, projectPath };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/args.test.ts`
Expected: PASS.

- [ ] **Step 5: Route `doctor` in the CLI** (`src/cli.ts`)

Add imports near the top:

```typescript
import { studioLauncher } from './bridge/mcpBridge.js';
import { runDoctor, formatDoctorReport } from './doctor.js';
```

Replace the start of `main()` (the arg-parse + usage block) with:

```typescript
async function main(): Promise<void> {
  const { command, prompt, mock, projectPath } = parseArgs(process.argv.slice(2));

  if (command === 'doctor') {
    const report = await runDoctor(studioLauncher());
    console.log(formatDoctorReport(report));
    process.exit(report.connected ? 0 : 1);
  }

  if (!prompt) {
    console.error('usage: blox "<prompt>" [--mock] [--project <dir>]  |  blox doctor');
    process.exit(2);
  }
```

Leave the rest of `main()` unchanged.

- [ ] **Step 6: Run the full unit suite + typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all unit tests PASS; tsc clean.

- [ ] **Step 7: Build and smoke the subcommand offline**

Run: `npm run build && BLOX_STUDIO_MCP_CMD=/bin/false BLOX_STUDIO_MCP_ARGS= node dist/cli.js doctor; echo "exit=$?"`
Expected: prints a `NOT CONNECTED` report and `exit=1` (proves wiring + non-throwing failure path without a live Studio).

- [ ] **Step 8: Commit**

```bash
git add src/args.ts src/cli.ts tests/args.test.ts
git commit -m "feat: add 'blox doctor' subcommand routing"
```

---

## Task 5: Gated live e2e against a real Studio

**Files:**
- Create: `tests/e2e/live-studio.test.ts`

- [ ] **Step 1: Write the gated test**

```typescript
import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { runDoctor } from '../../src/doctor.js';

// Requires a live Windows Studio with a place open + MCP server enabled.
const enabled = process.env.BLOX_LIVE_STUDIO === '1';

describe.skipIf(!enabled)('live Studio bring-up', () => {
  it('connects to the proxy and lists the SP1b tool surface', async () => {
    const r = await runDoctor(studioLauncher());
    expect(r.connected).toBe(true);
    expect(r.serverName).toBe('RobloxStudio');
    const names = (r.tools ?? []).map((t) => t.replace(/^mcp__Roblox_Studio__/, ''));
    for (const t of ['execute_luau', 'script_read', 'search_game_tree', 'inspect_instance']) {
      expect(names).toContain(t);
    }
  }, 30_000);

  it('runs execute_luau on the attached Studio (return 1 + 1 -> 2)', async () => {
    const r = await runDoctor(studioLauncher());
    expect(r.studioAttached).toBe(true);
    expect(r.detail).toMatch(/-> 2\b/);
  }, 30_000);
});
```

- [ ] **Step 2: Verify it self-skips without the gate**

Run: `npx vitest run tests/e2e/live-studio.test.ts`
Expected: 2 tests SKIPPED (gate off).

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/live-studio.test.ts
git commit -m "test: add gated live Studio bring-up e2e"
```

- [ ] **Step 4 (manual, requires live Studio): run it for real**

Run: `BLOX_LIVE_STUDIO=1 npx vitest run tests/e2e/live-studio.test.ts`
Expected: 2 tests PASS. Record the observed `execute_luau` success text in Task 6. If it reports `NOT ATTACHED`, fix Studio-side setup (place open + MCP enabled) and re-run — no code change needed.

---

## Task 6: Update the reference doc and remove the spike

**Files:**
- Modify: `docs/reference/roblox-studio-mcp.md`
- Delete: `scripts/spike-handshake.mjs`

- [ ] **Step 1: Correct the reference doc**

Add a dated "Observed live surface (2026-06-07)" subsection under "Tool surface" listing the real 26 tool names; correct the wrong rows (`get_console_output` not `console_output`; `user_keyboard_input`/`user_mouse_input` not `keyboard_input`/`mouse_input`; generic `subagent`; `execute_luau` only). Under "Transport & connection" add the **two-layer proxy** note: the launched process is a `StudioMCP.exe` proxy; `tools/list` succeeds even with no Studio attached; an unattached call returns the standard `CallToolResult` `{ content:[{type:'text',text}], isError:true }`. Note `execute_luau`'s argument is `code` (string).

- [ ] **Step 2: Delete the throwaway spike**

```bash
git rm scripts/spike-handshake.mjs
```

- [ ] **Step 3: Verify nothing references the spike**

Run: `grep -rn "spike-handshake" . --exclude-dir=node_modules || echo "no refs"`
Expected: `no refs` (or only the spec's historical mention, which is fine).

- [ ] **Step 4: Commit**

```bash
git add docs/reference/roblox-studio-mcp.md
git commit -m "docs: correct Studio MCP tool surface from live observation; drop spike"
```

---

## Task 7: Final verification

- [ ] **Step 1: Full suite green**

Run: `npx vitest run`
Expected: all unit tests + real-rojo integration PASS; live e2e SKIPPED (gate off).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc --noEmit && npm run build`
Expected: clean; `dist/cli.js` produced.

- [ ] **Step 3: Offline doctor smoke**

Run: `BLOX_STUDIO_MCP_CMD=/bin/false BLOX_STUDIO_MCP_ARGS= node dist/cli.js doctor; echo "exit=$?"`
Expected: `NOT CONNECTED` report, `exit=1`.

- [ ] **Step 4 (with live Studio): real doctor**

Run: `node dist/cli.js doctor`
Expected: `CONNECTED (proxy)` + `studio: ATTACHED` + `execute_luau -> 2`.

---

## Self-Review

- **Spec coverage:** §4.1 doctor core → Task 3; §4.2 cli route → Task 4; §4.3 args → Task 4; §4.4 bridge cwd → Task 2; §4.5 live e2e → Task 5; §4.6 reference doc → Task 6; §4.7 spike cleanup → Task 6; dependency promotion (§3) → Task 1. All covered.
- **Placeholder scan:** every code step shows full code; no TBD/TODO.
- **Type consistency:** `StudioLaunch` (Task 2) consumed by `runDoctor`/`defaultClientFactory` (Task 3) and `studioLauncher()`/CLI (Tasks 2,4); `DoctorReport`/`DoctorClient`/`McpClientFactory` names identical across `src/doctor.ts` and `tests/doctor.test.ts`; `parseArgs` gains `command` (Task 4) consumed in `cli.ts` (Task 4).
