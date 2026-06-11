# blox Pivot P1 — Studio Dock Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A blox run is visible and controllable from inside Roblox Studio — live status, streamed agent log, file-diff summaries, and interactive approve/deny for gated actions — without the CLI ever depending on the panel.

**Architecture:** The CLI hosts a local HTTP server (`node:http`, 127.0.0.1:35768) for the run's duration; a thin Luau dock-widget plugin long-polls it (the Rojo plugin pattern). Events flow through a cursor-addressed ring buffer (reconnect = replay). A gate broker makes `--ask` interactive when the dock is connected: gated tools pause and await a dock decision, falling back to today's deny+stop on timeout or no dock. Spec: `docs/superpowers/specs/2026-06-11-blox-pivot-p1-studio-dock-panel-design.md`.

**Tech Stack:** TypeScript (Node ≥20, ESM, `.js` import suffixes), `node:http` (zero new deps), zod (config), vitest, Luau + Rojo for the plugin.

**Conventions (match existing code):** comment density and style as in `src/sync/serve.ts`; tests use `describe`/`it` + plain `expect`; injectable dependencies via options objects for testability; every module path imported with `.js` extension.

---

## File structure

**Create:**
- `src/panel/events.ts` — `PanelEvent` union, `EventSink` interface, `PROTOCOL_VERSION`
- `src/panel/buffer.ts` — `EventBuffer`: ring buffer + monotonic cursor + change notification
- `src/panel/gates.ts` — `GateBroker`: pending-gate registry, timeout fallback, dock-denied bookkeeping
- `src/panel/translate.ts` — pure SDK-stream-message → `PanelEvent[]` translation (incl. file-diff summaries)
- `src/panel/server.ts` — `PanelServer`: HTTP endpoints, long-poll, connection tracking
- `src/panel/install.ts` — locate Studio plugins dir, build + copy the `.rbxm`
- `plugin/default.project.json` — Rojo project for the plugin build
- `plugin/src/init.server.luau` — plugin entry: toolbar, widget, poll loop, gate POST
- `plugin/src/Ui.luau` — dumb UI construction module
- `tests/panel.buffer.test.ts`, `tests/panel.gates.test.ts`, `tests/panel.translate.test.ts`, `tests/panel.server.test.ts`, `tests/panel.integration.test.ts`, `tests/panel.install.test.ts`

**Modify:**
- `src/config.ts` — `panel` config section (port, gateTimeoutSeconds)
- `src/agent/runAgent.ts` — optional `EventSink` + dock-denied split in `summarizeResult`
- `src/agent/permission.ts` — optional `GateChannel` in `buildCanUseTool`
- `src/agent/buildOptions.ts` — pass `GateChannel` through
- `src/args.ts` — `panel` command
- `src/cli.ts` — server lifecycle, sink wiring, `panel install`, report split
- `src/report.ts` — `deniedByUser` section
- `tests/runAgent.test.ts`, `tests/permission.test.ts`, `tests/buildOptions.test.ts`, `tests/config.test.ts`, `tests/args.test.ts`, `tests/report.test.ts`
- `README.md` — panel section

---

### Task 1: Event types + ring buffer

**Files:**
- Create: `src/panel/events.ts`
- Create: `src/panel/buffer.ts`
- Test: `tests/panel.buffer.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/panel.buffer.test.ts
import { describe, it, expect } from 'vitest';
import { EventBuffer } from '../src/panel/buffer.js';
import type { PanelEvent } from '../src/panel/events.js';

const log = (text: string): PanelEvent => ({ type: 'log', text });

describe('EventBuffer', () => {
  it('appends events with increasing cursors and returns them since a cursor', () => {
    const b = new EventBuffer();
    b.append(log('a'));
    b.append(log('b'));
    const r = b.since(0);
    expect(r.cursor).toBe(2);
    expect(r.events).toEqual([log('a'), log('b')]);
    expect(b.since(2).events).toEqual([]);
    expect(b.since(1).events).toEqual([log('b')]);
  });

  it('evicts oldest events past capacity but keeps cursors monotonic', () => {
    const b = new EventBuffer(3);
    for (const t of ['a', 'b', 'c', 'd']) b.append(log(t));
    const r = b.since(0); // 'a' evicted
    expect(r.events).toEqual([log('b'), log('c'), log('d')]);
    expect(r.cursor).toBe(4);
  });

  it('notifies a waiter exactly once when an event arrives', async () => {
    const b = new EventBuffer();
    let woke = 0;
    const p = b.waitForChange().then(() => { woke += 1; });
    b.append(log('x'));
    await p;
    expect(woke).toBe(1);
    b.append(log('y')); // no pending waiter — must not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/panel.buffer.test.ts`
Expected: FAIL — `Cannot find module '../src/panel/buffer.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/panel/events.ts
// Wire protocol between the CLI's panel server and the Studio dock plugin.
// Bump PROTOCOL_VERSION on any breaking change; the plugin shows an update
// hint on mismatch and the CLI runs unaffected (spec §4).
export const PROTOCOL_VERSION = 1;

export type GateDecisionValue = 'allow' | 'deny';
export type GateSource = 'dock' | 'timeout';

export type PanelEvent =
  | { type: 'run_started'; runId: string; prompt: string; mode: 'auto' | 'ask'; maxTurns: number; maxBudgetUsd: number }
  | { type: 'status'; turns: number }
  | { type: 'log'; text: string }
  | { type: 'file_diff'; path: string; added: number; removed: number }
  | { type: 'gate_request'; gateId: string; tool: string; inputSummary: string }
  | { type: 'gate_resolved'; gateId: string; decision: GateDecisionValue; source: GateSource }
  | { type: 'run_finished'; status: 'success' | 'error'; stopReason: string; turns: number; costUsd: number };

export interface EventSink {
  emit(event: PanelEvent): void;
}
```

```typescript
// src/panel/buffer.ts
import type { PanelEvent } from './events.js';

// Cursor-addressed ring buffer. Cursors are monotonic event counts (not array
// indices), so a reconnecting plugin replays from its last cursor even after
// eviction — it just silently misses anything older than `capacity`.
export class EventBuffer {
  private events: PanelEvent[] = [];
  private evicted = 0; // count of events dropped off the front
  private waiters: (() => void)[] = [];

  constructor(private capacity = 1000) {}

  append(event: PanelEvent): void {
    this.events.push(event);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
      this.evicted = this.cursor() - this.events.length;
    }
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  cursor(): number {
    return this.evicted + this.events.length;
  }

  since(cursor: number): { events: PanelEvent[]; cursor: number } {
    const start = Math.max(cursor - this.evicted, 0);
    return { events: this.events.slice(start), cursor: this.cursor() };
  }

  // Resolves on the next append. Used by the server's long-poll hold.
  waitForChange(): Promise<void> {
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/panel.buffer.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/panel/events.ts src/panel/buffer.ts tests/panel.buffer.test.ts
git commit -m "feat(panel): event protocol types and cursor ring buffer"
```

---

### Task 2: Gate broker

