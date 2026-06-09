# blox SP3 — asset pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair blox's two dead asset chains by exposing `wait_job_finished` + `search_creator_store`, and rewrite the thin asset hint into an agentic generate→verify workflow block.

**Architecture:** Thin pass-through, consistent with SP2-a/b — no new blox module, no blox state. Two tools added to both bridges (real `TOOLS` list + mock fakes), one mock schema realigned, the system-prompt asset block rewritten, and one gated live test. The real==mock parity test (`tests/bridge.test.ts`) auto-enforces the tool set.

**Tech Stack:** TypeScript/ESM, Node ≥20, vitest, `@anthropic-ai/claude-agent-sdk` (`tool`/`createSdkMcpServer`), zod, `@modelcontextprotocol/sdk` (live test client).

**Spec:** `docs/superpowers/specs/2026-06-08-blox-sp3-asset-pipeline-design.md`

---

## File Structure

- Modify `src/bridge/mcpBridge.ts` — add `wait_job_finished` + `search_creator_store` to the `TOOLS` array (16→18). Names only; `allowedTools()` maps them.
- Modify `src/bridge/mockBridge.ts` — add two exported mock-fake helpers (`creatorSearchResult`, `jobFinishedResult`), two `tool(...)` defs using them, two names in `allowedTools()`; and realign the `insert_from_creator_store` mock input schema to the real shape.
- Modify `tests/bridge.test.ts` — exposure assertions for the two new tools (real + mock) and unit tests for the two helpers; the existing parity test (`mirrors the real bridge tool set`) covers set equality.
- Modify `src/agent/systemPrompt.ts` — replace the 2-line `Assets:` block with the "Assets (generate & verify)" block.
- Modify `tests/systemPrompt.test.ts` — add the new required substrings.
- Create `tests/e2e/live-asset.test.ts` — gated (`BLOX_LIVE_ASSET=1`) end-to-end proof of both repaired chains.

**Ordering note:** the real==mock parity test compares both bridges. Task 1 adds the two tools to **both** bridges in the same task, so parity stays green within the task. The `generate_*` mock schemas keep their pre-existing `{prompt}` shape (out of scope, per spec §6); only `insert_from_creator_store` is realigned (Task 2).

---

## Task 1: Expose `wait_job_finished` + `search_creator_store` in both bridges

**Files:**
- Modify: `src/bridge/mcpBridge.ts`, `src/bridge/mockBridge.ts`
- Test: `tests/bridge.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/bridge.test.ts`, update the mockBridge import (currently `import { createMockStudioBridge, sequenceResponder, playResult, captureResult } from '../src/bridge/mockBridge.js';`) to add the two new helpers:

```typescript
import {
  createMockStudioBridge, sequenceResponder, playResult, captureResult,
  creatorSearchResult, jobFinishedResult,
} from '../src/bridge/mockBridge.js';
```

In the `describe('real studio bridge', ...)` block, after the `exposes the screen_capture tool` test, add:

```typescript
  it('exposes the asset-pipeline tools (wait_job_finished, search_creator_store)', () => {
    const b = createStudioMcpBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__wait_job_finished');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__search_creator_store');
  });
```

In the `describe('mock studio bridge', ...)` block, after the `exposes the screen_capture tool in the mock too` test, add:

```typescript
  it('exposes the asset-pipeline tools in the mock too', () => {
    const b = createMockStudioBridge();
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__wait_job_finished');
    expect(b.allowedTools()).toContain('mcp__Roblox_Studio__search_creator_store');
  });

  it('creatorSearchResult returns a searchId + objectTypes shape', () => {
    const t = creatorSearchResult('tree');
    expect(t).toContain('searchId');
    expect(t).toContain('objectTypes');
  });

  it('jobFinishedResult references the generation id and reports finished', () => {
    expect(jobFinishedResult('g-123')).toContain('g-123');
    expect(jobFinishedResult('g-123')).toMatch(/finished/i);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/bridge.test.ts`
Expected: FAIL — `creatorSearchResult`/`jobFinishedResult` are not exported (import error), and the two exposure assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `src/bridge/mcpBridge.ts`, add the two names to the `TOOLS` array (after `'insert_from_creator_store',`). Also extend the comment block above `TOOLS` with one line. The array becomes:

