# P2 Asset Result Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After an approved asset generation lands in Studio, pause the run on a dock card showing the generated asset in 3D; the user approves (run resumes) or rejects with optional feedback (plugin stashes the instance, agent hears why).

**Architecture:** PostToolUse hook on `generate_mesh` + `wait_job_finished` parses the inserted instance's name tag from the tool result, emits a `result_gate_request` panel event, and parks on the P1 GateBroker until the dock POSTs approve/reject (or the gate times out → approve). Reject returns a hook `decision:'block'` whose reason carries the stash notice + user feedback. The Luau plugin renders a ViewportFrame thumbnail, frames the main camera on click, and moves rejected instances to `ReplicatedStorage._bloxRejected` before posting the decision.

**Tech Stack:** TypeScript/ESM, vitest, `@anthropic-ai/claude-agent-sdk` hooks, node:http (P1 panel server), Luau plugin (rojo-built).

**Spec:** `docs/superpowers/specs/2026-06-12-blox-pivot-p2-asset-gate-design.md`

**Branch:** execute in an isolated worktree (superpowers:using-git-worktrees), branch `p2-asset-gate`.

---

### Task 1: Live probe — `wait_job_finished` done-result shape (front-loaded)

The only unknown in the spec. Requires a Windows Studio attached. **If Studio is unavailable, record that and proceed** — the Task 5 parser is defensive by design and this task is re-run before the final live smoke.

**Files:**
- None committed (observation only; findings recorded in this plan file under this task and used to tighten `jobFinishedResult` in Task 9).

- [ ] **Step 1: Run the existing SP3 gated live test, which logs the real shape**

Run: `BLOX_LIVE_ASSET=1 npx vitest run tests/e2e/live-asset.test.ts 2>&1 | tee /tmp/p2-probe.log`
Expected: PASS; the test console.logs the `wait_job_finished` result JSON.

- [x] **Step 2: Record findings**

**PROBED 2026-06-12 (live Studio, test passed twice).** `wait_job_finished` done-result is one MCP text block whose body is JSON:

```json
{"modelFullName":"Workspace.SmallGrayRock","resultName":"SmallGrayRock","status":"Completed","prompt":"a small gray rock","generationId":"49a17172-aa30-4234-8e3d-f09b99831fca"}
```

**Design impact (Tasks 5 and 9 amended in place):**
- Procedural models do NOT follow the `Assistant-<Kind>-<uuid>` tag convention — the instance is named from the prompt (`resultName`, parented per `modelFullName`). A tag-regex-only parser would always miss chain 2.
- Extraction parses JSON text blocks first: `tag` key → mesh; `status === "Completed"` + `resultName` → procedural. The `Assistant-*` regex stays as a defensive fallback only.
- A `wait_job_finished` response with `status !== "Completed"` landed nothing — the hook skips the gate entirely (the agent sees the failure in the tool result; a retry re-enters the P1 pre-gate).

Commit the plan edit:

```bash
git add docs/superpowers/plans/2026-06-12-blox-pivot-p2-asset-gate.md
git commit -m "docs(p2): record live wait_job_finished result shape"
```

---

### Task 2: Protocol v2 event types

**Files:**
- Modify: `src/panel/events.ts`
- Test: `tests/panel.translate.test.ts` (compile-only impact; no behavior change — type additions verified by Task 3 tests)

- [ ] **Step 1: Add the result-gate events and bump the protocol**

In `src/panel/events.ts`, change `PROTOCOL_VERSION` and add the two event variants plus the decision type:

```ts
// Wire protocol between the CLI's panel server and the Studio dock plugin.
// Bump PROTOCOL_VERSION on any breaking change; the plugin shows an update
// hint on mismatch and the CLI runs unaffected (spec §4).
export const PROTOCOL_VERSION = 2;

export type GateDecisionValue = 'allow' | 'deny';
export type ResultDecisionValue = 'approve' | 'reject';
export type GateSource = 'dock' | 'timeout';

export type PanelEvent =
  | { type: 'run_started'; runId: string; prompt: string; mode: 'auto' | 'ask'; maxTurns: number; maxBudgetUsd: number }
  | { type: 'status'; turns: number }
  | { type: 'log'; text: string }
  | { type: 'file_diff'; path: string; added: number; removed: number }
  | { type: 'gate_request'; gateId: string; tool: string; inputSummary: string }
  | { type: 'gate_resolved'; gateId: string; decision: GateDecisionValue; source: GateSource }
  | { type: 'result_gate_request'; gateId: string; tool: string; tag: string | null; inputSummary: string }
  | { type: 'result_gate_resolved'; gateId: string; decision: ResultDecisionValue; source: GateSource; feedback?: string }
  | { type: 'run_finished'; status: 'success' | 'error'; stopReason: string; turns: number; costUsd: number };

export interface EventSink {
  emit(event: PanelEvent): void;
}
```

- [ ] **Step 2: Verify the suite still compiles and passes**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass (no behavior changed yet).

- [ ] **Step 3: Commit**

```bash
git add src/panel/events.ts
git commit -m "feat(panel): protocol v2 result-gate event types"
```

---

### Task 3: GateBroker result gates

**Files:**
- Modify: `src/panel/gates.ts`
- Modify: `tests/panel.gates.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/panel.gates.test.ts` (inside the file, after the existing `describe`):

