# blox SP2-b — visual verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose Studio `screen_capture` to the agent so it can verify *visual/rendered* game state (UI, models, VFX) during the tier-2 play loop; the captured frame is forwarded to Opus as vision input by the Agent SDK.

**Architecture:** Agent-driven pass-through, identical to SP2-a. No new blox module: add `screen_capture` to the real bridge's allow-list, fake it in the mock bridge (returning an **image** content block, not text), and add visual-verify guidance to the system prompt. The agent owns the play lifecycle; `screen_capture` only works in play.

**Tech Stack:** TypeScript/ESM, Node ≥20, vitest, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`/`tool`), zod, `@modelcontextprotocol/sdk` (live test client).

**Spec:** `docs/superpowers/specs/2026-06-08-blox-sp2-b-visual-verify-design.md`

---

## File Structure

- Modify `src/bridge/mcpBridge.ts` — add `screen_capture` to `TOOLS` (15 → 16).
- Modify `src/bridge/mockBridge.ts` — export a `captureResult()` helper (image content block) + a `screen_capture` fake using it; add `screen_capture` to `allowedTools`.
- Modify `src/agent/systemPrompt.ts` — visual-verify block.
- Modify `tests/bridge.test.ts` — real + mock presence tests; a `captureResult()` image-shape test (parity test already covers the new tool).
- Modify `tests/systemPrompt.test.ts` — assert the visual-verify phrases.
- Create `tests/e2e/live-capture.test.ts` — gated live test (`BLOX_LIVE_CAPTURE=1`).

**Coupling note:** `tests/bridge.test.ts` has a parity test (`mock allowedTools == real allowedTools`). Both bridges must be updated together in Task 1 or that test breaks. Do not split the two bridges across tasks.

---

## Task 1: Both bridges — expose `screen_capture`

**Files:**
- Modify: `src/bridge/mcpBridge.ts` (`TOOLS` array)
- Modify: `src/bridge/mockBridge.ts` (`captureResult` helper + fake + `allowedTools`)
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/bridge.test.ts`, first add `captureResult` to the existing import from `../src/bridge/mockBridge.js`. The current import line looks like:

```typescript
import { createMockStudioBridge } from '../src/bridge/mockBridge.js';
```

Change it to also import `captureResult`:

```typescript
import { createMockStudioBridge, captureResult } from '../src/bridge/mockBridge.js';
```

(If the file imports other names from `mockBridge.js`, keep them — just add `captureResult` to the same braces.)

Add a presence assertion inside the existing `describe('real studio bridge')` block (after the existing input-sim tools test):

```typescript
  it('exposes the screen_capture tool', () => {
    const b = createStudioMcpBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__screen_capture');
  });
```

Add a presence assertion inside the existing `describe('mock studio bridge')` block (after the existing input-sim mock presence test):

```typescript
  it('exposes the screen_capture tool in the mock too', () => {
    const b = createMockStudioBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__screen_capture');
  });

  it('captureResult returns an image content block', () => {
    const block = captureResult();
    expect(block.type).toBe('image');
    expect(block.mimeType).toBe('image/png');
    expect(block.data.length).toBeGreaterThan(0);
  });
```

NOTE: Match the exact factory/import names already used in `tests/bridge.test.ts` (e.g. `createStudioMcpBridge` for the real bridge). Use whatever names the existing tests in that file already use — do not introduce a new import beyond `captureResult`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge.test.ts`
Expected: FAIL — `captureResult` is not exported yet (import error / not a function) and the `allowedTools` assertions fail (tool not listed yet); the existing parity test also fails once one bridge is partially edited (that's why both bridges land in this one task).

- [ ] **Step 3: Write minimal implementation**

In `src/bridge/mcpBridge.ts`, update the comment header above `TOOLS` and add `screen_capture` to the `TOOLS` array, right after `'user_mouse_input'`. The comment + array become:

```typescript
// SP1b tool surface: read/search the game + run Luau + generate prototype assets.
// SP1c-d additions: start_stop_play and get_console_output (tier-2 play-testing).
// SP2-a additions: character_navigation, user_keyboard_input, user_mouse_input (input simulation).
// SP2-b addition: screen_capture (visual verification — image returned to the model as vision).
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
  'screen_capture',
  'generate_mesh',
  'generate_material',
  'generate_procedural_model',
  'insert_from_creator_store',
];
```

In `src/bridge/mockBridge.ts`, add the `captureResult` helper next to the existing `playResult` helper (after the `playResult` function, before `createMockStudioBridge`):

```typescript
// 1x1 transparent PNG — a deterministic stand-in for a captured frame.
const MOCK_CAPTURE_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// Deterministic screen_capture result: an image content block, like the real tool.
// (The Agent SDK forwards image content blocks to the model as vision input.)
export function captureResult(): { type: 'image'; data: string; mimeType: string } {
  return { type: 'image' as const, data: MOCK_CAPTURE_PNG, mimeType: 'image/png' };
}
```

Then add the `screen_capture` fake to the `tools: [...]` array, right after the `user_mouse_input` entry and before the `generate_mesh` entry:

```typescript
      tool('screen_capture', 'Return a (fake) captured viewport frame', {},
        async () => ({ content: [captureResult()] })),