```typescript
// SP1b tool surface: read/search the game + run Luau + generate prototype assets.
// SP1c-d additions: start_stop_play and get_console_output (tier-2 play-testing).
// SP2-a additions: character_navigation, user_keyboard_input, user_mouse_input (input simulation).
// SP2-b addition: screen_capture (visual verification — image returned to the model as vision).
// SP3 additions: wait_job_finished (poll async generate_procedural_model jobs),
//   search_creator_store (feeds insert_from_creator_store).
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
  'wait_job_finished',
  'search_creator_store',
];
```

In `src/bridge/mockBridge.ts`, add the two exported helpers after `captureResult` (i.e. after the block ending at the `captureResult` function, before `createMockStudioBridge`):

```typescript
// Deterministic search_creator_store result: mirrors the real {searchId, objectTypes}
// JSON text shape so the mocked search->insert chain is honest.
export function creatorSearchResult(query: string): string {
  return JSON.stringify({ searchId: `mock-search-${query}`, objectTypes: ['mock-asset'] });
}

// Deterministic wait_job_finished result for the mock bridge.
export function jobFinishedResult(generationId: string): string {
  return `[mock] Generation ${generationId} finished.`;
}
```

Then, in the mock `tools: [...]` array, add two `tool(...)` defs immediately after the `insert_from_creator_store` def (the last entry, currently ending with `})),`):

```typescript
      tool('wait_job_finished', 'Wait for a (fake) generation job to finish',
        { generationId: z.string(), timeout: z.number().optional() },
        async ({ generationId }) => ({ content: [{ type: 'text' as const, text: jobFinishedResult(generationId) }] })),
      tool('search_creator_store', 'Return (fake) creator-store search results', { query: z.string() },
        async ({ query }) => ({ content: [{ type: 'text' as const, text: creatorSearchResult(query) }] })),
```

And add the two names to the mock `allowedTools()` list (after `'generate_mesh', 'generate_material', 'generate_procedural_model', 'insert_from_creator_store',`):

```typescript
        'generate_mesh', 'generate_material', 'generate_procedural_model', 'insert_from_creator_store',
        'wait_job_finished', 'search_creator_store',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/bridge.test.ts`
Expected: PASS — the two exposure tests, the two helper tests, and the existing `mirrors the real bridge tool set` parity test all pass.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/mcpBridge.ts src/bridge/mockBridge.ts tests/bridge.test.ts
git commit -m "feat: expose wait_job_finished + search_creator_store (repair asset chains)"
```

---

## Task 2: Realign the `insert_from_creator_store` mock schema

**Files:**
- Modify: `src/bridge/mockBridge.ts`

This is a schema-fidelity fix: the mock currently takes `{ assetId }`, but the probed real schema is `{ searchId, objectTypes?, assetName? }`. The mock tool handlers are not invoked by the unit suite (only the exported helpers and `allowedTools()` are), so this is a mechanical edit verified by the suite staying green + a clean `tsc`.

- [ ] **Step 1: Edit the mock def**

In `src/bridge/mockBridge.ts`, replace the `insert_from_creator_store` mock def. Find:

```typescript
      tool('insert_from_creator_store', 'Insert a (fake) creator-store asset', { assetId: z.string() },
        async ({ assetId }) => ({ content: [{ type: 'text' as const, text: `[mock] inserted ${assetId}` }] })),
```

Replace with:

```typescript
      tool('insert_from_creator_store', 'Insert a (fake) creator-store asset',
        { searchId: z.string(), objectTypes: z.array(z.string()).optional(), assetName: z.string().optional() },
        async ({ searchId }) => ({ content: [{ type: 'text' as const, text: `[mock] inserted from search ${searchId}` }] })),
```

- [ ] **Step 2: Verify the suite + typecheck stay green**

Run: `npx vitest run tests/bridge.test.ts && npx tsc -p tsconfig.json --noEmit`
Expected: PASS — bridge tests still green (names unchanged → parity holds), and `tsc` is clean (the new zod schema typechecks).

- [ ] **Step 3: Commit**

```bash
git add src/bridge/mockBridge.ts
git commit -m "fix: realign insert_from_creator_store mock schema to {searchId}"
```

---

## Task 3: Rewrite the system-prompt asset block

**Files:**
- Modify: `src/agent/systemPrompt.ts`
- Test: `tests/systemPrompt.test.ts`

- [ ] **Step 1: Write the failing test**

In `tests/systemPrompt.test.ts`, the test currently asserts `expect(p).toContain('generate_mesh');` (around line 53) and `expect(p).toContain('screen_capture');` (around line 62). Keep both. Add these assertions immediately after the `generate_mesh` line (inside the same `it(...)`):

```typescript
    expect(p).toContain('Assets (generate & verify)');
    expect(p).toContain('search_creator_store');
    expect(p).toContain('insert_from_creator_store');
    expect(p).toContain('wait_job_finished');
    expect(p).toContain('Generation ID');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: FAIL — the prompt does not yet contain `Assets (generate & verify)`, `search_creator_store`, `wait_job_finished`, or `Generation ID`.

