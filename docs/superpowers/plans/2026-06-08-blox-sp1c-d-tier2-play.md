# blox SP1c-d — tier-2 play Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Studio play-testing (`start_stop_play` + `get_console_output`) to the agent so it can verify runtime/gameplay behavior, not just module logic.

**Architecture:** Agent-driven pass-through (same shape as `execute_luau`/asset tools). No new blox module: add the two tools to the real bridge's allow-list, fake them in the mock bridge, and add conditional play-verify guidance to the system prompt. blox adds zero orchestration — the agent owns start/stop.

**Tech Stack:** TypeScript/ESM, Node ≥20, vitest, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`/`tool`), zod, `@modelcontextprotocol/sdk` (live test client).

**Spec:** `docs/superpowers/specs/2026-06-08-blox-sp1c-d-tier2-play-design.md`

---

## File Structure

- Modify `src/bridge/mcpBridge.ts` — add `start_stop_play`, `get_console_output` to `TOOLS` (10 → 12).
- Modify `src/bridge/mockBridge.ts` — `playResult()` helper, `consoleResults?: string[]` option, two tool fakes, two `allowedTools` entries.
- Modify `src/agent/systemPrompt.ts` — conditional play-verify section.
- Modify `tests/bridge.test.ts` — real-bridge presence test + `playResult` test (parity test already covers the new tools).
- Modify `tests/systemPrompt.test.ts` — assert the play-verify phrases.
- Create `tests/e2e/live-play.test.ts` — gated live test (`BLOX_LIVE_PLAY=1`).

**Coupling note:** `tests/bridge.test.ts` has a parity test (`mock allowedTools == real allowedTools`). Both bridges must be updated together in Task 1 or that test breaks. Do not split the two bridges across tasks.

---

## Task 1: Both bridges — expose `start_stop_play` + `get_console_output`

**Files:**
- Modify: `src/bridge/mcpBridge.ts` (`TOOLS` array)
- Modify: `src/bridge/mockBridge.ts` (`MockBridgeOptions`, `playResult`, tool fakes, `allowedTools`)
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/bridge.test.ts`, update the import to include `playResult`:

```typescript
import { createMockStudioBridge, sequenceResponder, playResult } from '../src/bridge/mockBridge.js';
```

Add a presence assertion inside the existing `describe('real studio bridge')` block (after the `execute_luau`/`generate_mesh` test, around line 22):

```typescript
  it('exposes the tier-2 play tools', () => {
    const b = createStudioMcpBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__start_stop_play');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__get_console_output');
  });
```

Add a `playResult` test inside the existing `describe('mock studio bridge')` block (after the parity test, around line 49):

```typescript
  it('playResult echoes the play state by is_start', () => {
    expect(playResult(true)).toMatch(/Started/);
    expect(playResult(false)).toMatch(/Stopped/);
  });

  it('exposes the tier-2 play tools in the mock too', () => {
    const b = createMockStudioBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__start_stop_play');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__get_console_output');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge.test.ts`
Expected: FAIL — `playResult` is not exported (import error / `playResult is not a function`), and the new `allowedTools` assertions fail because the tools aren't listed yet. The existing parity test also fails once you partially edit; that's why both bridges land in this one task.

- [ ] **Step 3: Write minimal implementation**

In `src/bridge/mcpBridge.ts`, add the two tools to the `TOOLS` array. Place them right after `'execute_luau'` (group the run/observe tools). The array becomes:

```typescript
const TOOLS = [
  'search_game_tree',
  'inspect_instance',
  'script_read',
  'script_search',
  'script_grep',
  'execute_luau',
  'start_stop_play',
  'get_console_output',
  'generate_mesh',
  'generate_material',
  'generate_procedural_model',
  'insert_from_creator_store',
];
```

In `src/bridge/mockBridge.ts`:

1. Add the option to `MockBridgeOptions`:

```typescript
export interface MockBridgeOptions {
  /** Successive execute_luau outputs; the last repeats. */
  luauResults?: string[];
  /** Successive get_console_output values; the last repeats. */
  consoleResults?: string[];
}
```

2. Add the exported pure helper (above `createMockStudioBridge`, near `sequenceResponder`):

```typescript
// Deterministic start_stop_play echo for the mock bridge.
export function playResult(isStart: boolean): string {
  return isStart ? '[mock] Game Started' : '[mock] Game Stopped';
}
```