```

Then add `'screen_capture'` to the mock `allowedTools()` list, right after `'character_navigation', 'user_keyboard_input', 'user_mouse_input',`:

```typescript
    allowedTools: () =>
      [
        'search_game_tree', 'inspect_instance',
        'script_read', 'script_search', 'script_grep', 'execute_luau',
        'start_stop_play', 'get_console_output',
        'character_navigation', 'user_keyboard_input', 'user_mouse_input',
        'screen_capture',
        'generate_mesh', 'generate_material', 'generate_procedural_model', 'insert_from_creator_store',
      ].map((t) => `mcp__Roblox_Studio__${t}`),
```

IMPORTANT: READ the current contents of both files first and match the existing formatting/ordering/`tool(...)` call signature exactly. The existing `get_console_output` fake (an empty-schema `{}` tool) and the `playResult` helper show the correct shapes to mirror. Insert in the positions described; do not reorder unrelated existing entries.

If `tsc` rejects the image content block in the `tool(...)` return type (the SDK's content type should accept `{type:'image', data, mimeType}` — verified against the installed SDK source), do NOT change the architecture; report it as DONE_WITH_CONCERNS with the exact error. (It is expected to typecheck cleanly.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bridge.test.ts`
Expected: PASS — presence tests pass, `captureResult` image-shape test passes, parity test passes (both bridges now list all 16 tools).

- [ ] **Step 5: Commit**

```bash
git add src/bridge/mcpBridge.ts src/bridge/mockBridge.ts tests/bridge.test.ts
git commit -m "feat: expose screen_capture for visual verification"
```

---

## Task 2: System prompt — visual-verify guidance

**Files:**
- Modify: `src/agent/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/systemPrompt.test.ts`, add assertions to the existing `it('orients the agent ...')` test (after the existing input-sim assertions, e.g. after the `expect(p).toContain('wait/poll')` line):

```typescript
    expect(p).toContain('screen_capture');
    expect(p).toContain('Visual verification');
    expect(p).toContain('only visible on screen');
```

NOTE: The exact `it(...)` test name may differ. Find the existing test that builds the prompt string (variable likely named `p`) and asserts on the play-testing / input-sim phrases, and append these three assertions there. Match the existing variable name and style.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: FAIL — the prompt does not yet contain `screen_capture` / `Visual verification` / `only visible on screen`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/systemPrompt.ts`, insert a visual-verify block immediately after the existing input-sim block (after the line `'  readable). Use keyboard/mouse for controls and UI.',`) and before the `'Assets: when the task needs prototype assets, use generate_mesh,'` line:

```typescript
    '',
    'Visual verification (tier-3 — looking at the game):',
    '- screen_capture works ONLY while play is running (start play first). It',
    '  returns the rendered viewport as an image you can see directly.',
    '- Use it to confirm things only visible on screen: UI layout, model / mesh /',
    '  material appearance, VFX, camera framing, on-screen feedback.',
    '- Pair with input simulation: drive the player or set up state, THEN capture',
    '  to see the result. Describe and judge what is rendered, then continue.',
    '- Prefer execute_luau / get_console_output for non-visual checks; a capture is',
    '  comparatively expensive, so use it for what only shows up on screen.',
```

IMPORTANT: READ the current contents of `src/agent/systemPrompt.ts` first. The exact surrounding lines (the end of the input-sim block and the `'Assets:'` line) may differ slightly. Locate the real anchor lines and insert the block between the end of the input-sim block and the Assets block, matching the file's array-of-strings formatting and indentation exactly. The three required substrings the test checks are `screen_capture`, `Visual verification`, and `only visible on screen` — ensure all three appear verbatim in the inserted block.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: PASS — all three new substrings are present.

- [ ] **Step 5: Commit**

```bash
git add src/agent/systemPrompt.ts tests/systemPrompt.test.ts
git commit -m "feat: visual-verify guidance in system prompt"
```

---

## Task 3: Gated live test

**Files:**
- Create: `tests/e2e/live-capture.test.ts`

- [ ] **Step 1: Write the test**

Create `tests/e2e/live-capture.test.ts`. It self-skips unless `BLOX_LIVE_CAPTURE=1`. It uses `defaultClientFactory` for a single persistent client across the start → capture → stop sequence. The flow mirrors the SP2-a live test: start play (attach-retry), wait for `IsRunning`, call `screen_capture` with no arguments, assert the call succeeds and its content carries an image block, then stop play.

```typescript
import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory, type DoctorClient } from '../../src/doctor.js';

// Requires: a live Studio attached with a place open.
const enabled = process.env.BLOX_LIVE_CAPTURE === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function textOf(res: { content?: { type?: string; text?: string }[] }): string {
  return (res?.content ?? []).map((c) => c?.text ?? '').join('').trim();
}

function hasImage(res: { content?: { type?: string; data?: string }[] }): boolean {
  return (res?.content ?? []).some((c) => c?.type === 'image' && !!c?.data);
}