- [ ] **Step 3: Write minimal implementation**

In `src/agent/systemPrompt.ts`, replace the current two `Assets:` lines:

```typescript
    'Assets: when the task needs prototype assets, use generate_mesh,',
    '  generate_material, generate_procedural_model, or insert_from_creator_store.',
```

with this block (keep the surrounding blank-line entries and the 4-space array indentation):

```typescript
    'Assets (generate & verify):',
    '- Library first: for common props, search_creator_store(query) returns a',
    '  searchId + objectTypes; insert with insert_from_creator_store(searchId).',
    '  Instant and free — prefer a stock asset over generating when one fits.',
    '- Generate when needed. generate_mesh and generate_material BLOCK until done',
    '  (tens of seconds) and return the inserted asset. generate_procedural_model',
    '  is ASYNC: it returns a "Generation ID"; call wait_job_finished(generationId)',
    '  to finish the job and land the model.',
    '- Verify visually: after an asset lands, start play and screen_capture to see',
    '  it; judge it against the request; if it is wrong, refine the prompt and',
    '  regenerate. Use execute_luau to confirm the instance exists and is parented.',
    '- Style & batch: keep one consistent style phrase across a coordinated set;',
    '  build GUIs by scripting them in .luau, not by generating images.',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/systemPrompt.test.ts`
Expected: PASS — all the new substrings plus the retained `generate_mesh` / `screen_capture` assertions pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/systemPrompt.ts tests/systemPrompt.test.ts
git commit -m "feat: rewrite asset prompt block — library-first + async-aware + visual loop"
```

---

## Task 4: Gated live test — prove both repaired chains

**Files:**
- Create: `tests/e2e/live-asset.test.ts`

This mirrors `tests/e2e/live-capture.test.ts` / `live-input.test.ts`: a real MCP client, attach-retry warm-up, then exercise the two chains. The asset tools run in edit mode (no play needed). It self-skips unless `BLOX_LIVE_ASSET=1`.

- [ ] **Step 1: Write the test file**

Create `tests/e2e/live-asset.test.ts` with exactly:

```typescript
import { describe, it, expect } from 'vitest';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { defaultClientFactory, type DoctorClient } from '../../src/doctor.js';

// Requires: a live Studio attached with a place open.
const enabled = process.env.BLOX_LIVE_ASSET === '1';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_STUDIO = /no active studio|unable to find an active studio|no studio available/i;

function textOf(res: { content?: { type?: string; text?: string }[] }): string {
  return (res?.content ?? []).map((c) => c?.text ?? '').join('').trim();
}