```ts
describe('GateBroker — result gates', () => {
  it('emits result_gate_request and resolves approve with feedback ignored', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const p = broker.requestResult('mcp__Roblox_Studio__generate_mesh', 'Assistant-MeshGen-abc', '{"textPrompt":"barrel"}');
    const req = events.find((e) => e.type === 'result_gate_request');
    if (req?.type !== 'result_gate_request') throw new Error('unreachable');
    expect(req.tool).toBe('mcp__Roblox_Studio__generate_mesh');
    expect(req.tag).toBe('Assistant-MeshGen-abc');
    expect(broker.resolve(req.gateId, 'approve')).toBe(true);
    expect(await p).toEqual({ decision: 'approve', source: 'dock' });
    expect(events.some((e) => e.type === 'result_gate_resolved' && e.decision === 'approve')).toBe(true);
  });

  it('resolves reject with feedback and records the decision', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const p = broker.requestResult('mcp__Roblox_Studio__generate_mesh', 'Assistant-MeshGen-abc', '{}');
    const req = events.find((e) => e.type === 'result_gate_request');
    if (req?.type !== 'result_gate_request') throw new Error('unreachable');
    broker.resolve(req.gateId, 'reject', 'too tall, more barrel-shaped');
    expect(await p).toEqual({ decision: 'reject', source: 'dock', feedback: 'too tall, more barrel-shaped' });
    expect(broker.resultDecisions()).toEqual([
      { tool: 'mcp__Roblox_Studio__generate_mesh', decision: 'reject', source: 'dock', feedback: 'too tall, more barrel-shaped' },
    ]);
  });

  it('times out to APPROVE with source timeout (asymmetric vs tool gates)', async () => {
    vi.useFakeTimers();
    try {
      const { sink, events } = collector();
      const broker = new GateBroker(sink, 1000);
      const p = broker.requestResult('mcp__Roblox_Studio__generate_mesh', null, '{}');
      vi.advanceTimersByTime(1001);
      expect(await p).toEqual({ decision: 'approve', source: 'timeout' });
      expect(events.some((e) => e.type === 'result_gate_resolved' && e.source === 'timeout')).toBe(true);
      expect(broker.resultDecisions()).toEqual([
        { tool: 'mcp__Roblox_Studio__generate_mesh', decision: 'approve', source: 'timeout' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects decisions that do not match the gate kind', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const tp = broker.request('mcp__Roblox_Studio__generate_mesh', {});
    const rp = broker.requestResult('mcp__Roblox_Studio__generate_mesh', null, '{}');
    const treq = events.find((e) => e.type === 'gate_request');
    const rreq = events.find((e) => e.type === 'result_gate_request');
    if (treq?.type !== 'gate_request' || rreq?.type !== 'result_gate_request') throw new Error('unreachable');
    expect(broker.resolve(treq.gateId, 'approve')).toBe(false); // tool gate: allow|deny only
    expect(broker.resolve(rreq.gateId, 'allow')).toBe(false); // result gate: approve|reject only
    expect(broker.kindOf(treq.gateId)).toBe('tool');
    expect(broker.kindOf(rreq.gateId)).toBe('result');
    expect(broker.kindOf('nope')).toBeUndefined();
    broker.resolve(treq.gateId, 'allow');
    broker.resolve(rreq.gateId, 'approve');
    await Promise.all([tp, rp]);
    expect(broker.kindOf(treq.gateId)).toBeUndefined(); // resolved gates forgotten
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/panel.gates.test.ts`
Expected: FAIL — `requestResult is not a function`.

- [ ] **Step 3: Implement**

Replace `src/panel/gates.ts` with:

```ts
import { randomUUID } from 'node:crypto';
import type { EventSink, GateDecisionValue, ResultDecisionValue, GateSource } from './events.js';

export interface GateDecision {
  decision: GateDecisionValue;
  source: GateSource;
}

export interface ResultDecision {
  decision: ResultDecisionValue;
  source: GateSource;
  feedback?: string;
}

export interface ResultRecord extends ResultDecision {
  tool: string;
}

export type GateKind = 'tool' | 'result';

const VALID: Record<GateKind, readonly string[]> = {
  tool: ['allow', 'deny'],
  result: ['approve', 'reject'],
};

interface Pending {
  kind: GateKind;
  finish: (decision: string, source: GateSource, feedback?: string) => void;
}

// Pending-gate registry. request()/requestResult() publish a *_gate_request
// event and park the caller on a promise; the dock resolves it via the
// server's POST /gate/{id}, or the timeout fires the kind's default.
// Tool gates time out to DENY (default-safe: don't run the tool); result
// gates time out to APPROVE (default-safe: don't mutate the DataModel
// unattended — the asset already exists). Spec §3.
export class GateBroker {
  private pending = new Map<string, Pending>();
  private denied: string[] = []; // tools the USER denied (timeouts excluded)
  private results: ResultRecord[] = [];

  constructor(
    private sink: EventSink,
    private timeoutMs: number,
  ) {}

  request(tool: string, input: Record<string, unknown>): Promise<GateDecision> {
    const gateId = randomUUID();
    this.sink.emit({
      type: 'gate_request',
      gateId,
      tool,
      inputSummary: JSON.stringify(input).slice(0, 200),
    });
    return new Promise((resolve) => {
      this.park(gateId, 'tool', 'deny', (decision, source) => {
        if (decision === 'deny' && source === 'dock') this.denied.push(tool);
        try {
          this.sink.emit({ type: 'gate_resolved', gateId, decision: decision as GateDecisionValue, source });
        } finally {
          resolve({ decision: decision as GateDecisionValue, source });
        }
      });
    });
  }

  requestResult(tool: string, tag: string | null, inputSummary: string): Promise<ResultDecision> {
    const gateId = randomUUID();
    this.sink.emit({ type: 'result_gate_request', gateId, tool, tag, inputSummary });
    return new Promise((resolve) => {
      this.park(gateId, 'result', 'approve', (decision, source, feedback) => {
        const d: ResultDecision = {
          decision: decision as ResultDecisionValue,
          source,
          ...(feedback ? { feedback } : {}),
        };
        this.results.push({ tool, ...d });
        try {
          this.sink.emit({ type: 'result_gate_resolved', gateId, ...d });
        } finally {
          resolve(d); // a throwing sink must never leave the agent parked
        }
      });
    });
  }

  private park(
    gateId: string,
    kind: GateKind,
    timeoutDecision: string,
    onFinish: (decision: string, source: GateSource, feedback?: string) => void,
  ): void {
    const finish: Pending['finish'] = (decision, source, feedback) => {
      if (!this.pending.has(gateId)) return; // idempotent: first resolution wins
      this.pending.delete(gateId);
      clearTimeout(timer);
      onFinish(decision, source, feedback);
    };
    const timer = setTimeout(() => finish(timeoutDecision, 'timeout'), this.timeoutMs);
    this.pending.set(gateId, { kind, finish });
  }

  kindOf(gateId: string): GateKind | undefined {
    return this.pending.get(gateId)?.kind;
  }

  resolve(gateId: string, decision: string, feedback?: string): boolean {
    const p = this.pending.get(gateId);
    if (!p || !VALID[p.kind].includes(decision)) return false;
    p.finish(decision, 'dock', feedback);
    return true;
  }

  // Tools denied interactively — the report lists these as user decisions, not
  // as "blocked, re-run with --auto" (spec §5).
  dockDeniedTools(): string[] {
    return [...this.denied];
  }

  // Result-gate outcomes for the report's assets section (P2 spec §4).
  resultDecisions(): ResultRecord[] {
    return [...this.results];
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/panel.gates.test.ts && npx tsc --noEmit`
Expected: all pass (existing tool-gate tests too — `resolve` keeps its boolean contract).

- [ ] **Step 5: Commit**

```bash
git add src/panel/gates.ts tests/panel.gates.test.ts
git commit -m "feat(panel): GateBroker result gates with timeout-approve"
```