3. Inside `createMockStudioBridge`, add a console responder next to `nextLuau`:

```typescript
  const nextLuau = sequenceResponder(opts.luauResults ?? ['[mock] ok: tests passed']);
  const nextConsole = sequenceResponder(opts.consoleResults ?? ['[mock] (console) ok']);
```

4. Add the two tool fakes to the `tools: [...]` array (after the `execute_luau` entry):

```typescript
      tool('start_stop_play', 'Start or stop a (fake) play session', { is_start: z.boolean() },
        async ({ is_start }) => ({ content: [{ type: 'text' as const, text: playResult(is_start) }] })),
      tool('get_console_output', 'Return (fake) Studio console output', {},
        async () => ({ content: [{ type: 'text' as const, text: nextConsole() }] })),
```

5. Add both names to the mock `allowedTools()` list (after `'execute_luau'`):

```typescript
    allowedTools: () =>
      [
        'search_game_tree', 'inspect_instance',
        'script_read', 'script_search', 'script_grep', 'execute_luau',
        'start_stop_play', 'get_console_output',
        'generate_mesh', 'generate_material', 'generate_procedural_model', 'insert_from_creator_store',
      ].map((t) => `mcp__Roblox_Studio__${t}`),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bridge.test.ts`
Expected: PASS — presence tests pass, `playResult` test passes, parity test passes (both bridges now list all 12 tools).

- [ ] **Step 5: Commit**

```bash
git add src/bridge/mcpBridge.ts src/bridge/mockBridge.ts tests/bridge.test.ts
git commit -m "feat: expose tier-2 play tools (start_stop_play, get_console_output)"
```

---

## Task 2: System prompt — conditional play-verify guidance

**Files:**
- Modify: `src/agent/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/systemPrompt.test.ts`, add assertions to the existing `it('orients the agent ...')` test (after the `generate_mesh` assertion, around line 23):

```typescript
    expect(p).toContain('start_stop_play');
    expect(p).toContain('get_console_output');
    expect(p).toContain('CLIENT context');
    expect(p).toContain('stop play');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: FAIL — the prompt does not yet contain `start_stop_play` / `get_console_output` / `CLIENT context` / `stop play`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/systemPrompt.ts`, insert a play-testing block into the returned array. Place it immediately after the existing `'Verify loop:'` block and before the `'Assets:'` line (after the line that ends the verify loop: `'- Never use multi_edit; ...'`):

```typescript
    '',
    'Play-testing (runtime verification):',
    '- Most changes verify with edit-mode execute_luau (above): fast and cheap.',
    '- When the behavior only appears while the game RUNS (events, lifecycle,',
    '  player/character, the game loop), play-test it: start play with',
    '  start_stop_play {is_start: true}, exercise it, then read the results.',
    '- While play is running, execute_luau runs in CLIENT context. To check',
    '  server-side state, surface it to the client first (RemoteEvent/attribute).',
    '- Read runtime output with get_console_output.',
    '- ALWAYS stop play with start_stop_play {is_start: false} when done — blox',
    '  does not stop play for you. Start and stop each take a few seconds.',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: PASS — all four new substrings are present.

- [ ] **Step 5: Commit**

```bash
git add src/agent/systemPrompt.ts tests/systemPrompt.test.ts
git commit -m "feat: conditional play-verify guidance in system prompt"
```

---

## Task 3: Gated live test

**Files:**
- Create: `tests/e2e/live-play.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/e2e/live-play.test.ts`. It self-skips unless `BLOX_LIVE_PLAY=1`. It uses `defaultClientFactory` (exported from `src/doctor.ts`) for a single persistent client across the start → run → read → stop sequence (`probeExecuteLuau` connects/closes per call, so it cannot hold a play session open).

```typescript
import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory } from '../../src/doctor.js';

// Requires: a live Studio attached (place open, MCP enabled). No rojo needed.
const enabled = process.env.BLOX_LIVE_PLAY === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(res: { content?: { text?: string }[] }): string {
  return (res?.content ?? []).map((c) => c?.text ?? '').join('').trim();
}