describe.skipIf(!enabled)('asset pipeline (live)', () => {
  it('repairs the search->insert and procedural->wait chains', async () => {
    let client: DoctorClient | undefined;
    try {
      client = await defaultClientFactory(studioLauncher());
      const listed = await client.listTools();
      const names = listed.tools.map((t) => t.name);
      const find = (s: string) => names.find((n) => n.endsWith(s)) ?? s;
      const luau = find('execute_luau');
      const search = find('search_creator_store');
      const insert = find('insert_from_creator_store');
      const genModel = find('generate_procedural_model');
      const wait = find('wait_job_finished');
      for (const s of ['search_creator_store', 'wait_job_finished']) {
        expect(names.some((n) => n.endsWith(s))).toBe(true);
      }

      // Warm up past the proxy->Studio attach race.
      let attached = false;
      for (let i = 0; i < 15 && !attached; i++) {
        const t = textOf(await client.callTool({ name: luau, arguments: { code: 'return 1+1' } }));
        attached = !NO_STUDIO.test(t) && t.includes('2');
        if (!attached) await sleep(700);
      }
      expect(attached).toBe(true);

      // Chain 1: search_creator_store -> insert_from_creator_store.
      const searchRes = await client.callTool({ name: search, arguments: { query: 'tree' } });
      expect(searchRes.isError === true).toBe(false);
      const parsed = JSON.parse(textOf(searchRes)) as { searchId?: string; objectTypes?: string[] };
      expect(typeof parsed.searchId).toBe('string');
      const insertRes = await client.callTool({ name: insert, arguments: { searchId: parsed.searchId } });
      expect(insertRes.isError === true).toBe(false);

      // Chain 2: generate_procedural_model -> wait_job_finished.
      const genRes = await client.callTool({ name: genModel, arguments: { prompt: 'a small gray rock' } });
      expect(genRes.isError === true).toBe(false);
      const genId = textOf(genRes).match(/Generation ID:\s*([0-9a-fA-F-]+)/)?.[1];
      expect(typeof genId).toBe('string');
      const waitRes = await client.callTool(
        { name: wait, arguments: { generationId: genId, timeout: 180 } },
        undefined,
        { timeout: 240_000 },
      );
      // Record the real done-result shape (un-probed at design time).
      console.log('[live-asset] wait_job_finished result:', JSON.stringify(waitRes));
      expect(waitRes.isError === true).toBe(false);
    } finally {
      await client?.close().catch(() => {});
    }
  }, 300_000);
});
```

- [ ] **Step 2: Verify it skips without the env flag**

Run: `npx vitest run tests/e2e/live-asset.test.ts`
Expected: the suite reports the test as skipped (no `BLOX_LIVE_ASSET=1`), 0 failures.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/live-asset.test.ts
git commit -m "test: gated live asset-pipeline e2e (BLOX_LIVE_ASSET=1)"
```

NOTE: the live path is exercised manually against an attached Studio with `BLOX_LIVE_ASSET=1 npx vitest run tests/e2e/live-asset.test.ts`. The `console.log` records `wait_job_finished`'s real result shape so the mock (`jobFinishedResult`) can be tightened to a substring match if it differs materially. Do NOT run the live path as part of the gated suite.

---

## Task 5: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole unit suite**

Run: `npm test`
Expected: all unit tests pass; gated live tests (`live-studio`, `live-sync`, `live-serve`, `live-play`, `live-input`, `live-capture`, `live-asset`) skip. Pass count rose by Task 1's bridge tests (2 exposure + 2 helper) and Task 3's systemPrompt assertions.

- [ ] **Step 2: Typecheck + build**

Run: `npx tsc -p tsconfig.json --noEmit && npm run build`
Expected: no type errors; `dist/cli.js` is produced.

- [ ] **Step 3: Final commit if anything was adjusted**

Only if Steps 1–2 forced a fix:

```bash
git add -A
git commit -m "chore: SP3 asset-pipeline verification fixes"
```

---

## Self-Review Notes

**Spec coverage:**
- §3 architecture (thin pass-through, no new module, both bridges + prompt + live test) → Tasks 1–4.
- §2 / §3.1 expose `wait_job_finished` + `search_creator_store` (repair the two dead chains) → Task 1.
- §4 mock fakes mirror probed shapes (`creatorSearchResult` → `{searchId, objectTypes}`; `jobFinishedResult`) → Task 1; realign `insert_from_creator_store` mock to `{searchId, objectTypes?, assetName?}` → Task 2.
- §5 system-prompt block: library-first, async-aware (block vs `Generation ID` + `wait_job_finished`), visual loop (`screen_capture`/`execute_luau`), style & batch; required substrings `search_creator_store`/`wait_job_finished`/`Generation ID`/`screen_capture` (and retained `generate_mesh`) → Task 3.
- §7 tests: parity + exposure + helper unit tests (Task 1), prompt substrings (Task 3), gated live both-chains (Task 4), full-suite/tsc/build (Task 5).
- §6 out of scope: no `store_image`, no cache/manifest, no quality tier, no `generate_material` realign, no `generate_*` mock realign — none implemented. Correct.
- §8 success criteria 1–5 → Tasks 1–5.

**Placeholder scan:** none — every code step shows full code; Tasks 2 and 5 verification steps name exact commands and expected output.

**Type consistency:** `creatorSearchResult(query: string): string` and `jobFinishedResult(generationId: string): string` are defined in Task 1 and imported/used unchanged in Task 1's tests and the mock tool defs. The two tool names (`wait_job_finished`, `search_creator_store`) are spelled identically across `mcpBridge.ts`, `mockBridge.ts`, `bridge.test.ts`, the prompt block, and the live test. The live test reuses the established `DoctorClient` / `defaultClientFactory` / `studioLauncher` seam and the `textOf` + attach-retry pattern from `live-capture.test.ts`.
```