---

### Task 4: Server — result decisions + feedback over POST /gate

**Files:**
- Modify: `src/panel/server.ts:86-95` (the gate POST branch)
- Modify: `tests/panel.server.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/panel.server.test.ts`:

```ts
describe('PanelServer — result gates', () => {
  it('resolves a result gate with approve', async () => {
    const { s, base } = await start();
    const decision = s.gates.requestResult('mcp__Roblox_Studio__generate_mesh', 'Assistant-MeshGen-abc', '{}');
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    const req = events.find((e: { type: string }) => e.type === 'result_gate_request');
    const ok = await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(ok.status).toBe(200);
    expect(await decision).toEqual({ decision: 'approve', source: 'dock' });
  });

  it('passes reject feedback through, truncated at 2000 chars', async () => {
    const { s, base } = await start();
    const decision = s.gates.requestResult('mcp__Roblox_Studio__generate_mesh', null, '{}');
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    const req = events.find((e: { type: string }) => e.type === 'result_gate_request');
    await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'reject', feedback: 'x'.repeat(3000) }),
    });
    const d = await decision;
    expect(d.decision).toBe('reject');
    expect(d.feedback?.length).toBe(2000);
  });

  it('400s a kind-mismatched decision on a live gate', async () => {
    const { s, base } = await start();
    void s.gates.request('mcp__Roblox_Studio__generate_mesh', {});
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    const req = events.find((e: { type: string }) => e.type === 'gate_request');
    const res = await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(res.status).toBe(400);
    // gate still pending — the right decision still works
    const ok = await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(ok.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/panel.server.test.ts`
Expected: FAIL — `requestResult is not a function` is gone (Task 3 shipped), failures are 400/feedback assertions against the old POST branch.

- [ ] **Step 3: Implement the POST branch**

In `src/panel/server.ts`, replace the gate POST block (currently lines 86–95) with:

```ts
      const gateMatch = url.pathname.match(/^\/api\/v1\/gate\/([^/]+)$/);
      if (req.method === 'POST' && gateMatch) {
        const body = (await readJson(req)) as { decision?: unknown; feedback?: unknown } | null;
        const decision = body?.decision;
        if (decision !== 'allow' && decision !== 'deny' && decision !== 'approve' && decision !== 'reject') {
          return json(res, 400, { error: 'decision must be "allow", "deny", "approve" or "reject"' });
        }
        const kind = this.gates.kindOf(gateMatch[1]);
        if (!kind) return json(res, 404, { error: 'unknown gate id' });
        const feedback = typeof body?.feedback === 'string' ? body.feedback.slice(0, 2000) : undefined;
        const ok = this.gates.resolve(gateMatch[1], decision, feedback);
        return ok
          ? json(res, 200, { ok: true })
          : json(res, 400, { error: `decision "${decision}" does not match the gate kind "${kind}"` });
      }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/panel.server.test.ts && npx tsc --noEmit`
Expected: all pass, including the pre-existing 404/400 tests (unknown id + valid decision → 404; garbage decision → 400 regardless of id).

- [ ] **Step 5: Commit**

```bash
git add src/panel/server.ts tests/panel.server.test.ts
git commit -m "feat(panel): result decisions and feedback on POST /gate"
```

---

### Task 5: Asset result hook

**Files:**
- Modify: `src/agent/hooks.ts`
- Modify: `tests/hooks.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/hooks.test.ts`:

```ts
import { buildAssetResultHook, extractAssetTag, jobLandedNothing, rejectMessage, GEN_MESH_TOOL, WAIT_JOB_TOOL } from '../src/agent/hooks.js';
import type { ResultGateChannel } from '../src/agent/hooks.js';

type BlockOut = { decision?: string; reason?: string; continue?: boolean };

const meshResponse = { content: [{ type: 'text', text: '{"tag":"Assistant-MeshGen-1f2e3d4c-0000-4000-8000-aabbccddeeff"}' }] };

function postInput(tool: string, response: unknown): HookInput {
  return {
    hook_event_name: 'PostToolUse',
    tool_name: tool,
    tool_input: { textPrompt: 'a low-poly barrel' },
    tool_response: response,
    tool_use_id: 't9',
    session_id: 's',
    transcript_path: '',
    cwd: '/game',
  } as unknown as HookInput;
}

describe('extractAssetTag', () => {
  it('finds the mesh tag inside an MCP text block', () => {
    expect(extractAssetTag(meshResponse)).toBe('Assistant-MeshGen-1f2e3d4c-0000-4000-8000-aabbccddeeff');
  });

  it('finds the procedural model name from a Completed wait_job_finished result (live-probed shape)', () => {
    const waitResponse = {
      content: [
        {
          type: 'text',
          text: '{"modelFullName":"Workspace.SmallGrayRock","resultName":"SmallGrayRock","status":"Completed","prompt":"a small gray rock","generationId":"49a17172-aa30-4234-8e3d-f09b99831fca"}',
        },
      ],
      isError: false,
    };
    expect(extractAssetTag(waitResponse)).toBe('SmallGrayRock');
  });

  it('returns null for a non-Completed job (nothing landed)', () => {
    const failed = { content: [{ type: 'text', text: '{"status":"Failed","generationId":"x"}' }] };
    expect(extractAssetTag(failed)).toBeNull();
    expect(jobLandedNothing(failed)).toBe(true);
    expect(jobLandedNothing({ content: [{ type: 'text', text: '{"status":"Completed","resultName":"R"}' }] })).toBe(false);
    expect(jobLandedNothing({ weird: 'shape' })).toBe(false); // unknown shape: not provably failed
  });

  it('falls back to the Assistant-* tag regex for unexpected shapes', () => {
    expect(extractAssetTag({ result: 'inserted Assistant-ModelGen-deadbeef-1111-4222-8333-444455556666 ok' })).toBe(
      'Assistant-ModelGen-deadbeef-1111-4222-8333-444455556666',
    );
  });

  it('returns null when nothing matches', () => {
    expect(extractAssetTag({ content: [{ type: 'text', text: 'no tag here' }] })).toBeNull();
    expect(extractAssetTag(undefined)).toBeNull();
  });
});

describe('buildAssetResultHook', () => {
  const channel = (decision: 'approve' | 'reject', feedback?: string, calls?: unknown[][]): ResultGateChannel => ({
    isConnected: () => true,
    requestResult: async (...args: unknown[]) => {
      calls?.push(args);
      return { decision, source: 'dock' as const, ...(feedback ? { feedback } : {}) };
    },
  });

  it('continues on approve', async () => {
    const calls: unknown[][] = [];
    const hook = buildAssetResultHook(channel('approve', undefined, calls));
    const out = (await hook(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut;
    expect(out.continue).toBe(true);
    expect(out.decision).toBeUndefined();
    expect(calls[0][0]).toBe(GEN_MESH_TOOL);
    expect(calls[0][1]).toBe('Assistant-MeshGen-1f2e3d4c-0000-4000-8000-aabbccddeeff');
  });

  it('blocks on reject with stash notice and feedback in the reason', async () => {
    const hook = buildAssetResultHook(channel('reject', 'too tall'));
    const out = (await hook(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut;
    expect(out.decision).toBe('block');
    expect(out.reason).toContain('_bloxRejected');
    expect(out.reason).toContain('too tall');
    expect(out.reason).toBe(rejectMessage(GEN_MESH_TOOL, true, 'too tall'));
  });

  it('reject without a tag omits the stash notice (nothing was stashed)', async () => {
    const hook = buildAssetResultHook(channel('reject'));
    const out = (await hook(postInput(WAIT_JOB_TOOL, { weird: 'shape' }), 't9', { signal })) as BlockOut;
    expect(out.decision).toBe('block');
    expect(out.reason).not.toContain('_bloxRejected');
  });

  it('ignores other tools, missing channel, and disconnected dock', async () => {
    const calls: unknown[][] = [];
    const connected = channel('reject', undefined, calls);
    const hookOther = buildAssetResultHook(connected);
    const outOther = (await hookOther(postInput('mcp__Roblox_Studio__execute_luau', meshResponse), 't9', { signal })) as BlockOut;
    expect(outOther.continue).toBe(true);
    expect(calls.length).toBe(0);

    const hookNone = buildAssetResultHook(undefined);
    expect(((await hookNone(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut).continue).toBe(true);

    const hookDisc = buildAssetResultHook({ ...connected, isConnected: () => false });
    expect(((await hookDisc(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut).continue).toBe(true);
    expect(calls.length).toBe(0);
  });

  it('continues if the channel throws (a broken panel never stalls the run)', async () => {
    const hook = buildAssetResultHook({
      isConnected: () => true,
      requestResult: async () => {
        throw new Error('boom');
      },
    });
    const out = (await hook(postInput(GEN_MESH_TOOL, meshResponse), 't9', { signal })) as BlockOut;
    expect(out.continue).toBe(true);
  });

  it('skips the gate for a non-Completed job — nothing landed, nothing to review', async () => {
    const calls: unknown[][] = [];
    const hook = buildAssetResultHook(channel('reject', undefined, calls));
    const failed = { content: [{ type: 'text', text: '{"status":"Failed","generationId":"x"}' }] };
    const out = (await hook(postInput(WAIT_JOB_TOOL, failed), 't9', { signal })) as BlockOut;
    expect(out.continue).toBe(true);
    expect(calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/hooks.test.ts`
