# blox SP2-a — input simulation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Studio input simulation (`character_navigation`, `user_keyboard_input`, `user_mouse_input`) to the agent so it can verify interactive gameplay, building on the tier-2 play loop.

**Architecture:** Agent-driven pass-through, identical to SP1c-d. No new blox module: add the three tools to the real bridge's allow-list, fake them in the mock bridge, and add input-sim guidance to the system prompt. The agent owns the play lifecycle; input tools only work in play.

**Tech Stack:** TypeScript/ESM, Node ≥20, vitest, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`/`tool`), zod, `@modelcontextprotocol/sdk` (live test client).

**Spec:** `docs/superpowers/specs/2026-06-08-blox-sp2-a-input-sim-design.md`

---

## File Structure

- Modify `src/bridge/mcpBridge.ts` — add the 3 input tools to `TOOLS` (12 → 15).
- Modify `src/bridge/mockBridge.ts` — 3 tool fakes with zod schemas mirroring the probed shapes; add 3 names to `allowedTools`.
- Modify `src/agent/systemPrompt.ts` — input-sim verify block.
- Modify `tests/bridge.test.ts` — real + mock presence tests (parity test already covers the new tools).
- Modify `tests/systemPrompt.test.ts` — assert the input-sim phrases.
- Create `tests/e2e/live-input.test.ts` — gated live test (`BLOX_LIVE_INPUT=1`).

**Coupling note:** `tests/bridge.test.ts` has a parity test (`mock allowedTools == real allowedTools`). Both bridges must be updated together in Task 1 or that test breaks. Do not split the two bridges across tasks.

---

## Task 1: Both bridges — expose the 3 input-sim tools

**Files:**
- Modify: `src/bridge/mcpBridge.ts` (`TOOLS` array)
- Modify: `src/bridge/mockBridge.ts` (tool fakes + `allowedTools`)
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/bridge.test.ts`, add a presence assertion inside the existing `describe('real studio bridge')` block (after the existing tier-2 play tools test):

```typescript
  it('exposes the input-sim tools', () => {
    const b = createStudioMcpBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__character_navigation');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__user_keyboard_input');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__user_mouse_input');
  });
```

And inside the existing `describe('mock studio bridge')` block (after the existing tier-2 mock presence test):

```typescript
  it('exposes the input-sim tools in the mock too', () => {
    const b = createMockStudioBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__character_navigation');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__user_keyboard_input');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__user_mouse_input');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge.test.ts`
Expected: FAIL — the new `allowedTools` assertions fail (tools not listed yet); the existing parity test also fails if only one bridge is partially edited (that's why both bridges land in this one task).

- [ ] **Step 3: Write minimal implementation**

In `src/bridge/mcpBridge.ts`, add the three tools to the `TOOLS` array, right after `'get_console_output'`. The array becomes:

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
  'character_navigation',
  'user_keyboard_input',
  'user_mouse_input',
  'generate_mesh',
  'generate_material',
  'generate_procedural_model',
  'insert_from_creator_store',
];
```

In `src/bridge/mockBridge.ts`, add three tool fakes to the `tools: [...]` array, right after the `get_console_output` entry. The zod schemas mirror the probed shapes; the fakes ignore inputs and return canned text:

```typescript
      tool('character_navigation', 'Navigate the (fake) character to a position or instance',
        {
          instance_path: z.string().optional(),
          x: z.number().optional(),
          y: z.number().optional(),
          z: z.number().optional(),
          speed_multiplier: z.number().optional(),
        },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] navigated' }] })),
      tool('user_keyboard_input', 'Send (fake) keyboard actions',
        {
          actions: z.array(z.object({
            action: z.string(),
            key_code: z.string().optional(),
            instance_path: z.string().optional(),
            text_inputs: z.string().optional(),
            wait_time_ms: z.number().optional(),
          })),
        },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] Success' }] })),
      tool('user_mouse_input', 'Send (fake) mouse actions',
        {
          actions: z.array(z.object({
            action: z.string(),
            x: z.number().optional(),
            y: z.number().optional(),
            instance_path: z.string().optional(),
            mouse_button: z.string().optional(),
            wait_time_ms: z.number().optional(),
          })),
        },
        async () => ({ content: [{ type: 'text' as const, text: '[mock] Success' }] })),