**Files:**
- Create: `src/panel/gates.ts`
- Test: `tests/panel.gates.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/panel.gates.test.ts
import { describe, it, expect, vi } from 'vitest';
import { GateBroker } from '../src/panel/gates.js';
import type { PanelEvent } from '../src/panel/events.js';

function collector() {
  const events: PanelEvent[] = [];
  return { sink: { emit: (e: PanelEvent) => events.push(e) }, events };
}

describe('GateBroker', () => {
  it('emits gate_request and resolves allow from the dock', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const p = broker.request('mcp__Roblox_Studio__generate_mesh', { prompt: 'rock' });
    const req = events.find((e) => e.type === 'gate_request');
    expect(req).toBeDefined();
    if (req?.type !== 'gate_request') throw new Error('unreachable');
    expect(req.tool).toBe('mcp__Roblox_Studio__generate_mesh');
    expect(req.inputSummary).toContain('rock');
    expect(broker.resolve(req.gateId, 'allow')).toBe(true);
    expect(await p).toEqual({ decision: 'allow', source: 'dock' });
    expect(events.some((e) => e.type === 'gate_resolved' && e.decision === 'allow' && e.source === 'dock')).toBe(true);
  });

  it('records dock-denied tools for the report split', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    const p = broker.request('mcp__Roblox_Studio__start_stop_play', {});
    const req = events.find((e) => e.type === 'gate_request');
    if (req?.type !== 'gate_request') throw new Error('unreachable');
    broker.resolve(req.gateId, 'deny');
    expect(await p).toEqual({ decision: 'deny', source: 'dock' });
    expect(broker.dockDeniedTools()).toEqual(['mcp__Roblox_Studio__start_stop_play']);
  });

  it('times out to deny with source timeout', async () => {
    vi.useFakeTimers();
    try {
      const { sink, events } = collector();
      const broker = new GateBroker(sink, 1000);
      const p = broker.request('mcp__Roblox_Studio__generate_mesh', {});
      vi.advanceTimersByTime(1001);
      expect(await p).toEqual({ decision: 'deny', source: 'timeout' });
      expect(events.some((e) => e.type === 'gate_resolved' && e.source === 'timeout')).toBe(true);
      expect(broker.dockDeniedTools()).toEqual([]); // timeout is not a user decision
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns false for unknown or already-resolved gate ids', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    expect(broker.resolve('nope', 'allow')).toBe(false);
    const p = broker.request('mcp__Roblox_Studio__generate_mesh', {});
    const req = events.find((e) => e.type === 'gate_request');
    if (req?.type !== 'gate_request') throw new Error('unreachable');
    broker.resolve(req.gateId, 'allow');
    await p;
    expect(broker.resolve(req.gateId, 'deny')).toBe(false);
  });

  it('truncates huge input summaries', async () => {
    const { sink, events } = collector();
    const broker = new GateBroker(sink, 60_000);
    void broker.request('mcp__Roblox_Studio__generate_mesh', { prompt: 'x'.repeat(1000) });
    const req = events.find((e) => e.type === 'gate_request');
    if (req?.type !== 'gate_request') throw new Error('unreachable');
    expect(req.inputSummary.length).toBeLessThanOrEqual(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/panel.gates.test.ts`
Expected: FAIL — `Cannot find module '../src/panel/gates.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/panel/gates.ts
import { randomUUID } from 'node:crypto';
import type { EventSink, GateDecisionValue, GateSource } from './events.js';

export interface GateDecision {
  decision: GateDecisionValue;
  source: GateSource;
}

// Pending-gate registry. request() publishes a gate_request event and parks the
// agent's canUseTool callback on a promise; the dock resolves it via the
// server's POST /gate/{id}, or the timeout falls back to deny (spec §5, §7).
export class GateBroker {
  private pending = new Map<string, (d: GateDecision) => void>();
  private denied: string[] = []; // tools the USER denied (timeouts excluded)

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
      const finish = (d: GateDecision) => {
        clearTimeout(timer);
        this.pending.delete(gateId);
        if (d.decision === 'deny' && d.source === 'dock') this.denied.push(tool);
        this.sink.emit({ type: 'gate_resolved', gateId, decision: d.decision, source: d.source });
        resolve(d);
      };
      const timer = setTimeout(() => finish({ decision: 'deny', source: 'timeout' }), this.timeoutMs);
      this.pending.set(gateId, finish);
    });
  }

  resolve(gateId: string, decision: GateDecisionValue): boolean {
    const finish = this.pending.get(gateId);
    if (!finish) return false;
    finish({ decision, source: 'dock' });
    return true;
  }

  // Tools denied interactively — the report lists these as user decisions, not
  // as "blocked, re-run with --auto" (spec §5).
  dockDeniedTools(): string[] {
    return [...this.denied];
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/panel.gates.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/panel/gates.ts tests/panel.gates.test.ts
git commit -m "feat(panel): gate broker with dock resolution and timeout fallback"
```

---

### Task 3: Stream-message → event translation

**Files:**
- Create: `src/panel/translate.ts`
- Test: `tests/panel.translate.test.ts`

SDK `assistant` messages carry `message.content` arrays of `text` and `tool_use` blocks. Translation is a pure function so it tests without the SDK.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/panel.translate.test.ts
import { describe, it, expect } from 'vitest';
import { eventsFromMessage } from '../src/panel/translate.js';

function assistant(content: unknown[]) {
  return { type: 'assistant', message: { content } };
}