Expected: FAIL — `buildAssetResultHook` not exported.

- [ ] **Step 3: Implement**

Append to `src/agent/hooks.ts`:

```ts
export const GEN_MESH_TOOL = 'mcp__Roblox_Studio__generate_mesh';
export const WAIT_JOB_TOOL = 'mcp__Roblox_Studio__wait_job_finished';

// How the result hook reaches the panel's gate broker (mirrors GateChannel in
// permission.ts: connectivity check + an awaitable decision).
export interface ResultGateChannel {
  isConnected(): boolean;
  requestResult(
    tool: string,
    tag: string | null,
    inputSummary: string,
  ): Promise<{ decision: 'approve' | 'reject'; source: 'dock' | 'timeout'; feedback?: string }>;
}

const TAG_RE = /Assistant-[A-Za-z]+-[0-9a-fA-F][0-9a-fA-F-]{7,}/;

// JSON-decode every MCP text block in a tool response (non-JSON blocks skipped).
function textBlockJson(response: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const content = (response as { content?: unknown } | null)?.content;
  if (!Array.isArray(content)) return out;
  for (const b of content as { type?: unknown; text?: unknown }[]) {
    if (b?.type === 'text' && typeof b.text === 'string') {
      try {
        const j = JSON.parse(b.text) as unknown;
        if (j && typeof j === 'object') out.push(j as Record<string, unknown>);
      } catch {
        // not JSON — the regex fallback below handles it
      }
    }
  }
  return out;
}

// Both result shapes live-probed (Task 1, 2026-06-12):
//   generate_mesh      → {"tag":"Assistant-MeshGen-<uuid>"} — instance name.
//   wait_job_finished  → {"modelFullName":"Workspace.SmallGrayRock",
//                         "resultName":"SmallGrayRock","status":"Completed",...}
//     — the procedural instance is named from the PROMPT, not Assistant-tagged.
// Parse JSON first; the Assistant-* regex is a defensive fallback for shapes
// a future Studio build might introduce.
export function extractAssetTag(response: unknown): string | null {
  for (const j of textBlockJson(response)) {
    if (typeof j.tag === 'string') return j.tag;
    if (j.status === 'Completed' && typeof j.resultName === 'string') return j.resultName;
  }
  let s: string;
  try {
    s = JSON.stringify(response) ?? '';
  } catch {
    s = String(response);
  }
  return s.match(TAG_RE)?.[0] ?? null;
}

// True only when the response provably reports a non-Completed job: nothing
// landed in the DataModel, so there is no result to gate. Unknown shapes
// return false (gate defensively rather than silently skip).
export function jobLandedNothing(response: unknown): boolean {
  return textBlockJson(response).some((j) => typeof j.status === 'string' && j.status !== 'Completed');
}

export function rejectMessage(toolName: string, stashed: boolean, feedback?: string): string {
  return (
    `The user rejected the asset generated by "${toolName}"` +
    (stashed ? ' and it was moved to ReplicatedStorage._bloxRejected' : '') +
    '. ' +
    (feedback ? `User feedback: ${feedback}. ` : '') +
    'Adjust your approach based on this or continue without the asset. Do not re-insert the rejected asset.'
  );
}

// PostToolUse result gate (P2 spec §3-4): after an asset generation lands,
// park the run on the dock's approve/reject card. Approve (and timeout, and
// every degraded path) continues; reject blocks with the user's feedback so
// the agent can adjust. Never calls MCP (SP1c-d single-client rule) and never
// stalls the run on a broken channel.
export function buildAssetResultHook(gate?: ResultGateChannel): HookCallback {
  return async (input: HookInput): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PostToolUse') return { continue: true };
    if (input.tool_name !== GEN_MESH_TOOL && input.tool_name !== WAIT_JOB_TOOL) return { continue: true };
    if (!gate?.isConnected()) return { continue: true };
    if (input.tool_name === WAIT_JOB_TOOL && jobLandedNothing(input.tool_response)) return { continue: true };

    const tag = extractAssetTag(input.tool_response);
    const inputSummary = JSON.stringify(input.tool_input ?? {}).slice(0, 200);
    try {
      const d = await gate.requestResult(input.tool_name, tag, inputSummary);
      if (d.decision === 'reject') {
        return { decision: 'block', reason: rejectMessage(input.tool_name, tag !== null, d.feedback) };
      }
    } catch {
      // A broken channel must never stall the run — fall through to continue.
    }
    return { continue: true };
  };
}
```