describe.skipIf(!enabled)('visual verification (live)', () => {
  it('captures the running game viewport as an image', async () => {
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
      const capture = find('screen_capture');
      expect(names.some((n) => n.endsWith('screen_capture'))).toBe(true);

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

      // capture the viewport; assert the call succeeds and returns an image
      const capRes = await client.callTool({ name: capture, arguments: {} });
      expect(capRes.isError === true).toBe(false);
      expect(hasImage(capRes)).toBe(true);
    } finally {
      if (started && play) await client?.callTool({ name: play, arguments: { is_start: false } }).catch(() => {});
      await client?.close().catch(() => {});
    }
  }, 90_000);
});
```

IMPORTANT before writing: READ the sibling test `tests/e2e/live-input.test.ts` to confirm the exact import paths and signatures of `studioLauncher`, `defaultClientFactory`, and `type DoctorClient`, and the `client.listTools()` / `client.callTool(...)` / `client.close()` shapes. The code above assumes those exact APIs (they are the same ones live-input.test.ts uses). If an import path or name differs, adapt the new test to match the real, existing exports — do NOT change source files. If the actual API differs in a way you cannot reconcile, report BLOCKED with specifics.

- [ ] **Step 2: Verify it skips without the flag**

Run: `npx vitest run tests/e2e/live-capture.test.ts`
Expected: the suite is skipped (1 skipped) because `BLOX_LIVE_CAPTURE` is unset. Also confirm `npx tsc -p tsconfig.json --noEmit` is clean (this verifies `type DoctorClient` imports correctly — it is exported from `src/doctor.ts`).

- [ ] **Step 3: Run it live (manual gate)** — SKIP if no live Studio is available. Step 2's skip is the gating check.

Prerequisite: Windows Studio running, a place open, "Studio as MCP server" enabled.
Run: `BLOX_LIVE_CAPTURE=1 npx vitest run tests/e2e/live-capture.test.ts`
Expected: PASS — starts play, captures the viewport, the result carries an image content block, play stops. If the live server rejects the no-arg call, inspect the tool's `inputSchema` from `listTools` and pass the required argument(s); this is the only live adaptation anticipated (spec §4.4).

- [ ] **Step 4: Commit**

```bash
git add tests/e2e/live-capture.test.ts
git commit -m "test: gated live test for visual verification (BLOX_LIVE_CAPTURE=1)"
```

---

## Task 4: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: all unit tests pass; the gated live tests (`live-studio`, `live-sync`, `live-serve`, `live-play`, `live-input`, `live-capture`) are skipped. The skip count went up by 1 (live-capture) vs the SP2-a baseline; the pass count went up by the bridge presence tests + the `captureResult` test added in Task 1.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: no type errors; `dist/cli.js` is produced.

- [ ] **Step 3: Final commit if anything was adjusted**

Only if Steps 1–2 forced a fix:

```bash
git add -A
git commit -m "chore: SP2-b visual-verify verification fixes"
```

---

## Self-Review Notes

**Spec coverage:**
- §4.1 real bridge (add `screen_capture`, 15→16) → Task 1.
- §4.2 mock fake (returns an image content block via `captureResult`) + `allowedTools` parity → Task 1.
- §4.3 system prompt (play-required, visual-only, returns a viewable frame, prefer Luau for non-visual) → Task 2.
- §4.4 unknown arg schema (real = name only; mock = empty `{}` schema; live = no-args then adapt) → Task 1 (mock `{}`), Task 3 (live no-args + adapt note).
- §6.1 unit (real `TOOLS` presence, parity, mock presence, mock returns image, prompt phrases) → Tasks 1–2.
- §6.2 gated live test (`BLOX_LIVE_CAPTURE=1`: start → capture → image block → stop) → Task 3.
- §6.3 full suite/tsc/build → Task 4.
- §7 out-of-scope: nothing implemented (no persistence, no store_image, no visual-diff, no session tools) — correct.
- §8 success criteria 1–4 → Tasks 1,2,4; criterion 5 → Task 3 Step 3 (manual gate).

**Placeholder scan:** none — every code step shows full code; the only manual step (Task 3 Step 3) is an explicit live gate, not a placeholder.

**Type consistency:** `captureResult()` is defined in Task 1 (`src/bridge/mockBridge.ts`, returns `{ type: 'image'; data: string; mimeType: string }`), used by the mock `screen_capture` fake in the same task, and asserted in the Task 1 bridge test (`block.type`/`block.mimeType`/`block.data`). The tool name `screen_capture` is exactly the string added to `TOOLS` (Task 1), mock `allowedTools` (Task 1), the prompt block + test substring (Task 2), and the live test presence assertion (Task 3). The live test uses `defaultClientFactory`/`studioLauncher`/`type DoctorClient` with their existing signatures (`DoctorClient.callTool({name, arguments})`, `.listTools()`, `.close()`), matching `tests/e2e/live-input.test.ts`. The env flag `BLOX_LIVE_CAPTURE` is consistent across Task 3 and Task 4.