describe('eventsFromMessage', () => {
  it('turns text blocks into log events, truncated to 500 chars', () => {
    const events = eventsFromMessage(assistant([{ type: 'text', text: 'hello' }]));
    expect(events).toEqual([{ type: 'log', text: 'hello' }]);
    const long = eventsFromMessage(assistant([{ type: 'text', text: 'x'.repeat(600) }]));
    expect(long[0]).toMatchObject({ type: 'log' });
    if (long[0].type === 'log') expect(long[0].text.length).toBe(500);
  });

  it('turns tool_use blocks into tool log lines', () => {
    const events = eventsFromMessage(
      assistant([{ type: 'tool_use', name: 'mcp__Roblox_Studio__execute_luau', input: { script: 'print(1)' } }]),
    );
    expect(events).toEqual([{ type: 'log', text: 'tool: mcp__Roblox_Studio__execute_luau' }]);
  });

  it('adds a file_diff event for Edit with line counts from old/new strings', () => {
    const events = eventsFromMessage(
      assistant([
        {
          type: 'tool_use',
          name: 'Edit',
          input: { file_path: 'src/Greeter.luau', old_string: 'a\nb', new_string: 'a\nb\nc' },
        },
      ]),
    );
    expect(events).toContainEqual({ type: 'file_diff', path: 'src/Greeter.luau', added: 3, removed: 2 });
  });

  it('adds a file_diff event for Write with content lines added', () => {
    const events = eventsFromMessage(
      assistant([{ type: 'tool_use', name: 'Write', input: { file_path: 'src/New.luau', content: 'x\ny' } }]),
    );
    expect(events).toContainEqual({ type: 'file_diff', path: 'src/New.luau', added: 2, removed: 0 });
  });

  it('ignores non-assistant messages and malformed blocks', () => {
    expect(eventsFromMessage({ type: 'result', subtype: 'success' })).toEqual([]);
    expect(eventsFromMessage(assistant([{ type: 'tool_use', name: 'Edit', input: {} }]))).toEqual([
      { type: 'log', text: 'tool: Edit' },
    ]);
    expect(eventsFromMessage(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/panel.translate.test.ts`
Expected: FAIL — `Cannot find module '../src/panel/translate.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/panel/translate.ts
import type { PanelEvent } from './events.js';

const LOG_LIMIT = 500;

function countLines(s: unknown): number {
  return typeof s === 'string' && s.length > 0 ? s.split('\n').length : 0;
}

interface BlockLike {
  type?: unknown;
  text?: unknown;
  name?: unknown;
  input?: unknown;
}

// File-diff summaries are derived from the tool inputs, not a real diff: good
// enough for the dock's "what changed" list (spec defers hunk rendering, §9).
function fileDiff(name: string, input: Record<string, unknown>): PanelEvent | null {
  const path = input.file_path;
  if (typeof path !== 'string' || path.length === 0) return null;
  if (name === 'Edit') {
    return { type: 'file_diff', path, added: countLines(input.new_string), removed: countLines(input.old_string) };
  }
  if (name === 'Write') {
    return { type: 'file_diff', path, added: countLines(input.content), removed: 0 };
  }
  return null;
}

// Pure translation of one SDK stream message into panel events. Unknown
// message shapes translate to nothing — the panel must never break a run.
export function eventsFromMessage(message: unknown): PanelEvent[] {
  const m = message as { type?: unknown; message?: { content?: unknown } } | null;
  if (!m || m.type !== 'assistant' || !Array.isArray(m.message?.content)) return [];
  const events: PanelEvent[] = [];
  for (const block of m.message.content as BlockLike[]) {
    if (block?.type === 'text' && typeof block.text === 'string') {
      events.push({ type: 'log', text: block.text.slice(0, LOG_LIMIT) });
    } else if (block?.type === 'tool_use' && typeof block.name === 'string') {
      events.push({ type: 'log', text: `tool: ${block.name}` });
      const input = (block.input ?? {}) as Record<string, unknown>;
      const diff = fileDiff(block.name, input);
      if (diff) events.push(diff);
    }
  }
  return events;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/panel.translate.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/panel/translate.ts tests/panel.translate.test.ts
git commit -m "feat(panel): translate SDK stream messages into panel events"
```

---

### Task 4: Panel HTTP server

**Files:**
- Create: `src/panel/server.ts`
- Test: `tests/panel.server.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// tests/panel.server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { PanelServer } from '../src/panel/server.js';
import { PROTOCOL_VERSION } from '../src/panel/events.js';

let server: PanelServer | null = null;
afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

async function start(): Promise<{ s: PanelServer; base: string }> {
  // port 0 = OS-assigned ephemeral port; holdMs kept tiny so tests never hang
  server = new PanelServer({ runId: 'run-1', project: 'game', port: 0, holdMs: 50 });
  const port = await server.start();
  return { s: server, base: `http://127.0.0.1:${port}/api/v1` };
}

describe('PanelServer', () => {
  it('serves the handshake on /info', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/info`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protocol: PROTOCOL_VERSION, runId: 'run-1', project: 'game' });
  });

  it('returns buffered events immediately when available', async () => {
    const { s, base } = await start();
    s.emit({ type: 'log', text: 'hi' });
    const res = await fetch(`${base}/events?cursor=0`);
    const body = await res.json();
    expect(body.cursor).toBe(1);
    expect(body.events).toEqual([{ type: 'log', text: 'hi' }]);
  });

  it('long-polls: holds, then returns the event appended during the hold', async () => {
    const { s, base } = await start();
    const pending = fetch(`${base}/events?cursor=0`);
    setTimeout(() => s.emit({ type: 'log', text: 'late' }), 10);
    const body = await (await pending).json();
    expect(body.events).toEqual([{ type: 'log', text: 'late' }]);
  });

  it('long-polls: returns empty after the hold expires with no events', async () => {
    const { base } = await start();
    const body = await (await fetch(`${base}/events?cursor=0`)).json();
    expect(body).toEqual({ events: [], cursor: 0 });
  });

  it('resolves gates via POST and 404s unknown ids', async () => {
    const { s, base } = await start();
    const decision = s.gates.request('mcp__Roblox_Studio__generate_mesh', {});
    // the gate_request event carries the id
    const events = (await (await fetch(`${base}/events?cursor=0`)).json()).events;
    const req = events.find((e: { type: string }) => e.type === 'gate_request');
    const ok = await fetch(`${base}/gate/${req.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(ok.status).toBe(200);
    expect(await decision).toEqual({ decision: 'allow', source: 'dock' });
    const missing = await fetch(`${base}/gate/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(missing.status).toBe(404);
  });

  it('rejects bad gate bodies with 400', async () => {
    const { base } = await start();
    const res = await fetch(`${base}/gate/some-id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(res.status).toBe(400);
  });

  it('tracks connection state from event polls', async () => {
    const { s, base } = await start();
    expect(s.isConnected()).toBe(false);
    await fetch(`${base}/events?cursor=0`);
    expect(s.isConnected()).toBe(true);
  });

  it('404s unknown paths', async () => {
    const { base } = await start();
    expect((await fetch(`${base}/bogus`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/panel.server.test.ts`
Expected: FAIL — `Cannot find module '../src/panel/server.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/panel/server.ts
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { EventBuffer } from './buffer.js';
import { GateBroker } from './gates.js';
import { PROTOCOL_VERSION, type PanelEvent } from './events.js';

export interface PanelServerOptions {
  runId: string;
  project: string;
  port?: number; // 0 = ephemeral (tests); default 35768
  holdMs?: number; // long-poll hold; default 25_000
  gateTimeoutMs?: number; // default 120_000
  connectedWindowMs?: number; // poll recency window; default 10_000
  now?: () => number; // injectable clock for tests
}

// The CLI-side half of the dock panel (spec §3.1, §4). Binds 127.0.0.1 only —
// the same local trust model as the Rojo plugin. The panel must never block or
// break a run: callers treat start() failures as a warning, not an error.
export class PanelServer {
  readonly gates: GateBroker;
  private buffer = new EventBuffer();
  private server: Server | null = null;
  private lastPollAt = 0;
  private opts: Required<Omit<PanelServerOptions, 'port'>> & { port: number };

  constructor(options: PanelServerOptions) {
    this.opts = {
      runId: options.runId,
      project: options.project,
      port: options.port ?? 35768,
      holdMs: options.holdMs ?? 25_000,
      gateTimeoutMs: options.gateTimeoutMs ?? 120_000,
      connectedWindowMs: options.connectedWindowMs ?? 10_000,
      now: options.now ?? Date.now,
    };
    this.gates = new GateBroker({ emit: (e) => this.emit(e) }, this.opts.gateTimeoutMs);
  }

  emit(event: PanelEvent): void {
    this.buffer.append(event);
  }

  // Connected = the plugin polled within the recency window. Gating uses this
  // to decide interactive-ask vs. the deny+stop fallback (spec §5).
  isConnected(): boolean {
    return this.opts.now() - this.lastPollAt < this.opts.connectedWindowMs;
  }

  start(): Promise<number> {
    const server = createServer((req, res) => void this.route(req, res));
    this.server = server;
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.opts.port, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : this.opts.port);
      });
    });
  }

  stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return Promise.resolve();
    server.closeAllConnections();
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/api/v1/info') {
        return json(res, 200, { protocol: PROTOCOL_VERSION, runId: this.opts.runId, project: this.opts.project });
      }
      if (req.method === 'GET' && url.pathname === '/api/v1/events') {
        this.lastPollAt = this.opts.now();
        const cursor = Number(url.searchParams.get('cursor') ?? '0') || 0;
        let r = this.buffer.since(cursor);
        if (r.events.length === 0) {
          // Hold until an event lands or the hold expires (empty → re-poll).
          await Promise.race([this.buffer.waitForChange(), sleep(this.opts.holdMs)]);
          r = this.buffer.since(cursor);
        }
        return json(res, 200, r);
      }
      const gateMatch = url.pathname.match(/^\/api\/v1\/gate\/([^/]+)$/);
      if (req.method === 'POST' && gateMatch) {
        const body = await readJson(req);
        const decision = (body as { decision?: unknown })?.decision;
        if (decision !== 'allow' && decision !== 'deny') {
          return json(res, 400, { error: 'decision must be "allow" or "deny"' });
        }
        const ok = this.gates.resolve(gateMatch[1], decision);
        return json(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'unknown gate id' });
      }
      return json(res, 404, { error: 'not found' });
    } catch {
      return json(res, 400, { error: 'bad request' });
    }
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/panel.server.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Run the full suite to catch regressions**

Run: `npm test`
Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/panel/server.ts tests/panel.server.test.ts
git commit -m "feat(panel): local HTTP server with long-poll events and gate endpoint"
```

---

### Task 5: Config — panel section

**Files:**
- Modify: `src/config.ts`
- Test: `tests/config.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `tests/config.test.ts`:

```typescript
describe('panel config', () => {
  it('defaults port and gate timeout', () => {
    const c = loadConfig('/tmp/definitely-missing-blox-config');
    expect(c.panel).toEqual({ port: 35768, gateTimeoutSeconds: 120 });
  });
});
```

(Match the existing import style at the top of the file — `loadConfig` is already imported.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — `expected undefined to deeply equal { port: 35768, ... }`

- [ ] **Step 3: Add the schema field** — in `src/config.ts`, inside `BloxConfigSchema` after the `effort` line:

```typescript
  panel: z
    .object({
      port: z.number().int().positive().default(35768),
      gateTimeoutSeconds: z.number().positive().default(120),
    })
    .default({ port: 35768, gateTimeoutSeconds: 120 }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/config.test.ts tests/buildOptions.test.ts`
Expected: `config.test.ts` PASS. If `buildOptions.test.ts` fails to compile because its inline `BloxConfig` literal now misses `panel`, add `panel: { port: 35768, gateTimeoutSeconds: 120 },` to that literal (and to any other failing config literals — run `npm test` to find them all).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add src/config.ts tests/config.test.ts tests/buildOptions.test.ts
git commit -m "feat(panel): panel.port and panel.gateTimeoutSeconds config"
```

---

### Task 6: runAgent — event sink + dock-denied split

**Files:**
- Modify: `src/agent/runAgent.ts`
- Test: `tests/runAgent.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `tests/runAgent.test.ts`:

```typescript
describe('summarizeResult — dock-denied split', () => {
  it('moves dock-denied tools out of gatedActions into deniedByUser', () => {
    const r = summarizeResult(
      {
        ...base,
        permission_denials: [
          { tool_name: 'mcp__Roblox_Studio__generate_mesh', tool_input: { prompt: 'rock' } },
          { tool_name: 'mcp__Roblox_Studio__start_stop_play', tool_input: {} },
        ],
      },
      ['mcp__Roblox_Studio__start_stop_play'],
    );
    expect(r.gatedActions).toEqual([{ tool: 'mcp__Roblox_Studio__generate_mesh', input: { prompt: 'rock' } }]);
    expect(r.deniedByUser).toEqual(['mcp__Roblox_Studio__start_stop_play']);
    expect(r.stopReason).toBe('gated'); // one denial remains unresolved
  });

  it('does not force gated/error when every denial was a dock decision', () => {
    const r = summarizeResult(
      {
        ...base,
        permission_denials: [{ tool_name: 'mcp__Roblox_Studio__generate_mesh', tool_input: {} }],
      },
      ['mcp__Roblox_Studio__generate_mesh'],
    );
    expect(r.status).toBe('success');
    expect(r.stopReason).toBe('completed');
    expect(r.gatedActions).toEqual([]);
    expect(r.deniedByUser).toEqual(['mcp__Roblox_Studio__generate_mesh']);
  });
});
```

Note: `summarizeResult` is already imported at the top of this test file, and `base` is already defined.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/runAgent.test.ts`
Expected: FAIL — second argument ignored / `deniedByUser` undefined

- [ ] **Step 3: Modify `src/agent/runAgent.ts`** — full new file content:

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { QueryOptionsLike } from './buildOptions.js';
import type { EventSink } from '../panel/events.js';
import { eventsFromMessage } from '../panel/translate.js';

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
  deniedByUser: string[];
}

interface ResultMessageLike {
  subtype: string;
  num_turns: number;
  total_cost_usd: number;
  session_id: string;
  permission_denials?: { tool_name: string; tool_input: Record<string, unknown> }[];
}

// Build the run result from an SDK 'result' message. Denials split two ways:
// dock-denied tools were resolved BY the user (listed informationally, run not
// failed for them); the rest are unresolved gates which override the stop
// reason and force a non-zero status, exactly as before the panel existed.
export function summarizeResult(
  message: ResultMessageLike,
  dockDeniedTools: string[] = [],
): AgentRunResult {
  const remainingDenied = [...dockDeniedTools];
  const gatedActions: GatedAction[] = [];
  const deniedByUser: string[] = [];
  for (const d of message.permission_denials ?? []) {
    const i = remainingDenied.indexOf(d.tool_name);
    if (i >= 0) {
      remainingDenied.splice(i, 1);
      deniedByUser.push(d.tool_name);
    } else {
      gatedActions.push({ tool: d.tool_name, input: d.tool_input });
    }
  }
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
    deniedByUser,
  };
}

export interface RunAgentExtras {
  sink?: EventSink;
  dockDeniedTools?: () => string[];
}

export async function runAgent(
  prompt: string,
  options: QueryOptionsLike,
  extras: RunAgentExtras = {},
): Promise<AgentRunResult> {
  let result: AgentRunResult = {
    numTurns: 0,
    costUsd: 0,
    status: 'error',
    stopReason: 'error',
    detail: 'no result',
    sessionId: null,
    gatedActions: [],
    deniedByUser: [],
  };
  let turns = 0;
  for await (const message of query({ prompt, options: options as never })) {
    if (extras.sink) {
      for (const e of eventsFromMessage(message)) extras.sink.emit(e);
      if (message.type === 'assistant') {
        turns += 1;
        extras.sink.emit({ type: 'status', turns });
      }
    }
    if (message.type === 'result') {
      result = summarizeResult(
        message as unknown as ResultMessageLike,
        extras.dockDeniedTools?.() ?? [],
      );
    }
  }
  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/runAgent.test.ts`
Expected: PASS (old tests still pass — `summarizeResult(base)` with no second arg keeps prior behavior, and `gatedActions`/`deniedByUser` defaults hold)

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all pass (cli.ts compiles unchanged — `extras` is optional)

- [ ] **Step 6: Commit**

```bash
git add src/agent/runAgent.ts tests/runAgent.test.ts
git commit -m "feat(panel): stream events from runAgent and split dock-denied gates"
```

---

### Task 7: permission.ts — interactive gate channel

**Files:**
- Modify: `src/agent/permission.ts`
- Test: `tests/permission.test.ts` (append)

- [ ] **Step 1: Write the failing tests** — append to `tests/permission.test.ts`:

```typescript
import { dockDenyMessage } from '../src/agent/permission.js';

describe('buildCanUseTool — interactive gate channel', () => {
  const gateAllow = {
    isConnected: () => true,
    request: async () => ({ decision: 'allow' as const, source: 'dock' as const }),
  };

  it('allows a gated tool when the dock approves', async () => {
    const cb = buildCanUseTool(gateAllow);
    const r = await cb('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    expect(r.behavior).toBe('allow');
  });

  it('denies with the dock message when the user denies', async () => {
    const cb = buildCanUseTool({
      isConnected: () => true,
      request: async () => ({ decision: 'deny' as const, source: 'dock' as const }),
    });
    const r = await cb('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.message).toBe(dockDenyMessage('mcp__Roblox_Studio__generate_mesh'));
  });

  it('falls back to the stop message on timeout', async () => {
    const cb = buildCanUseTool({
      isConnected: () => true,
      request: async () => ({ decision: 'deny' as const, source: 'timeout' as const }),
    });
    const r = await cb('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    if (r.behavior === 'deny') expect(r.message).toBe(denyMessage('mcp__Roblox_Studio__generate_mesh'));
  });

  it('falls back to the stop message when the dock is not connected', async () => {
    const cb = buildCanUseTool({ ...gateAllow, isConnected: () => false });
    const r = await cb('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    expect(r.behavior).toBe('deny');
    if (r.behavior === 'deny') expect(r.message).toBe(denyMessage('mcp__Roblox_Studio__generate_mesh'));
  });

  it('never consults the channel for non-gated tools', async () => {
    let asked = false;
    const cb = buildCanUseTool({
      isConnected: () => true,
      request: async () => {
        asked = true;
        return { decision: 'deny' as const, source: 'dock' as const };
      },
    });
    const r = await cb('mcp__Roblox_Studio__execute_luau', {}, {} as never);
    expect(r.behavior).toBe('allow');
    expect(asked).toBe(false);
  });
});
```

(Move the `import { dockDenyMessage }` line up to join the existing import block from `'../src/agent/permission.js'`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/permission.test.ts`
Expected: FAIL — `dockDenyMessage` not exported / `buildCanUseTool` takes no argument

- [ ] **Step 3: Modify `src/agent/permission.ts`** — replace `denyMessage` onward with:

```typescript
export function denyMessage(toolName: string): string {
  return `Action "${toolName}" requires approval and is blocked in --ask mode. Do not retry it. Briefly explain what you intended to do with it and why, then stop.`;
}

export function dockDenyMessage(toolName: string): string {
  return `Action "${toolName}" was denied by the user from the Studio panel. Do not retry it. Continue with the rest of the task without it.`;
}

// How the permission callback reaches the panel's gate broker without
// depending on the server: connectivity check + an awaitable decision.
export interface GateChannel {
  isConnected(): boolean;
  request(
    tool: string,
    input: Record<string, unknown>,
  ): Promise<{ decision: 'allow' | 'deny'; source: 'dock' | 'timeout' }>;
}

// Permission callback for --ask. Without a connected dock this is exactly the
// pre-panel behavior: deny with feedback so the agent self-explains and stops.
// With a connected dock the call PAUSES on the gate broker; Allow lets the run
// continue, an explicit user Deny tells the agent to skip the action and keep
// going, and a timeout falls back to the deny+stop path (spec §5, §7).
export function buildCanUseTool(gate?: GateChannel): CanUseTool {
  return async (toolName, input) => {
    if (!isGated(toolName)) return { behavior: 'allow' };
    if (gate?.isConnected()) {
      const d = await gate.request(toolName, (input ?? {}) as Record<string, unknown>);
      if (d.decision === 'allow') return { behavior: 'allow' };
      if (d.source === 'dock') return { behavior: 'deny', message: dockDenyMessage(toolName) };
    }
    return { behavior: 'deny', message: denyMessage(toolName) };
  };
}
```

(Keep `GATED_TOOLS`, `isGated`, `nonGatedAllowedTools` and the file's header comments unchanged. If the SDK's allow result type requires `updatedInput`, mirror whatever the current code returns — it returns plain `{ behavior: 'allow' }` today.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/permission.test.ts`
Expected: PASS (old + 5 new)

- [ ] **Step 5: Commit**

```bash
git add src/agent/permission.ts tests/permission.test.ts
git commit -m "feat(panel): interactive gate channel in the --ask permission callback"
```

---

### Task 8: buildOptions — pass the gate channel through

**Files:**
- Modify: `src/agent/buildOptions.ts`
- Test: `tests/buildOptions.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `tests/buildOptions.test.ts`:

```typescript
import type { GateChannel } from '../src/agent/permission.js';

describe('buildQueryOptions — gate channel', () => {
  it('threads the gate channel into canUseTool in ask mode', async () => {
    let asked = false;
    const gate: GateChannel = {
      isConnected: () => true,
      request: async () => {
        asked = true;
        return { decision: 'allow', source: 'dock' };
      },
    };
    const o = buildQueryOptions(askConfig, createMockStudioBridge(), digest, gate);
    const r = await o.canUseTool!('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    expect(r.behavior).toBe('allow');
    expect(asked).toBe(true);
  });

  it('ignores the gate channel in auto mode', () => {
    const gate: GateChannel = {
      isConnected: () => true,
      request: async () => ({ decision: 'deny', source: 'dock' }),
    };
    const o = buildQueryOptions(config, createMockStudioBridge(), digest, gate);
    expect(o.canUseTool).toBeUndefined();
    expect(o.allowDangerouslySkipPermissions).toBe(true);
  });
});
```

(Hoist the import to the top of the file. `askConfig`, `config`, `digest` already exist in this file; remember `config` literals may need the `panel` field from Task 5.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/buildOptions.test.ts`
Expected: FAIL — `buildQueryOptions` takes 3 arguments / gate never consulted

- [ ] **Step 3: Modify `src/agent/buildOptions.ts`:**

Change the import line for permission:

```typescript
import { buildCanUseTool, nonGatedAllowedTools, type GateChannel } from './permission.js';
```

Change the signature and the `canUseTool` construction:

```typescript
export function buildQueryOptions(
  config: BloxConfig,
  bridge: StudioBridge,
  digest: ProjectDigest,
  gate?: GateChannel,
): QueryOptionsLike {
```

and inside the returned object:

```typescript
    ...(ask
      ? { canUseTool: buildCanUseTool(gate) }
      : { allowDangerouslySkipPermissions: true as const }),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/buildOptions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent/buildOptions.ts tests/buildOptions.test.ts
git commit -m "feat(panel): thread gate channel through query options"
```

---

### Task 9: Report — denied-by-user section

**Files:**
- Modify: `src/report.ts`
- Test: `tests/report.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `tests/report.test.ts` (match the existing fixture style in that file; the base report object there is reused):

```typescript
describe('formatReport — deniedByUser', () => {
  it('lists user-denied actions without the re-run hint', () => {
    const out = formatReport({
      prompt: 'p',
      changedFiles: [],
      commitSha: null,
      numTurns: 1,
      costUsd: 0.1,
      status: 'success',
      deniedByUser: ['mcp__Roblox_Studio__generate_mesh'],
    });
    expect(out).toContain('denied by user:');
    expect(out).toContain('  mcp__Roblox_Studio__generate_mesh');
    expect(out).not.toContain('re-run with --auto');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/report.test.ts`
Expected: FAIL — output lacks `denied by user:`

- [ ] **Step 3: Modify `src/report.ts`:**

Add to `RunReport`:

```typescript
  deniedByUser?: string[];
```

In `formatReport`, after the `gatedActions` block, add:

```typescript
    ...(r.deniedByUser && r.deniedByUser.length
      ? [`denied by user:`, ...r.deniedByUser.map((t) => `  ${t}`)]
      : []),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/report.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/report.ts tests/report.test.ts
git commit -m "feat(panel): report user-denied gate decisions distinctly"
```

---

### Task 10: args — `panel` command

**Files:**
- Modify: `src/args.ts`
- Test: `tests/args.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `tests/args.test.ts`:

```typescript
describe('panel command', () => {
  it('parses "panel install"', () => {
    const a = parseArgs(['panel', 'install']);
    expect(a.command).toBe('panel');
    expect(a.prompt).toBe('install');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/args.test.ts`
Expected: FAIL — `command` is `null`, `prompt` is `'panel install'`

- [ ] **Step 3: Modify `src/args.ts`:**

Widen the command union in `ParsedArgs` and the local variable:

```typescript
  command: 'doctor' | 'serve' | 'init' | 'panel' | null;
```

```typescript
  let command: 'doctor' | 'serve' | 'init' | 'panel' | null = null;
```

Add the parse branch next to the other commands:

```typescript
    else if (a === 'panel' && command === null && positional.length === 0) command = 'panel';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/args.test.ts`
Expected: PASS (the subcommand `install` lands in `prompt` via the existing positional join)

- [ ] **Step 5: Commit**

```bash
git add src/args.ts tests/args.test.ts
git commit -m "feat(panel): parse the panel command"
```

---

### Task 11: Plugin installer

**Files:**
- Create: `src/panel/install.ts`
- Test: `tests/panel.install.test.ts`

`blox panel install` builds the plugin with Rojo and copies the `.rbxm` into the Studio plugins folder. Path resolution: `BLOX_STUDIO_PLUGINS_DIR` override → native Windows `%LOCALAPPDATA%\Roblox\Plugins` → WSL (ask Windows via `cmd.exe`, convert with `wslpath`).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/panel.install.test.ts
import { describe, it, expect } from 'vitest';
import { studioPluginsDir, installPanel } from '../src/panel/install.js';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('studioPluginsDir', () => {
  it('honors the env override', async () => {
    const dir = await studioPluginsDir({ env: { BLOX_STUDIO_PLUGINS_DIR: '/x/plugins' }, platform: 'linux' });
    expect(dir).toBe('/x/plugins');
  });

  it('uses LOCALAPPDATA on native Windows', async () => {
    const dir = await studioPluginsDir({ env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, platform: 'win32' });
    expect(dir).toBe(join('C:\\Users\\me\\AppData\\Local', 'Roblox', 'Plugins'));
  });

  it('asks Windows + wslpath on WSL', async () => {
    const calls: string[][] = [];
    const exec = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === 'cmd.exe') return 'C:\\Users\\me\\AppData\\Local\r\n';
      if (cmd === 'wslpath') return '/mnt/c/Users/me/AppData/Local\n';
      throw new Error(`unexpected ${cmd}`);
    };
    const dir = await studioPluginsDir({ env: {}, platform: 'linux', exec });
    expect(dir).toBe('/mnt/c/Users/me/AppData/Local/Roblox/Plugins');
    expect(calls[0][0]).toBe('cmd.exe');
  });
});

describe('installPanel', () => {
  it('builds via rojo and copies the rbxm into the plugins dir', async () => {
    const work = mkdtempSync(join(tmpdir(), 'blox-install-'));
    const pluginsDir = join(work, 'plugins');
    mkdirSync(pluginsDir);
    let builtTo: string | null = null;
    const exec = async (cmd: string, args: string[]) => {
      if (cmd === 'rojo') {
        builtTo = args[args.indexOf('-o') + 1];
        writeFileSync(builtTo, 'rbxm-bytes');
        return '';
      }
      throw new Error(`unexpected ${cmd}`);
    };
    const dest = await installPanel({
      pluginsDir,
      pluginProjectDir: work, // any dir; rojo is faked
      exec,
    });
    expect(builtTo).not.toBeNull();
    expect(dest).toBe(join(pluginsDir, 'blox-panel.rbxm'));
    expect(existsSync(dest)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/panel.install.test.ts`
Expected: FAIL — `Cannot find module '../src/panel/install.js'`

- [ ] **Step 3: Write the implementation**

```typescript
// src/panel/install.ts
import { execFile } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ExecFn = (cmd: string, args: string[]) => Promise<string>;

const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

export interface PluginsDirOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  exec?: ExecFn;
}

// Resolve the local Studio plugins folder. Order: explicit env override →
// native Windows %LOCALAPPDATA% → WSL (Studio runs on the Windows side, so ask
// Windows where LOCALAPPDATA is and convert to a /mnt path).
export async function studioPluginsDir(opts: PluginsDirOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;

  if (env.BLOX_STUDIO_PLUGINS_DIR) return env.BLOX_STUDIO_PLUGINS_DIR;
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA) throw new Error('LOCALAPPDATA is not set');
    return join(env.LOCALAPPDATA, 'Roblox', 'Plugins');
  }
  // WSL path: cmd.exe prints the Windows value; wslpath converts it.
  const winLocalAppData = (await exec('cmd.exe', ['/c', 'echo %LOCALAPPDATA%'])).trim();
  const unixPath = (await exec('wslpath', ['-u', winLocalAppData])).trim();
  return `${unixPath}/Roblox/Plugins`;
}

export interface InstallOptions {
  pluginsDir: string;
  pluginProjectDir?: string; // dir containing default.project.json
  exec?: ExecFn;
}

// repoRoot/plugin, resolved relative to this module (works from dist/ too:
// dist/panel/install.js → repoRoot/plugin).
export function defaultPluginProjectDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'plugin');
}

// Build the plugin rbxm with rojo and copy it into the Studio plugins folder.
// Returns the destination path.
export async function installPanel(opts: InstallOptions): Promise<string> {
  const exec = opts.exec ?? defaultExec;
  const projectDir = opts.pluginProjectDir ?? defaultPluginProjectDir();
  const out = join(mkdtempSync(join(tmpdir(), 'blox-panel-')), 'blox-panel.rbxm');
  await exec('rojo', ['build', join(projectDir, 'default.project.json'), '-o', out]);
  const dest = join(opts.pluginsDir, 'blox-panel.rbxm');
  copyFileSync(out, dest);
  return dest;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/panel.install.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/panel/install.ts tests/panel.install.test.ts
git commit -m "feat(panel): plugin installer with WSL-aware plugins-dir resolution"
```

---

### Task 12: CLI wiring

**Files:**
- Modify: `src/cli.ts`

No new unit test file — `main()` is not unit-tested today (covered by e2e + the Task 13 integration test). Keep changes minimal and mirror the serve-session pattern.

- [ ] **Step 1: Add imports** to `src/cli.ts`:

```typescript
import { PanelServer } from './panel/server.js';
import { studioPluginsDir, installPanel } from './panel/install.js';
import { randomUUID } from 'node:crypto';
```

- [ ] **Step 2: Add the `panel` command branch** after the `init` branch (before the `if (!prompt)` usage check):

```typescript
  if (command === 'panel') {
    if (prompt !== 'install') {
      console.error('usage: blox panel install');
      process.exit(2);
    }
    try {
      const dir = await studioPluginsDir();
      const dest = await installPanel({ pluginsDir: dir });
      console.log(`blox panel installed → ${dest}`);
      console.log('→ in Studio: Plugins toolbar → blox → blox panel (enable HttpService requests if prompted)');
      process.exit(0);
    } catch (e) {
      console.error(`panel install failed: ${(e as Error).message}`);
      console.error('hint: set BLOX_STUDIO_PLUGINS_DIR to your Studio plugins folder and re-run');
      process.exit(1);
    }
  }
```

- [ ] **Step 3: Start the panel server for real runs.** Replace the run section of `main()` (from `const cwd = projectPath ?? process.cwd();` through the end of the `try/finally`) with:

```typescript
  const cwd = projectPath ?? process.cwd();
  const config = loadConfig(cwd, overridesFromArgs(args));
  const digest = buildDigest(config.projectPath);
  const bridge = mock ? createMockStudioBridge() : createStudioMcpBridge();

  // Panel server: a window into the run for the Studio dock plugin. Never
  // blocks or fails the run — startup errors degrade to a headless run with
  // today's gating behavior. Mock runs skip it (fixed port vs parallel tests).
  const runId = randomUUID();
  let panel: PanelServer | null = null;
  if (!mock) {
    try {
      const p = new PanelServer({
        runId,
        project: digest.name,
        port: config.panel.port,
        gateTimeoutMs: config.panel.gateTimeoutSeconds * 1000,
      });
      await p.start();
      panel = p;
    } catch (e) {
      console.error(`warning: panel server failed to start: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  const gate = panel
    ? {
        isConnected: () => panel!.isConnected(),
        request: (tool: string, input: Record<string, unknown>) => panel!.gates.request(tool, input),
      }
    : undefined;
  const options = buildQueryOptions(config, bridge, digest, gate);

  // Mock runs never touch real Studio/serve. Real runs ensure the rojo serve
  // sync channel is up (reuse-first); a serve failure is non-fatal — the run
  // proceeds but the agent's verify loop may see stale files.
  let session: ServeSession | null = null;
  if (!mock) {
    try {
      session = await ensureServe(config.projectPath);
      if (session.mode === 'spawned') {
        registerServeTeardown(session);
        console.log(`rojo serve up on :${session.port} — click Connect in Studio's Rojo plugin`);
      }
    } catch (e) {
      console.error(`warning: could not start rojo serve: ${(e as Error)?.message ?? String(e)}`);
    }
  }

  try {
    panel?.emit({
      type: 'run_started',
      runId,
      prompt,
      mode: config.mode,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
    });
    const agent = await runAgent(prompt, options, {
      sink: panel ?? undefined,
      dockDeniedTools: panel ? () => panel!.gates.dockDeniedTools() : undefined,
    });
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
      stopReason: agent.stopReason,
      detail: sync.ok ? agent.detail : sync.detail,
      mode: config.mode,
      effort: config.effort,
      sessionId: agent.sessionId,
      gatedActions: agent.gatedActions,
      deniedByUser: agent.deniedByUser,
    };
    panel?.emit({
      type: 'run_finished',
      status: report.status,
      stopReason: agent.stopReason,
      turns: agent.numTurns,
      costUsd: agent.costUsd,
    });
    console.log(formatReport(report));
    process.exitCode = report.status === 'success' ? 0 : 1;
  } finally {
    if (session) await stopServe(session);
    if (panel) await panel.stop();
  }
```

(Note `PanelServer` already satisfies `EventSink` via its `emit` method.)

- [ ] **Step 4: Update the usage line** in the `if (!prompt)` branch to mention the new command:

```typescript
    console.error(
      'usage: blox "<prompt>" [--mock] [--project <dir>] [--auto|--ask] [--max-turns <N>] [--budget <USD>] [--effort high|xhigh]  |  blox doctor  |  blox init [--on-conflict abort|suffix] [--force]  |  blox panel install',
    );
```

- [ ] **Step 5: Build + full suite**

Run: `npm run build && npm test`
Expected: clean compile, all tests pass (mock e2e unaffected — panel skipped under `--mock`)

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts
git commit -m "feat(panel): wire panel server, gate channel, and install command into the CLI"
```

---

### Task 13: Integration test — fake plugin client drives a gated run

**Files:**
- Create: `tests/panel.integration.test.ts`

Exercises the full server-side loop with a fake dock client: long-poll, gate approve resumes the awaiting permission callback, reconnect replays from cursor. No SDK, no Studio.

- [ ] **Step 1: Write the test**

```typescript
// tests/panel.integration.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { PanelServer } from '../src/panel/server.js';
import { buildCanUseTool } from '../src/agent/permission.js';
import type { PanelEvent } from '../src/panel/events.js';

let server: PanelServer | null = null;
afterEach(async () => {
  if (server) await server.stop();
  server = null;
});

// Minimal stand-in for the Luau plugin: poll, collect, decide.
async function pollOnce(base: string, cursor: number): Promise<{ events: PanelEvent[]; cursor: number }> {
  return (await fetch(`${base}/events?cursor=${cursor}`)).json() as Promise<{ events: PanelEvent[]; cursor: number }>;
}

describe('panel integration: gated run with a dock client', () => {
  it('approve from the dock resumes the gated tool call', async () => {
    server = new PanelServer({ runId: 'r', project: 'g', port: 0, holdMs: 50 });
    const port = await server.start();
    const base = `http://127.0.0.1:${port}/api/v1`;

    // plugin connects (marks the dock as present for gating)
    let { cursor } = await pollOnce(base, 0);

    // the agent hits a gated tool via the real permission callback
    const cb = buildCanUseTool({
      isConnected: () => server!.isConnected(),
      request: (tool, input) => server!.gates.request(tool, input),
    });
    const pending = cb('mcp__Roblox_Studio__generate_mesh', { prompt: 'rock' }, {} as never);

    // plugin sees the gate request and approves it
    const r = await pollOnce(base, cursor);
    cursor = r.cursor;
    const gate = r.events.find((e) => e.type === 'gate_request');
    expect(gate).toBeDefined();
    if (gate?.type !== 'gate_request') throw new Error('unreachable');
    const post = await fetch(`${base}/gate/${gate.gateId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'allow' }),
    });
    expect(post.status).toBe(200);

    // the agent's tool call is now allowed
    expect((await pending).behavior).toBe('allow');

    // reconnect from an old cursor replays the resolution event
    const replay = await pollOnce(base, cursor);
    expect(replay.events.some((e) => e.type === 'gate_resolved' && e.decision === 'allow')).toBe(true);
  });

  it('without a connected dock, gating is the classic deny+stop', async () => {
    server = new PanelServer({ runId: 'r', project: 'g', port: 0, holdMs: 50 });
    await server.start();
    // no poll ever happens — isConnected() is false
    const cb = buildCanUseTool({
      isConnected: () => server!.isConnected(),
      request: (tool, input) => server!.gates.request(tool, input),
    });
    const r = await cb('mcp__Roblox_Studio__generate_mesh', {}, {} as never);
    expect(r.behavior).toBe('deny');
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/panel.integration.test.ts`
Expected: PASS — all the pieces already exist; failures here mean an interface drifted between tasks. Fix the drift, not the test.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all pass

- [ ] **Step 4: Commit**

```bash
git add tests/panel.integration.test.ts
git commit -m "test(panel): integration test for dock-approved gated runs"
```

---

### Task 14: Studio plugin (Luau)

**Files:**
- Create: `plugin/default.project.json`
- Create: `plugin/src/init.server.luau`
- Create: `plugin/src/Ui.luau`

No vitest coverage — the plugin is deliberately thin (poll + render). Verified by `rojo build` succeeding (syntax/structure) and the Task 15 manual smoke.

- [ ] **Step 1: Create `plugin/default.project.json`**

```json
{
  "name": "blox-panel",
  "tree": {
    "$path": "src"
  }
}
```

- [ ] **Step 2: Create `plugin/src/Ui.luau`** — dumb construction, no logic:

```lua
-- Builds the dock widget UI and returns references. No logic lives here.
local Ui = {}

local function label(parent: Instance, name: string, order: number): TextLabel
	local l = Instance.new("TextLabel")
	l.Name = name
	l.LayoutOrder = order
	l.Size = UDim2.new(1, -8, 0, 18)
	l.BackgroundTransparency = 1
	l.TextXAlignment = Enum.TextXAlignment.Left
	l.TextColor3 = Color3.fromRGB(204, 204, 204)
	l.TextSize = 14
	l.Font = Enum.Font.Code
	l.TextTruncate = Enum.TextTruncate.AtEnd
	l.Parent = parent
	return l
end

function Ui.build(widget: DockWidgetPluginGui)
	local root = Instance.new("Frame")
	root.Size = UDim2.fromScale(1, 1)
	root.BackgroundColor3 = Color3.fromRGB(36, 36, 36)
	root.Parent = widget

	local layout = Instance.new("UIListLayout")
	layout.SortOrder = Enum.SortOrder.LayoutOrder
	layout.Padding = UDim.new(0, 4)
	layout.Parent = root

	local status = label(root, "Status", 1)
	status.Text = "disconnected — run blox to start"
	status.TextColor3 = Color3.fromRGB(255, 170, 0)

	-- Gate card: hidden until a gate_request arrives.
	local gate = Instance.new("Frame")
	gate.Name = "Gate"
	gate.LayoutOrder = 2
	gate.Size = UDim2.new(1, -8, 0, 76)
	gate.BackgroundColor3 = Color3.fromRGB(60, 50, 20)
	gate.Visible = false
	gate.Parent = root

	local gateText = label(gate, "GateText", 1)
	gateText.Position = UDim2.fromOffset(4, 4)
	gateText.Size = UDim2.new(1, -8, 0, 36)
	gateText.TextWrapped = true
	gateText.TextTruncate = Enum.TextTruncate.None

	local function button(name: string, x: number, color: Color3): TextButton
		local b = Instance.new("TextButton")
		b.Name = name
		b.Text = name
		b.Position = UDim2.new(0, x, 1, -30)
		b.Size = UDim2.fromOffset(80, 24)
		b.BackgroundColor3 = color
		b.TextColor3 = Color3.fromRGB(255, 255, 255)
		b.Parent = gate
		return b
	end
	local allow = button("Allow", 4, Color3.fromRGB(40, 120, 40))
	local deny = button("Deny", 92, Color3.fromRGB(140, 40, 40))

	-- Diff list + log share a scrolling frame each.
	local function scroller(name: string, order: number, heightScale: number): (ScrollingFrame, UIListLayout)
		local s = Instance.new("ScrollingFrame")
		s.Name = name
		s.LayoutOrder = order
		s.Size = UDim2.new(1, -8, heightScale, -8)
		s.CanvasSize = UDim2.new()
		s.AutomaticCanvasSize = Enum.AutomaticSize.Y
		s.BackgroundColor3 = Color3.fromRGB(28, 28, 28)
		s.BorderSizePixel = 0
		s.ScrollBarThickness = 6
		s.Parent = root
		local ll = Instance.new("UIListLayout")
		ll.SortOrder = Enum.SortOrder.LayoutOrder
		ll.Parent = s
		return s, ll
	end
	local diffs = scroller("Diffs", 3, 0.25)
	local log = scroller("Log", 4, 0.6)

	return {
		status = status,
		gate = gate,
		gateText = gateText,
		allowButton = allow,
		denyButton = deny,
		diffs = diffs,
		log = log,
		addLine = function(parent: ScrollingFrame, text: string, order: number)
			label(parent, "Line" .. order, order).Text = text
		end,
	}
end

return Ui
```

- [ ] **Step 3: Create `plugin/src/init.server.luau`** — poll loop + event handling:

```lua
-- blox dock panel: a thin window into a local blox CLI run (spec §3.2).
-- Poll + render only; all real logic lives CLI-side.
local HttpService = game:GetService("HttpService")
local Ui = require(script.Ui)

local PROTOCOL = 1
local PORT = 35768 -- keep in sync with blox.config.json panel.port
local BASE = "http://127.0.0.1:" .. PORT .. "/api/v1"
local MAX_LINES = 200

local toolbar = plugin:CreateToolbar("blox")
local button = toolbar:CreateButton("blox panel", "Show the blox run panel", "")
local widgetInfo = DockWidgetPluginGuiInfo.new(Enum.InitialDockState.Right, false, false, 320, 480, 240, 320)
local widget = plugin:CreateDockWidgetPluginGui("BloxPanel", widgetInfo)
widget.Title = "blox"
button.Click:Connect(function()
	widget.Enabled = not widget.Enabled
end)

local ui = Ui.build(widget)

local function request(method: string, path: string, body: { [string]: any }?): { [string]: any }?
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = BASE .. path,
			Method = method,
			Headers = { ["Content-Type"] = "application/json" },
			Body = if body then HttpService:JSONEncode(body) else nil,
		})
	end)
	if not ok then
		return nil -- server down, HttpService disabled, or request blocked
	end
	if not res.Success then
		return nil
	end
	local decoded
	ok, decoded = pcall(HttpService.JSONDecode, HttpService, res.Body)
	return if ok then decoded else nil
end

local logOrder = 0
local diffOrder = 0
local activeGateId: string? = nil

local function addLog(text: string)
	logOrder += 1
	if logOrder > MAX_LINES then
		local oldest = ui.log:FindFirstChild("Line" .. (logOrder - MAX_LINES))
		if oldest then
			oldest:Destroy()
		end
	end
	ui.addLine(ui.log, text, logOrder)
end

local function handleEvent(e: { [string]: any })
	if e.type == "run_started" then
		ui.status.Text = ("run %s — %s mode"):format(e.runId, e.mode)
		ui.status.TextColor3 = Color3.fromRGB(120, 200, 120)
		addLog("▶ " .. e.prompt)
	elseif e.type == "status" then
		ui.status.Text = ("running — turn %d"):format(e.turns)
	elseif e.type == "log" then
		addLog(e.text)
	elseif e.type == "file_diff" then
		diffOrder += 1
		ui.addLine(ui.diffs, ("%s  +%d −%d"):format(e.path, e.added, e.removed), diffOrder)
	elseif e.type == "gate_request" then
		activeGateId = e.gateId
		ui.gateText.Text = ("Approve %s?\n%s"):format(e.tool, e.inputSummary)
		ui.gate.Visible = true
	elseif e.type == "gate_resolved" then
		if e.gateId == activeGateId then
			ui.gate.Visible = false
			activeGateId = nil
		end
		addLog(("gate %s — %s (%s)"):format(e.gateId:sub(1, 8), e.decision, e.source))
	elseif e.type == "run_finished" then
		ui.status.Text = ("%s — %d turns, $%.4f"):format(e.status, e.turns, e.costUsd)
		ui.status.TextColor3 = if e.status == "success"
			then Color3.fromRGB(120, 200, 120)
			else Color3.fromRGB(220, 120, 120)
	end
end

local function decide(decision: string)
	if activeGateId then
		request("POST", "/gate/" .. activeGateId, { decision = decision })
		ui.gate.Visible = false
	end
end
ui.allowButton.MouseButton1Click:Connect(function()
	decide("allow")
end)
ui.denyButton.MouseButton1Click:Connect(function()
	decide("deny")
end)

-- Poll loop. The server long-polls (~25s) so a healthy loop is mostly idle.
task.spawn(function()
	local cursor = 0
	local announced = false
	while true do
		if not widget.Enabled then
			task.wait(1)
			continue
		end
		if not announced then
			local info = request("GET", "/info")
			if info then
				announced = true
				if info.protocol ~= PROTOCOL then
					addLog("⚠ blox CLI speaks protocol " .. tostring(info.protocol) .. " — update this plugin")
				end
				ui.status.Text = "connected — " .. tostring(info.project)
				ui.status.TextColor3 = Color3.fromRGB(120, 200, 120)
			end
		end
		local data = request("GET", "/events?cursor=" .. cursor)
		if data then
			cursor = data.cursor
			for _, e in data.events do
				handleEvent(e)
			end
		else
			if announced then
				ui.status.Text = "disconnected — run blox to start"
				ui.status.TextColor3 = Color3.fromRGB(255, 170, 0)
			end
			announced = false
			task.wait(2)
		end
	end
end)
```

- [ ] **Step 4: Verify the plugin builds**

Run: `rojo build plugin/default.project.json -o /tmp/blox-panel.rbxm && ls -la /tmp/blox-panel.rbxm`
Expected: file produced, non-zero size. (This also syntax-checks the Luau via Rojo's parser for the project structure; Luau syntax itself is checked in Studio — keep the code simple.)

- [ ] **Step 5: Commit**

```bash
git add plugin/
git commit -m "feat(panel): Luau dock widget plugin — poll, render, gate buttons"
```

---

### Task 15: Docs + manual live smoke

**Files:**
- Modify: `README.md`
- Modify: `docs/superpowers/specs/2026-06-11-blox-pivot-p1-studio-dock-panel-design.md` (status line only)

- [ ] **Step 1: Add a README section** after the "Live Studio sync (manual)" section:

```markdown
## Studio dock panel

Watch and steer a run from inside Studio. One-time setup:

```bash
blox panel install        # builds the plugin and copies it into Studio's plugins folder
```

Then in Studio: Plugins toolbar → **blox** → **blox panel**. Allow HTTP requests
when prompted (the panel talks to the local CLI on `127.0.0.1:35768`; override
with `panel.port` in `blox.config.json`).

With the panel open, `--ask` becomes interactive: gated actions (asset
generation, play mode, input sim) pause the run and show an Allow/Deny card in
the dock. Allow resumes the run; Deny tells the agent to continue without that
action. Without the panel, `--ask` behaves as before (blocked actions stop the
run). Gates time out after `panel.gateTimeoutSeconds` (default 120) back to the
stop behavior.

If the panel can't reach the CLI on WSL, check Windows↔WSL localhost forwarding
and set `BLOX_STUDIO_PLUGINS_DIR` if `panel install` can't find your plugins
folder.
```

- [ ] **Step 2: Manual live smoke (requires Studio; cannot be automated here).** Checklist to run and record results in the commit message:

1. `npm run build && blox panel install` (or `node dist/cli.js panel install`)
2. Open the fixture place in Studio, enable the blox panel dock, allow HTTP.
3. `node dist/cli.js --ask --project <game> "insert a generated rock mesh near spawn"`
4. Verify: dock shows connected → run_started → log lines stream → gate card appears for `generate_mesh` → click Allow → run resumes → run_finished summary shows.
5. Re-run and click Deny → report lists the tool under `denied by user:` and exit code is 0 when the rest of the task succeeded.
6. Kill the CLI mid-run → dock returns to "disconnected" within ~2 polls.

- [ ] **Step 3: Update spec status line** to `**Status:** Implemented (P1)` once the smoke passes.

- [ ] **Step 4: Run the full suite one last time**

Run: `npm run build && npm test`
Expected: clean compile, all tests pass

- [ ] **Step 5: Commit**

```bash
git add README.md docs/superpowers/specs/2026-06-11-blox-pivot-p1-studio-dock-panel-design.md
git commit -m "docs(panel): README dock panel section; record live smoke results"
```

---

## Self-review checklist (run after writing, before execution)

- **Spec coverage:** §3.1 server → Tasks 4, 5, 12. §3.2 plugin → Tasks 11, 14. §4 protocol → Tasks 1, 4. §5 agent integration → Tasks 6, 7, 8. §6 data flow → Tasks 12, 13. §7 error handling → Tasks 4 (400/404), 7 (fallbacks), 12 (warn-and-continue), 14 (disconnect/protocol hint). §8 testing → unit Tasks 1–11, integration Task 13, live smoke Task 15. §9 scope cuts respected (no hunks, no dock prompt input, no auth).
- **Known deviation:** spec §8 names a `BLOX_LIVE_PANEL=1` gated test; the gate flow needs a human clicking a Studio button, so it is delivered as the Task 15 manual checklist instead. Revisit automation in P2 alongside input-sim-driven UI clicks.
- **Type consistency:** `PanelEvent` (Task 1) is consumed by Tasks 2, 3, 4, 6, 13, 14. `GateChannel` defined in Task 7, used in Tasks 8, 12, 13. `dockDeniedTools(): string[]` on `GateBroker` (Task 2) feeds `summarizeResult(message, dockDeniedTools)` (Task 6) via `RunAgentExtras` (Task 12).