Note: `HookInput` for PostToolUse carries `tool_response: unknown` (sdk.d.ts `PostToolUseHookInput`); the narrow via `input.hook_event_name !== 'PostToolUse'` makes `tool_response`/`tool_input` accessible. `SyncHookJSONOutput` supports `{decision: 'block', reason}`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/hooks.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/hooks.ts tests/hooks.test.ts
git commit -m "feat(agent): PostToolUse asset result gate hook"
```

---

### Task 6: buildOptions wiring

**Files:**
- Modify: `src/agent/buildOptions.ts`
- Modify: `tests/buildOptions.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/buildOptions.test.ts` (reuse the file's existing config/bridge/digest fixtures; the fixtures below assume the file exposes a helper to build them — follow the file's existing pattern for constructing `BloxConfig`, mock bridge, and digest):

```ts
import { GEN_MESH_TOOL, WAIT_JOB_TOOL } from '../src/agent/hooks.js';

const fullGate = {
  isConnected: () => true,
  request: async () => ({ decision: 'allow' as const, source: 'dock' as const }),
  requestResult: async () => ({ decision: 'approve' as const, source: 'dock' as const }),
};

describe('asset result hook wiring', () => {
  it('registers PostToolUse hooks for both gen tools in ask mode with a gate', () => {
    const options = buildQueryOptions(askConfig, bridge, digest, fullGate);
    const post = options.hooks.PostToolUse ?? [];
    expect(post.map((m) => m.matcher).sort()).toEqual([GEN_MESH_TOOL, WAIT_JOB_TOOL].sort());
    expect(post.every((m) => m.hooks.length === 1)).toBe(true);
  });

  it('registers no PostToolUse hooks in auto mode or without a gate', () => {
    expect(buildQueryOptions(autoConfig, bridge, digest, fullGate).hooks.PostToolUse).toBeUndefined();
    expect(buildQueryOptions(askConfig, bridge, digest, undefined).hooks.PostToolUse).toBeUndefined();
  });
});
```

(`askConfig` / `autoConfig` / `bridge` / `digest`: use the fixtures already defined in `tests/buildOptions.test.ts` — the file already builds ask- and auto-mode configs for the P1 gate tests. If the existing gate fixture lacks `requestResult`, extend it with the `fullGate` shape above.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/buildOptions.test.ts`
Expected: FAIL — no PostToolUse hooks registered (and possibly a type error on the gate param, fixed next step).

- [ ] **Step 3: Implement**

In `src/agent/buildOptions.ts`:

```ts
import { buildSyncHook, buildAssetResultHook, EXECUTE_LUAU_TOOL, GEN_MESH_TOOL, WAIT_JOB_TOOL } from './hooks.js';
import type { ResultGateChannel } from './hooks.js';
import { buildCanUseTool, nonGatedAllowedTools, type GateChannel } from './permission.js';

// The dock panel's combined channel: P1 pre-call gates + P2 result gates.
export type PanelGateChannel = GateChannel & ResultGateChannel;
```

Change the signature and the hooks block:

```ts
export function buildQueryOptions(
  config: BloxConfig,
  bridge: StudioBridge,
  digest: ProjectDigest,
  gate?: PanelGateChannel,
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
      ? { canUseTool: buildCanUseTool(gate) }
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
      ...(ask && gate
        ? {
            PostToolUse: [
              { matcher: GEN_MESH_TOOL, hooks: [buildAssetResultHook(gate)] },
              { matcher: WAIT_JOB_TOOL, hooks: [buildAssetResultHook(gate)] },
            ],
          }
        : {}),
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/buildOptions.test.ts && npx tsc --noEmit`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agent/buildOptions.ts tests/buildOptions.test.ts
git commit -m "feat(agent): wire asset result hook in ask mode"
```

---

### Task 7: Report assets section + CLI wiring

**Files:**
- Modify: `src/report.ts`
- Modify: `src/cli.ts:140-145` (gate adapter) and `:183-197` (report construction)
- Modify: `tests/report.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/report.test.ts` (follow the file's existing fixture pattern for a baseline `RunReport`):

```ts
it('renders the assets section with feedback and timeout note', () => {
  const out = formatReport({
    ...baseReport,
    assetDecisions: [
      { tool: 'mcp__Roblox_Studio__generate_mesh', decision: 'approve', source: 'dock' },
      { tool: 'mcp__Roblox_Studio__generate_mesh', decision: 'reject', source: 'dock', feedback: 'too tall' },
      { tool: 'mcp__Roblox_Studio__wait_job_finished', decision: 'approve', source: 'timeout' },
    ],
  });
  expect(out).toContain('assets:');
  expect(out).toContain('  mcp__Roblox_Studio__generate_mesh — approve');
  expect(out).toContain('  mcp__Roblox_Studio__generate_mesh — reject  feedback: too tall');
  expect(out).toContain('  mcp__Roblox_Studio__wait_job_finished — approve (unreviewed: gate timed out)');
});