describe.skipIf(!enabled)('tier-2 play (live)', () => {
  it('starts play, runs execute_luau in-play, reads an injected console marker, stops play', async () => {
    const client = await defaultClientFactory(studioLauncher());
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    const find = (suffix: string) => names.find((n) => n.endsWith(suffix)) ?? suffix;
    const play = find('start_stop_play');
    const consoleTool = find('get_console_output');
    const luau = find('execute_luau');
    expect(names.some((n) => n.endsWith('start_stop_play'))).toBe(true);
    expect(names.some((n) => n.endsWith('get_console_output'))).toBe(true);

    const marker = `PLAY-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    let started = false;
    try {
      await client.callTool({ name: play, arguments: { is_start: true } });
      started = true;
      await sleep(5000); // play spin-up is multi-second

      // execute_luau runs in-play (client context) -> IsRunning() is true
      let running = false;
      for (let i = 0; i < 6 && !running; i++) {
        const r = await client.callTool({
          name: luau,
          arguments: { code: "return tostring(game:GetService('RunService'):IsRunning())" },
        });
        running = textOf(r).includes('true');
        if (!running) await sleep(800);
      }
      expect(running).toBe(true);

      // inject a runtime print, then read it back from the console
      await client.callTool({ name: luau, arguments: { code: `print('${marker}') return 'ok'` } });
      let seen = false;
      for (let i = 0; i < 6 && !seen; i++) {
        const r = await client.callTool({ name: consoleTool, arguments: {} });
        seen = textOf(r).includes(marker);
        if (!seen) await sleep(500);
      }
      expect(seen).toBe(true);
    } finally {
      if (started) await client.callTool({ name: play, arguments: { is_start: false } }).catch(() => {});
      await client.close().catch(() => {});
    }
  }, 60_000);
});
```

- [ ] **Step 2: Verify it skips without the flag**

Run: `npx vitest run tests/e2e/live-play.test.ts`
Expected: the suite is skipped (0 tests run, 1 skipped) because `BLOX_LIVE_PLAY` is unset.

- [ ] **Step 3: Run it live (manual gate)**

Prerequisite: Windows Studio running, the fixture place open, "Studio as MCP server" enabled in Assistant settings.
Run: `BLOX_LIVE_PLAY=1 npx vitest run tests/e2e/live-play.test.ts`
Expected: PASS — starts play, `IsRunning()` becomes `true`, the injected marker appears in `get_console_output`, play stops. (Manual; do not block the task on this if no live Studio is available — Step 2's skip is the gating check.)

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/live-play.test.ts
git commit -m "test: gated live test for tier-2 play (BLOX_LIVE_PLAY=1)"
```

---

## Task 4: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: all unit tests pass; the gated live tests (`live-studio`, `live-sync`, `live-serve`, `live-play`) are skipped. Confirm the pass count went up by the tests added in Tasks 1–2 and the skip count went up by 1 (live-play).

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: no type errors; `dist/cli.js` is produced.

- [ ] **Step 3: Final commit if anything was adjusted**

Only if Steps 1–2 forced a fix:

```bash
git add -A
git commit -m "chore: SP1c-d tier-2 play verification fixes"
```

---

## Self-Review Notes

**Spec coverage:**
- §4.1 real bridge tools → Task 1.
- §4.2 mock fakes + `consoleResults` + parity → Task 1.
- §4.3 system prompt conditional guidance + client-context caveat + always-stop → Task 2.
- §6.1 unit (start/stop echo, console sequence via `sequenceResponder`, parity, real `TOOLS` presence) → Task 1 (`playResult` test + presence tests; console sequence is the already-tested `sequenceResponder`, reused via `consoleResults`).
- §6.2 gated live test → Task 3.
- §6.3 full suite/tsc/build → Task 4.
- §7 out-of-scope items: none implemented (correct — no blox play gate, no sync gate, no input sim).
- §8 success criteria 1–4 → Tasks 1,2,4; criterion 5 → Task 3 Step 3 (manual gate).

**Placeholder scan:** none — every code step shows full code; the only manual step (Task 3 Step 3) is explicitly a manual live gate, not a placeholder.

**Type consistency:** `playResult(isStart: boolean): string` defined in Task 1 and used in the same task's mock fake; test calls `playResult(true|false)`. Mock fake arg `is_start` (zod boolean) matches the live tool's arg and the live test's `{ is_start: true|false }`. `consoleResults?: string[]` matches the `sequenceResponder(string[])` signature. Live test uses `defaultClientFactory`/`studioLauncher` with their existing signatures (`DoctorClient.callTool({name, arguments})`).