```

Then add the three names to the mock `allowedTools()` list (after `'start_stop_play', 'get_console_output',`):

```typescript
    allowedTools: () =>
      [
        'search_game_tree', 'inspect_instance',
        'script_read', 'script_search', 'script_grep', 'execute_luau',
        'start_stop_play', 'get_console_output',
        'character_navigation', 'user_keyboard_input', 'user_mouse_input',
        'generate_mesh', 'generate_material', 'generate_procedural_model', 'insert_from_creator_store',
      ].map((t) => `mcp__Roblox_Studio__${t}`),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bridge.test.ts`
Expected: PASS — presence tests pass, parity test passes (both bridges now list all 15 tools).

- [ ] **Step 5: Commit**

```bash
git add src/bridge/mcpBridge.ts src/bridge/mockBridge.ts tests/bridge.test.ts
git commit -m "feat: expose input-sim tools (character_navigation, keyboard, mouse)"
```

---

## Task 2: System prompt — input-sim verify guidance

**Files:**
- Modify: `src/agent/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/systemPrompt.test.ts`, add assertions to the existing `it('orients the agent ...')` test (after the existing play-testing assertions):

```typescript
    expect(p).toContain('character_navigation');
    expect(p).toContain('user_keyboard_input');
    expect(p).toContain('user_mouse_input');
    expect(p).toContain('wait/poll');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: FAIL — the prompt does not yet contain `character_navigation` / `user_keyboard_input` / `user_mouse_input` / `wait/poll`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/systemPrompt.ts`, insert an input-sim block immediately after the existing `'Play-testing (runtime verification):'` block (after the line `'- ALWAYS stop play with start_stop_play {is_start: false} when done — blox',` and its continuation `'  does not stop play for you. Start and stop each take a few seconds.',`) and before the `'Assets:'` line:

```typescript
    '',
    'Input simulation (interactive verification):',
    '- The input tools work ONLY while play is running (start play first).',
    '- To verify player-driven behavior: start play, drive input with',
    '  character_navigation / user_keyboard_input / user_mouse_input, then assert',
    '  the result with execute_luau (client context) or get_console_output.',
    '- character_navigation is asynchronous: after it returns, wait/poll for the',
    '  character to reach the target (re-read HumanoidRootPart position) before',
    '  asserting — do not expect instant arrival.',
    '- Prefer character_navigation for movement checks (position is directly',
    '  readable). Use keyboard/mouse for controls and UI.',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: PASS — all four new substrings are present.

- [ ] **Step 5: Commit**

```bash
git add src/agent/systemPrompt.ts tests/systemPrompt.test.ts
git commit -m "feat: input-sim verify guidance in system prompt"
```

---

## Task 3: Gated live test

**Files:**
- Create: `tests/e2e/live-input.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/e2e/live-input.test.ts`. It self-skips unless `BLOX_LIVE_INPUT=1`. It uses `defaultClientFactory` for a single persistent client across the start → navigate → observe → stop sequence. The flow mirrors the working probe: start play (attach-retry), wait for `IsRunning`, read the character's start position, navigate to an offset, poll until the position changes (navigation is async), then assert the keyboard/mouse calls succeed.

```typescript
import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory, type DoctorClient } from '../../src/doctor.js';

// Requires: a live Studio attached with a place that spawns a player character.
const enabled = process.env.BLOX_LIVE_INPUT === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_STUDIO = /no active studio|unable to find an active studio/i;

function textOf(res: { content?: { text?: string }[] }): string {
  return (res?.content ?? []).map((c) => c?.text ?? '').join('').trim();
}

const HRP_POS =
  "local c=game.Players.LocalPlayer and game.Players.LocalPlayer.Character " +
  "local r=c and c:FindFirstChild('HumanoidRootPart') return r and tostring(r.Position) or 'no-hrp'";

describe.skipIf(!enabled)('input simulation (live)', () => {
  it('navigates the character in play and observes the position change', async () => {
    let client: DoctorClient | undefined;
    let play: string | undefined;
    let started = false;
    try {
      client = await defaultClientFactory(studioLauncher());
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      const find = (s: string) => names.find((n) => n.endsWith(s)) ?? s;
      play = find('start_stop_play');
      const luau = find('execute_luau');
      const nav = find('character_navigation');
      const kbd = find('user_keyboard_input');
      const mouse = find('user_mouse_input');
      for (const s of ['character_navigation', 'user_keyboard_input', 'user_mouse_input']) {
        expect(names.some((n) => n.endsWith(s))).toBe(true);
      }

      const callLuau = async (code: string) =>
        textOf(await client!.callTool({ name: luau, arguments: { code } }));

      // start play (attach retry), then wait for IsRunning
      let startText = '';
      for (let i = 0; i < 10 && !/game started/i.test(startText); i++) {
        startText = textOf(await client.callTool({ name: play, arguments: { is_start: true } }));
        if (!/game started/i.test(startText)) await sleep(700);
      }
      started = true;
      let running = false;
      for (let i = 0; i < 10 && !running; i++) {
        running = (await callLuau("return tostring(game:GetService('RunService'):IsRunning())")).includes('true');
        if (!running) await sleep(700);
      }
      expect(running).toBe(true);

      // wait for the character, read start position
      let startPos = 'no-hrp';
      for (let i = 0; i < 12 && (startPos === 'no-hrp' || NO_STUDIO.test(startPos)); i++) {
        startPos = await callLuau(HRP_POS);
        if (startPos === 'no-hrp') await sleep(700);
      }
      expect(startPos).not.toBe('no-hrp');

      // navigate to an offset; assert the call succeeds
      const navRes = await client.callTool({
        name: nav,
        arguments: { x: 16, y: 5, z: 16, speed_multiplier: 2.0 },
      });
      expect(navRes.isError === true).toBe(false);
      expect(textOf(navRes)).toMatch(/success/i);

      // poll until the position changes (navigation is async)
      let moved = false;
      for (let i = 0; i < 10 && !moved; i++) {
        await sleep(800);
        const pos = await callLuau(HRP_POS);
        moved = pos !== 'no-hrp' && pos !== startPos;
      }
      expect(moved).toBe(true);

      // keyboard + mouse: assert each call succeeds (game-effect depends on wiring)
      const kbdRes = await client.callTool({
        name: kbd,
        arguments: { actions: [{ action: 'keyPress', key_code: 'Space' }] },
      });
      expect(kbdRes.isError === true).toBe(false);
      const mouseRes = await client.callTool({
        name: mouse,
        arguments: { actions: [{ action: 'moveTo', x: 400, y: 300 }, { action: 'mouseButtonClick', mouse_button: 'left' }] },
      });
      expect(mouseRes.isError === true).toBe(false);
    } finally {
      if (started && play) await client?.callTool({ name: play, arguments: { is_start: false } }).catch(() => {});
      await client?.close().catch(() => {});
    }
  }, 90_000);
});
```