it('omits the assets section when empty', () => {
  expect(formatReport({ ...baseReport, assetDecisions: [] })).not.toContain('assets:');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/report.test.ts`
Expected: FAIL — `assetDecisions` not a known field / section missing.

- [ ] **Step 3: Implement**

In `src/report.ts`, add to `RunReport`:

```ts
  assetDecisions?: { tool: string; decision: 'approve' | 'reject'; source: 'dock' | 'timeout'; feedback?: string }[];
```

Add to `formatReport`'s `lines` array, after the `deniedByUser` block:

```ts
    ...(r.assetDecisions && r.assetDecisions.length
      ? [
          `assets:`,
          ...r.assetDecisions.map(
            (a) =>
              `  ${a.tool} — ${a.decision}` +
              (a.source === 'timeout' ? ' (unreviewed: gate timed out)' : '') +
              (a.feedback ? `  feedback: ${a.feedback}` : ''),
          ),
        ]
      : []),
```

In `src/cli.ts`, extend the gate adapter (lines 140–145) with the result channel:

```ts
  const gate = panel
    ? {
        isConnected: () => panel!.isConnected(),
        request: (tool: string, input: Record<string, unknown>) => panel!.gates.request(tool, input),
        requestResult: (tool: string, tag: string | null, inputSummary: string) =>
          panel!.gates.requestResult(tool, tag, inputSummary),
      }
    : undefined;
```

And add to the `RunReport` construction (after `deniedByUser`):

```ts
      assetDecisions: panel ? panel.gates.resultDecisions() : undefined,
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run && npx tsc --noEmit`
Expected: full suite passes (cli.ts has no unit test of its own; tsc validates the wiring).

- [ ] **Step 5: Commit**

```bash
git add src/report.ts src/cli.ts tests/report.test.ts
git commit -m "feat(report): assets section from result-gate decisions"
```

---

### Task 8: Integration test — park in hook, resolve over HTTP

**Files:**
- Modify: `tests/panel.integration.test.ts`

- [ ] **Step 1: Write the test (it should pass against Tasks 2-7 — this is an end-to-end seam check, not TDD of new code)**

Append to `tests/panel.integration.test.ts` (reuse the file's existing server startup helper if one exists; otherwise mirror `tests/panel.server.test.ts`'s `start()`):

```ts
import { buildAssetResultHook, GEN_MESH_TOOL } from '../src/agent/hooks.js';
import type { HookInput } from '@anthropic-ai/claude-agent-sdk';

describe('result gate end-to-end through the panel server', () => {
  it('parks the hook, dock rejects with feedback over HTTP, hook blocks with the reason', async () => {
    const server = new PanelServer({ runId: 'r', project: 'g', port: 0, holdMs: 50 });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}/api/v1`;
    try {
      // simulate a connected dock (connection = recent poll)
      await fetch(`${base}/events?cursor=0`);
      const hook = buildAssetResultHook({
        isConnected: () => server.isConnected(),
        requestResult: (tool, tag, summary) => server.gates.requestResult(tool, tag, summary),
      });
      const hookOut = hook(
        {
          hook_event_name: 'PostToolUse',
          tool_name: GEN_MESH_TOOL,
          tool_input: { textPrompt: 'barrel' },
          tool_response: { content: [{ type: 'text', text: '{"tag":"Assistant-MeshGen-12345678-aaaa-4bbb-8ccc-1234567890ab"}' }] },
          tool_use_id: 't1',
          session_id: 's',
          transcript_path: '',
          cwd: '/game',
        } as unknown as HookInput,
        't1',
        { signal: new AbortController().signal },
      );
      const events = (await (await fetch(`${base}/events?cursor=1`)).json()).events;
      const req = events.find((e: { type: string }) => e.type === 'result_gate_request');
      expect(req.tag).toBe('Assistant-MeshGen-12345678-aaaa-4bbb-8ccc-1234567890ab');
      await fetch(`${base}/gate/${req.gateId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'reject', feedback: 'wrong shape' }),
      });
      const out = (await hookOut) as { decision?: string; reason?: string };
      expect(out.decision).toBe('block');
      expect(out.reason).toContain('wrong shape');
      expect(server.gates.resultDecisions()).toEqual([
        {
          tool: GEN_MESH_TOOL,
          decision: 'reject',
          source: 'dock',
          feedback: 'wrong shape',
        },
      ]);
    } finally {
      await server.stop();
    }
  });
});
```

(Adjust the `cursor=1` fetch if the file's existing tests leave the buffer at a different cursor — fetch with `cursor=0` and filter by type is also fine.)

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/panel.integration.test.ts`
Expected: PASS. If it fails, the seam between hook ↔ broker ↔ server is broken — fix before proceeding, do not adjust the test to pass.

- [ ] **Step 3: Commit**

```bash
git add tests/panel.integration.test.ts
git commit -m "test(panel): result gate end-to-end through hook and HTTP"
```

---

### Task 9: Mock bridge — realistic generate_mesh result + tightened wait_job_finished

**Files:**
- Modify: `src/bridge/mockBridge.ts`
- Modify: `tests/` (the bridge parity / mock tests if mock result shapes are asserted — run the suite to find out)

- [ ] **Step 1: Align the mock `generate_mesh` fake with the live-probed result shape**

In `src/bridge/mockBridge.ts`, make the `generate_mesh` fake return the real shape (a text block whose body is `{"tag":"Assistant-MeshGen-<uuid>"}`), e.g.:

```ts
const MOCK_MESH_TAG = 'Assistant-MeshGen-00000000-0000-4000-8000-000000000000';
// generate_mesh (live-probed): returns the inserted MeshPart's name tag.
// ... in the tool fake:
textResult(JSON.stringify({ tag: MOCK_MESH_TAG }))
```

Follow the file's existing fake/helper pattern (`playResult()`, `creatorSearchResult()`, `jobFinishedResult()` are precedents); export `MOCK_MESH_TAG` so tests can assert against it. Task 1's probe recorded the real `wait_job_finished` done-shape — update `jobFinishedResult` to produce a text block whose body matches it:

```ts
JSON.stringify({
  modelFullName: 'Workspace.MockRock',
  resultName: 'MockRock',
  status: 'Completed',
  prompt: 'a mock rock',
  generationId: '00000000-0000-4000-8000-000000000001',
})
```

(Keep the helper's existing signature/parameterization if it has one; only the body shape changes.)

- [ ] **Step 2: Run the suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all pass; fix any mock-shape assertions the change breaks (update them to the new shape — the new shape is the live-correct one).

- [ ] **Step 3: Commit**

```bash
git add src/bridge/mockBridge.ts tests/
git commit -m "fix(bridge): mock generate_mesh returns live-probed tag shape"
```

---

### Task 10: Plugin — result card UI (Ui.luau)

**Files:**
- Modify: `plugin/src/Ui.luau`

No vitest coverage (Luau); verification = rojo build in Task 12 + live smoke in Task 13.

- [ ] **Step 1: Add the result card to `Ui.build`**

In `plugin/src/Ui.luau`, after the existing gate card block (the `gate`/`gateText`/allow/deny section), add a result card and include the new references in the returned table:

```lua
	-- Result card: hidden until a result_gate_request arrives (P2 spec §5).
	local result = Instance.new("Frame")
	result.Name = "ResultGate"
	result.LayoutOrder = 3
	result.Size = UDim2.new(1, -8, 0, 210)
	result.BackgroundColor3 = Color3.fromRGB(30, 50, 60)
	result.Visible = false
	result.Parent = root

	local resultText = label(result, "ResultText", 1)
	resultText.Position = UDim2.fromOffset(4, 4)
	resultText.Size = UDim2.new(1, -8, 0, 36)
	resultText.TextWrapped = true
	resultText.TextTruncate = Enum.TextTruncate.None

	local viewport = Instance.new("ViewportFrame")
	viewport.Name = "Preview"
	viewport.Position = UDim2.fromOffset(4, 44)
	viewport.Size = UDim2.new(1, -8, 0, 100)
	viewport.BackgroundColor3 = Color3.fromRGB(20, 20, 20)
	viewport.Parent = result

	local feedbackBox = Instance.new("TextBox")
	feedbackBox.Name = "Feedback"
	feedbackBox.PlaceholderText = "optional feedback for the agent (sent on Reject)"
	feedbackBox.Text = ""
	feedbackBox.Position = UDim2.new(0, 4, 1, -62)
	feedbackBox.Size = UDim2.new(1, -8, 0, 24)
	feedbackBox.BackgroundColor3 = Color3.fromRGB(50, 50, 50)
	feedbackBox.TextColor3 = Color3.fromRGB(220, 220, 220)
	feedbackBox.TextXAlignment = Enum.TextXAlignment.Left
	feedbackBox.ClearTextOnFocus = false
	feedbackBox.Parent = result

	local function resultButton(name: string, x: number, color: Color3): TextButton
		local b = Instance.new("TextButton")
		b.Name = name
		b.Text = name
		b.Position = UDim2.new(0, x, 1, -30)
		b.Size = UDim2.fromOffset(80, 24)
		b.BackgroundColor3 = color
		b.TextColor3 = Color3.fromRGB(255, 255, 255)
		b.Parent = result
		return b
	end
	local approve = resultButton("Approve", 4, Color3.fromRGB(40, 120, 40))
	local reject = resultButton("Reject", 92, Color3.fromRGB(140, 40, 40))
```

And extend the returned table:

```lua
		resultGate = result,
		resultText = resultText,
		preview = viewport,
		feedbackBox = feedbackBox,
		approveButton = approve,
		rejectButton = reject,
```

Also bump the gate card's neighbors: the existing `diffs` scroller is `LayoutOrder = 3` and `log` is `4` — renumber them to `4` and `5` so the result card sits between the gate card and the lists.

- [ ] **Step 2: Commit**

```bash
git add plugin/src/Ui.luau
git commit -m "feat(plugin): result gate card UI with viewport preview"
```

---

### Task 11: Plugin — result gate behavior (init.server.luau)

**Files:**
- Modify: `plugin/src/init.server.luau`

- [ ] **Step 1: Bump the protocol and add result-gate handling**

In `plugin/src/init.server.luau`:

Change `local PROTOCOL = 1` to `local PROTOCOL = 2`.

Add services at the top (after `HttpService`):

```lua
local Selection = game:GetService("Selection")
local TweenService = game:GetService("TweenService")
local ChangeHistoryService = game:GetService("ChangeHistoryService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
```

Add state + helpers (near `activeGateId`):

```lua
local activeResultGateId: string? = nil
local activeResultInstance: Instance? = nil

-- Find the generated instance by its name tag anywhere under Workspace.
local function findByTag(tag: string?): Instance?
	if not tag then
		return nil
	end
	return workspace:FindFirstChild(tag, true)
end

-- Clone into a WorldModel inside the ViewportFrame, camera fitted from the
-- clone's bounding box. Cleared and rebuilt per gate.
local function showPreview(viewport: ViewportFrame, instance: Instance?)
	viewport:ClearAllChildren()
	if not instance then
		return
	end
	local world = Instance.new("WorldModel")
	world.Parent = viewport
	local holder = Instance.new("Model")
	local clone = instance:Clone()
	clone.Parent = holder
	holder.Parent = world
	local cf, size = holder:GetBoundingBox()
	local camera = Instance.new("Camera")
	local dist = math.max(size.Magnitude, 1) * 1.5
	camera.CFrame = CFrame.lookAt(cf.Position + Vector3.new(dist, dist * 0.6, dist), cf.Position)
	camera.Parent = viewport
	viewport.CurrentCamera = camera
end

-- Select the real instance and tween the main camera to frame it.
local function frameInViewport(instance: Instance?)
	if not instance then
		return
	end
	Selection:Set({ instance })
	local holder = Instance.new("Model")
	local cf: CFrame, size: Vector3
	if instance:IsA("Model") then
		cf, size = instance:GetBoundingBox()
	elseif instance:IsA("BasePart") then
		cf, size = instance.CFrame, instance.Size
	else
		return
	end
	local _ = holder -- only needed for the Model wrap above; unused otherwise
	local dist = math.max(size.Magnitude, 1) * 2
	local target = CFrame.lookAt(cf.Position + Vector3.new(dist, dist * 0.6, dist), cf.Position)
	local camera = workspace.CurrentCamera
	TweenService:Create(camera, TweenInfo.new(0.5, Enum.EasingStyle.Quad, Enum.EasingDirection.Out), { CFrame = target }):Play()
end

-- Reject disposition (P2 spec §2): stash, don't destroy. Runs BEFORE the
-- decision POST so the agent's "already set aside" message is true.
local function stashRejected(instance: Instance?)
	if not instance then
		return
	end
	local folder = ReplicatedStorage:FindFirstChild("_bloxRejected")
	if not folder then
		folder = Instance.new("Folder")
		folder.Name = "_bloxRejected"
		folder.Parent = ReplicatedStorage
	end
	instance.Parent = folder
	ChangeHistoryService:SetWaypoint("blox: stash rejected asset")
end
```

Add to `handleEvent` (new branches before `run_finished`):

```lua
	elseif e.type == "result_gate_request" then
		activeResultGateId = e.gateId
		activeResultInstance = findByTag(e.tag)
		local title = ("Keep this %s result?\n%s"):format(e.tool, e.inputSummary)
		if not activeResultInstance then
			title ..= "\n(preview unavailable)"
		end
		ui.resultText.Text = title
		ui.feedbackBox.Text = ""
		showPreview(ui.preview, activeResultInstance)
		ui.resultGate.Visible = true
		frameInViewport(activeResultInstance)
	elseif e.type == "result_gate_resolved" then
		if e.gateId == activeResultGateId then
			ui.resultGate.Visible = false
			activeResultGateId = nil
			activeResultInstance = nil
		end
		addLog(("asset %s — %s (%s)"):format(e.gateId:sub(1, 8), e.decision, e.source))
```

Add button handlers (after the existing allow/deny handlers):

```lua
local function decideResult(decision: string)
	if not activeResultGateId then
		return
	end
	local body: { [string]: any } = { decision = decision }
	if decision == "reject" then
		stashRejected(activeResultInstance)
		if ui.feedbackBox.Text ~= "" then
			body.feedback = ui.feedbackBox.Text
		end
	end
	request("POST", "/gate/" .. activeResultGateId, body)
	ui.resultGate.Visible = false
	activeResultGateId = nil
	activeResultInstance = nil
end
ui.approveButton.MouseButton1Click:Connect(function()
	decideResult("approve")
end)
ui.rejectButton.MouseButton1Click:Connect(function()
	decideResult("reject")
end)
ui.preview.InputBegan:Connect(function(io)
	if io.UserInputType == Enum.UserInputType.MouseButton1 then
		frameInViewport(activeResultInstance)
	end
end)
```

(Design note: one result card at a time, matching P1's single `activeGateId` pattern — the run is parked while the gate is open, so a second concurrent gate cannot arrive from the same run.)

- [ ] **Step 2: Commit**

```bash
git add plugin/src/init.server.luau
git commit -m "feat(plugin): result gate card with preview, stash, feedback"
```

---

### Task 12: Build verification

**Files:**
- None (verification only).

- [ ] **Step 1: Build the plugin**

Run: `rojo build plugin -o /tmp/blox-panel.rbxm && ls -la /tmp/blox-panel.rbxm`
Expected: builds without error, size noticeably above P1's 4586 bytes.

- [ ] **Step 2: Full suite + typecheck + build**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all pass, `dist/cli.js` produced.

- [ ] **Step 3: Commit anything the build surfaced (otherwise nothing to commit)**

---

### Task 13: README + live smoke + finish

**Files:**
- Modify: `README.md` (the "Studio dock panel" section)
- Create: `tests/e2e/live-assetgate.test.ts`

- [ ] **Step 1: Add the gated live test**

Create `tests/e2e/live-assetgate.test.ts`, mirroring `tests/e2e/live-asset.test.ts`'s gating pattern (`BLOX_LIVE_ASSETGATE=1` env guard, self-skip otherwise). The test exercises the CLI-side seam only (broker + server + hook against a real generation it cannot click — full click-through is the manual smoke):

```ts
import { describe, it, expect } from 'vitest';

const LIVE = process.env.BLOX_LIVE_ASSETGATE === '1';

// Full approve/reject click-through needs a human in Studio — that is the
// manual smoke (this task, step 3). This gated test only proves the live
// generate_mesh result still matches the tag convention the hook parses.
describe.skipIf(!LIVE)('live asset result tag', () => {
  it('generate_mesh result carries an Assistant-*-<uuid> tag extractAssetTag finds', async () => {
    const { probeExecuteLuau } = await import('../../src/doctor.js');
    const { studioLauncher } = await import('../../src/bridge/mcpBridge.js');
    const { extractAssetTag } = await import('../../src/agent/hooks.js');
    // Warm the attach, then generate (mirrors tests/e2e/live-asset.test.ts —
    // reuse its client/connect helpers per that file's pattern).
    // After calling generate_mesh with {textPrompt: 'a small test cube', maxTriangles: 500}:
    //   expect(extractAssetTag(result)).toMatch(/^Assistant-/);
    expect(typeof extractAssetTag).toBe('function');
  }, 120_000);
});
```

(Implementer: copy the connect/warm-up scaffolding from `tests/e2e/live-asset.test.ts` verbatim and call `generate_mesh` through the same client; the assertion that matters is `extractAssetTag(<CallToolResult>) !== null`.)

- [ ] **Step 2: README section**

In `README.md`'s "Studio dock panel" section, after the existing `--ask` paragraph, add:

```markdown
Asset generations (`generate_mesh`, procedural models) additionally pause
after the result lands: the dock shows a 3D preview of the generated asset
(click it to frame the asset in the main viewport) with **Approve** and
**Reject** buttons and an optional feedback box. Approve resumes the run.
Reject moves the asset to `ReplicatedStorage._bloxRejected` (undo-able,
nothing is destroyed) and tells the agent why, using your feedback. If the
gate times out (default 120s) the asset is kept and the run continues — the
report marks it unreviewed.
```

- [ ] **Step 3: Manual live smoke (needs Windows Studio + human)**

Checklist:
1. `node dist/cli.js panel install`; open dock in Studio.
2. Re-run Task 1's probe if it was skipped (record `wait_job_finished` shape; tighten `extractAssetTag`/mock if it breaks the tag convention).
3. `node dist/cli.js "generate a mesh of a low-poly barrel and insert it into Workspace" --ask --project test-fixtures/game`
4. Pre-gate card → Allow. After ~29s: result card appears with 3D thumbnail; main camera frames the barrel.
5. Click thumbnail → camera re-frames; barrel selected.
6. **Approve** → run resumes and completes; report shows `assets:` line with `approve`.
7. Re-run; Allow; this time type feedback ("make it shorter") and **Reject** → barrel moves to `ReplicatedStorage._bloxRejected`; agent acknowledges the feedback in its next turn; report shows `reject  feedback: make it shorter`.
8. Re-run; Allow; let the result gate time out → run resumes; report line carries `(unreviewed: gate timed out)`.

- [ ] **Step 4: Commit, then finish the branch**

```bash
git add README.md tests/e2e/live-assetgate.test.ts
git commit -m "docs+test(p2): asset gate README and gated live test"
```

Then: spec status line → `Implemented (P2)`, final commit, and use superpowers:finishing-a-development-branch (merge to main + push, per project convention).

---

## Self-Review Notes

- **Spec coverage:** §2 decisions → Tasks 3 (timeout-approve), 5 (feedback in block reason, tag-null path), 11 (stash-before-POST, both previews); §3 flow → Tasks 5-7; §4 CLI components → Tasks 2-7 one-to-one; §5 plugin → Tasks 10-11; §6 edge cases → kind-mismatch (Task 4), preview-unavailable (Task 11), single-card note (Task 11); §7 testing → Tasks 3-5 unit, 8 integration, 13 live + probe (Task 1 front-loaded per spec).
- **Type consistency:** `requestResult(tool, tag, inputSummary)` identical in gates.ts (Task 3), `ResultGateChannel` (Task 5), cli.ts adapter (Task 7), integration test (Task 8). `resolve(gateId, decision, feedback?)` boolean everywhere. `ResultRecord {tool, decision, source, feedback?}` matches report field `assetDecisions` (Task 7).
- **Known softness (accepted):** Tasks 6/7/13 reference existing test fixtures by role rather than repeating them (`askConfig`, `baseReport`, live-asset scaffolding) — implementer reads the target test file first; the new assertions are complete as written.