- [ ] **Step 2: Verify it skips without the flag**

Run: `npx vitest run tests/e2e/live-input.test.ts`
Expected: the suite is skipped (1 skipped) because `BLOX_LIVE_INPUT` is unset. Also confirm `npx tsc -p tsconfig.json --noEmit` is clean (this verifies `type DoctorClient` imports correctly — it is exported from `src/doctor.ts`).

- [ ] **Step 3: Run it live (manual gate)** — SKIP if no live Studio is available. Step 2's skip is the gating check.

Prerequisite: Windows Studio running, a place that spawns a player character open, "Studio as MCP server" enabled.
Run: `BLOX_LIVE_INPUT=1 npx vitest run tests/e2e/live-input.test.ts`
Expected: PASS — starts play, character spawns, navigation moves the HRP (position changes), keyboard/mouse calls succeed, play stops.

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/live-input.test.ts
git commit -m "test: gated live test for input simulation (BLOX_LIVE_INPUT=1)"
```

---

## Task 4: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: all unit tests pass; the gated live tests (`live-studio`, `live-sync`, `live-serve`, `live-play`, `live-input`) are skipped. The skip count went up by 1 (live-input) vs the SP1c-d baseline; the pass count went up by the bridge presence tests added in Task 1.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: no type errors; `dist/cli.js` is produced.

- [ ] **Step 3: Final commit if anything was adjusted**

Only if Steps 1–2 forced a fix:

```bash
git add -A
git commit -m "chore: SP2-a input-sim verification fixes"
```

---

## Self-Review Notes

**Spec coverage:**
- §4.1 real bridge (3 tools, 12→15) → Task 1.
- §4.2 mock fakes (zod schemas mirroring probed shapes, canned success) + parity → Task 1.
- §4.3 system prompt (play-required, drive-then-assert, async-nav, prefer nav) → Task 2.
- §6.1 unit (real `TOOLS` presence, parity, mock presence, prompt phrases) → Tasks 1–2.
- §6.2 gated live test (start → nav → position change → keyboard/mouse success → stop) → Task 3.
- §6.3 full suite/tsc/build → Task 4.
- §7 out-of-scope: nothing implemented (no screen_capture, no richer context, no session tools, no orchestration layer) — correct.
- §8 success criteria 1–4 → Tasks 1,2,4; criterion 5 → Task 3 Step 3 (manual gate).

**Placeholder scan:** none — every code step shows full code; the only manual step (Task 3 Step 3) is an explicit live gate, not a placeholder.

**Type consistency:** mock fake arg shapes (`instance_path`/`x`/`y`/`z`/`speed_multiplier`; `actions[]` with `action`/`key_code`/`text_inputs`/`wait_time_ms`; `actions[]` with `action`/`x`/`y`/`mouse_button`/`wait_time_ms`) match the probed schemas in spec §3 and the live test's call arguments (`{ x, y, z, speed_multiplier }`, `{ actions: [{ action, key_code }] }`, `{ actions: [{ action, x, y }, { action, mouse_button }] }`). Live test uses `defaultClientFactory`/`studioLauncher`/`type DoctorClient` with their existing signatures (`DoctorClient.callTool({name, arguments})`). Tool names added in Task 1 (`character_navigation`, `user_keyboard_input`, `user_mouse_input`) are exactly the strings asserted in Task 1 tests, Task 2 prompt, and Task 3 live test.
