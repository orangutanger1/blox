# P5-b Usage Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the committed `.blox/audit.jsonl` ledger as a human-readable usage report — per-user / per-model / rolling-window cost attribution — in the CLI (`blox report`), the panel HTTP endpoint, and the Electron desktop app.

**Architecture:** One pure module (`src/usageReport.ts`) owns a single `UsageSummary` shape plus `aggregateUsage`/`renderUsageTable`/`reportOutput`. The ledger parser is extracted from `src/audit.ts` so there is one reader. Four consumers share the shape: CLI table, `--json`, `GET /api/v1/usage`, and the renderer. The same shape is the future hosted-relay (P5-c) payload.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import specifiers), vitest, Zod (config), Node stdlib `http`/`fs`. No new dependencies.

## Global Constraints

- **No new dependencies** — stdlib `fs` + `JSON` + `http` only.
- **ESM import specifiers end in `.js`** (e.g. `import { aggregateUsage } from './usageReport.js'`), even for `.ts` sources — NodeNext.
- **Money formatted to 2 decimals** in all human output.
- **Local-only** — the panel server binds `127.0.0.1`; do not change that.
- **Back-compat** — `readWindowSpend` behavior must not change; existing P5-a tests in `tests/audit.test.ts`, `tests/policy.surface.test.ts` must stay green.
- **Reject-not-clamp is P5-a's concern**, not this slice — the report never enforces, only reports.
- **Tests:** engine tests run from repo root with `npm test` (`vitest run`); app tests run from `app/` with `npm test`.
- `src/report.ts` is the per-*run* `RunReport` — **do not** put usage code there; the new module is `src/usageReport.ts`.
- AuditEntry fields (from `src/audit.ts`): `ts, user, model, turns, costUsd, status, commit, prompt, stopReason?`.

---

### Task 1: Extract `readAuditEntries` from `src/audit.ts`

**Files:**
- Modify: `src/audit.ts`
- Test: `tests/audit.test.ts`

**Interfaces:**
- Consumes: existing `AuditEntry`, `appendAuditEntry`, `auditPath`.
- Produces: `readAuditEntries(projectPath: string): AuditEntry[]` — returns `[]` for a missing file, skips malformed lines. `readWindowSpend` keeps its current signature and behavior.

- [ ] **Step 1: Write the failing test**

Add to `tests/audit.test.ts` (it already imports from `../src/audit.js` and has the `entry()` helper):

```ts
import { appendAuditEntry, readWindowSpend, readAuditEntries, auditPath, type AuditEntry } from '../src/audit.js';

describe('readAuditEntries', () => {
  it('returns [] when the ledger is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    expect(readAuditEntries(dir)).toEqual([]);
  });

  it('parses good lines and skips malformed ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    appendAuditEntry(dir, entry({ costUsd: 1 }));
    appendFileSync(auditPath(dir), 'not json\n');
    appendAuditEntry(dir, entry({ costUsd: 2 }));
    const got = readAuditEntries(dir);
    expect(got.map((e) => e.costUsd)).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/audit.test.ts`
Expected: FAIL — `readAuditEntries is not a function` / not exported.

- [ ] **Step 3: Add `readAuditEntries` and refactor `readWindowSpend` to use it**

In `src/audit.ts`, add the reader and make `readWindowSpend` consume it (one parser):

```ts
export function readAuditEntries(projectPath: string): AuditEntry[] {
  const path = auditPath(projectPath);
  if (!existsSync(path)) return [];
  const out: AuditEntry[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip malformed line — visibility is best-effort
    }
  }
  return out;
}

export function readWindowSpend(projectPath: string, windowDays: number, now: Date = new Date()): number {
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  let sum = 0;
  for (const e of readAuditEntries(projectPath)) {
    const t = Date.parse(e.ts);
    if (!Number.isNaN(t) && t >= cutoff && typeof e.costUsd === 'number') sum += e.costUsd;
  }
  return sum;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/audit.test.ts`
Expected: PASS — new `readAuditEntries` tests plus all existing `readWindowSpend` tests.

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts tests/audit.test.ts
git commit -m "refactor(audit): extract readAuditEntries, reuse in readWindowSpend"
```

---

### Task 2: `aggregateUsage` + types in `src/usageReport.ts`

**Files:**
- Create: `src/usageReport.ts`
- Test: `tests/usageReport.test.ts`

**Interfaces:**
- Consumes: `AuditEntry` from `./audit.js`.
- Produces:
  ```ts
  export interface UsageBucket { key: string; costUsd: number; runs: number }
  export interface UsageSummary {
    window: { days: number | null; since: string | null };
    totalUsd: number;
    capUsd: number | null;
    capPct: number | null;
    runCount: number;
    errorCount: number;
    byUser: UsageBucket[];
    byModel: UsageBucket[];
  }
  export function aggregateUsage(
    entries: AuditEntry[],
    opts: { now: Date; windowDays?: number | null; capUsd?: number | null },
  ): UsageSummary;
  ```

- [ ] **Step 1: Write the failing test**

Create `tests/usageReport.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { aggregateUsage } from '../src/usageReport.js';
import type { AuditEntry } from '../src/audit.js';

function e(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-06-23T12:00:00Z',
    user: 'dev@example.com',
    model: 'claude-opus-4-8',
    turns: 3,
    costUsd: 1,
    status: 'success',
    commit: 'abc1234',
    prompt: 'p',
    ...over,
  };
}
const now = new Date('2026-06-24T12:00:00Z');

describe('aggregateUsage', () => {
  it('sums cost, counts runs and errors, buckets by user and model', () => {
    const s = aggregateUsage(
      [
        e({ user: 'a@x.com', model: 'claude-opus-4-8', costUsd: 2 }),
        e({ user: 'b@x.com', model: 'claude-opus-4-8', costUsd: 3 }),
        e({ user: 'a@x.com', model: 'claude-sonnet-4-6', costUsd: 1, status: 'error' }),
      ],
      { now, windowDays: null, capUsd: null },
    );
    expect(s.totalUsd).toBe(6);
    expect(s.runCount).toBe(3);
    expect(s.errorCount).toBe(1);
    expect(s.byUser).toEqual([
      { key: 'a@x.com', costUsd: 3, runs: 2 },
      { key: 'b@x.com', costUsd: 3, runs: 1 },
    ]);
    expect(s.byModel[0]).toEqual({ key: 'claude-opus-4-8', costUsd: 5, runs: 2 });
  });

  it('windows by ts: drops out-of-window and unparseable ts when windowed', () => {
    const s = aggregateUsage(
      [
        e({ ts: '2026-06-23T12:00:00Z', costUsd: 5 }), // 1 day ago — in
        e({ ts: '2026-05-01T12:00:00Z', costUsd: 9 }), // >30 days — out
        e({ ts: 'garbage', costUsd: 99 }),             // unparseable — out when windowed
      ],
      { now, windowDays: 30, capUsd: null },
    );
    expect(s.totalUsd).toBe(5);
    expect(s.runCount).toBe(1);
    expect(s.window).toEqual({ days: 30, since: '2026-05-25T12:00:00.000Z' });
  });

  it('keeps unparseable ts in an all-time report', () => {
    const s = aggregateUsage([e({ ts: 'garbage', costUsd: 7 })], { now, windowDays: null, capUsd: null });
    expect(s.totalUsd).toBe(7);
    expect(s.window).toEqual({ days: null, since: null });
  });

  it('buckets missing user/model under (unknown) and treats non-number cost as 0', () => {
    const s = aggregateUsage(
      [e({ user: '', model: undefined as unknown as string, costUsd: undefined as unknown as number })],
      { now, windowDays: null, capUsd: null },
    );
    expect(s.totalUsd).toBe(0);
    expect(s.byUser).toEqual([{ key: '(unknown)', costUsd: 0, runs: 1 }]);
    expect(s.byModel).toEqual([{ key: '(unknown)', costUsd: 0, runs: 1 }]);
  });

  it('computes capPct when a cap is set, null otherwise', () => {
    const withCap = aggregateUsage([e({ costUsd: 50 })], { now, windowDays: null, capUsd: 200 });
    expect(withCap.capUsd).toBe(200);
    expect(withCap.capPct).toBeCloseTo(0.25);
    const noCap = aggregateUsage([e({ costUsd: 50 })], { now, windowDays: null, capUsd: null });
    expect(noCap.capPct).toBeNull();
  });

  it('returns an empty summary for no entries', () => {
    const s = aggregateUsage([], { now, windowDays: 30, capUsd: 200 });
    expect(s).toMatchObject({ totalUsd: 0, runCount: 0, errorCount: 0, byUser: [], byModel: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/usageReport.test.ts`
Expected: FAIL — `Cannot find module '../src/usageReport.js'`.

- [ ] **Step 3: Write `src/usageReport.ts`**

```ts
import type { AuditEntry } from './audit.js';

export interface UsageBucket {
  key: string;
  costUsd: number;
  runs: number;
}

export interface UsageSummary {
  window: { days: number | null; since: string | null };
  totalUsd: number;
  capUsd: number | null;
  capPct: number | null;
  runCount: number;
  errorCount: number;
  byUser: UsageBucket[];
  byModel: UsageBucket[];
}

function bucketsOf(entries: { key: string; cost: number }[]): UsageBucket[] {
  const m = new Map<string, UsageBucket>();
  for (const { key, cost } of entries) {
    const b = m.get(key) ?? { key, costUsd: 0, runs: 0 };
    b.costUsd += cost;
    b.runs += 1;
    m.set(key, b);
  }
  // cost desc, then key asc for a stable order
  return [...m.values()].sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
}

export function aggregateUsage(
  entries: AuditEntry[],
  opts: { now: Date; windowDays?: number | null; capUsd?: number | null },
): UsageSummary {
  const windowDays = opts.windowDays ?? null;
  const capUsd = opts.capUsd ?? null;
  const cutoff = windowDays != null ? opts.now.getTime() - windowDays * 24 * 60 * 60 * 1000 : null;

  const inWindow = entries.filter((e) => {
    if (cutoff == null) return true; // all-time keeps everything, even unparseable ts
    const t = Date.parse(e.ts);
    return !Number.isNaN(t) && t >= cutoff;
  });

  const cost = (e: AuditEntry) => (typeof e.costUsd === 'number' ? e.costUsd : 0);
  const totalUsd = inWindow.reduce((s, e) => s + cost(e), 0);

  return {
    window: { days: windowDays, since: cutoff != null ? new Date(cutoff).toISOString() : null },
    totalUsd,
    capUsd,
    capPct: capUsd ? totalUsd / capUsd : null,
    runCount: inWindow.length,
    errorCount: inWindow.filter((e) => e.status === 'error').length,
    byUser: bucketsOf(inWindow.map((e) => ({ key: e.user || '(unknown)', cost: cost(e) }))),
    byModel: bucketsOf(inWindow.map((e) => ({ key: e.model || '(unknown)', cost: cost(e) }))),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/usageReport.test.ts`
Expected: PASS — all 6 cases.

- [ ] **Step 5: Commit**

```bash
git add src/usageReport.ts tests/usageReport.test.ts
git commit -m "feat(report): aggregateUsage + UsageSummary shape"
```

---

### Task 3: `renderUsageTable`

**Files:**
- Modify: `src/usageReport.ts`
- Test: `tests/usageReport.test.ts`

**Interfaces:**
- Consumes: `UsageSummary` (Task 2).
- Produces: `renderUsageTable(s: UsageSummary): string` — plain text, money to 2 decimals, ASCII spend bar only when `capUsd` is set.

- [ ] **Step 1: Write the failing test**

Append to `tests/usageReport.test.ts`:

```ts
import { renderUsageTable } from '../src/usageReport.js';

describe('renderUsageTable', () => {
  it('shows used/cap with a percent when a cap is set', () => {
    const out = renderUsageTable(
      aggregateUsage([e({ user: 'a@x.com', costUsd: 142.3 })], { now, windowDays: 30, capUsd: 200 }),
    );
    expect(out).toContain('$142.30');
    expect(out).toContain('$200.00');
    expect(out).toContain('71%');
    expect(out).toContain('a@x.com');
  });

  it('omits the cap line when there is no cap', () => {
    const out = renderUsageTable(
      aggregateUsage([e({ costUsd: 5 })], { now, windowDays: null, capUsd: null }),
    );
    expect(out).toContain('$5.00');
    expect(out).not.toContain('cap');
  });

  it('renders an empty ledger without throwing', () => {
    expect(() => renderUsageTable(aggregateUsage([], { now, windowDays: 30, capUsd: 200 }))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/usageReport.test.ts`
Expected: FAIL — `renderUsageTable is not a function`.

- [ ] **Step 3: Implement `renderUsageTable` in `src/usageReport.ts`**

```ts
const usd = (n: number) => `$${n.toFixed(2)}`;

function bar(pct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function renderUsageTable(s: UsageSummary): string {
  const lines: string[] = [];
  const win = s.window.days != null ? `last ${s.window.days}d` : 'all time';
  lines.push(`blox usage — ${win}`);
  if (s.capUsd != null && s.capPct != null) {
    const pct = Math.round(s.capPct * 100);
    lines.push(`  used ${usd(s.totalUsd)} / cap ${usd(s.capUsd)}  ${bar(s.capPct)}  ${pct}%`);
  } else {
    lines.push(`  used ${usd(s.totalUsd)}`);
  }
  lines.push('');
  lines.push('By user');
  for (const b of s.byUser) lines.push(`  ${b.key}  ${usd(b.costUsd)}  ${b.runs} runs`);
  lines.push('');
  lines.push('By model');
  for (const b of s.byModel) lines.push(`  ${b.key}  ${usd(b.costUsd)}`);
  lines.push('');
  lines.push(`${s.runCount} runs, ${s.errorCount} errors in window`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/usageReport.test.ts`
Expected: PASS. (Note: `142.3/200 = 0.7115` → `Math.round(0.7115*100)=71`.)

- [ ] **Step 5: Commit**

```bash
git add src/usageReport.ts tests/usageReport.test.ts
git commit -m "feat(report): renderUsageTable terminal output"
```

---

### Task 4: `reportOutput` — window/cap defaulting + json switch

**Files:**
- Modify: `src/usageReport.ts`
- Test: `tests/usageReport.test.ts`

**Interfaces:**
- Consumes: `aggregateUsage`, `renderUsageTable`, `AuditEntry`.
- Produces:
  ```ts
  export function reportOutput(
    entries: AuditEntry[],
    opts: {
      now: Date;
      sinceDays?: number | null;
      rollingBudget?: { windowDays: number; maxUsd: number } | null;
      json?: boolean;
    },
  ): string;
  ```
  Window = `sinceDays ?? rollingBudget?.windowDays ?? null`; cap = `rollingBudget?.maxUsd ?? null`. `json` → `JSON.stringify(summary, null, 2)`, else the table.

- [ ] **Step 1: Write the failing test**

Append to `tests/usageReport.test.ts`:

```ts
import { reportOutput } from '../src/usageReport.js';

describe('reportOutput', () => {
  const rolling = { windowDays: 30, maxUsd: 200 };

  it('defaults the window+cap from rollingBudget', () => {
    const out = reportOutput([e({ costUsd: 10 })], { now, rollingBudget: rolling });
    expect(out).toContain('last 30d');
    expect(out).toContain('cap $200.00');
  });

  it('lets --since override the rolling window', () => {
    const out = reportOutput([e({ costUsd: 10 })], { now, sinceDays: 7, rollingBudget: rolling });
    expect(out).toContain('last 7d');
  });

  it('emits parseable JSON of the summary when json is set', () => {
    const out = reportOutput([e({ user: 'a@x.com', costUsd: 4 })], { now, rollingBudget: rolling, json: true });
    const parsed = JSON.parse(out);
    expect(parsed.totalUsd).toBe(4);
    expect(parsed.byUser[0].key).toBe('a@x.com');
  });

  it('all-time when neither sinceDays nor rollingBudget is given', () => {
    const out = reportOutput([e({ costUsd: 1 })], { now });
    expect(out).toContain('all time');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/usageReport.test.ts`
Expected: FAIL — `reportOutput is not a function`.

- [ ] **Step 3: Implement `reportOutput` in `src/usageReport.ts`**

```ts
export function reportOutput(
  entries: AuditEntry[],
  opts: {
    now: Date;
    sinceDays?: number | null;
    rollingBudget?: { windowDays: number; maxUsd: number } | null;
    json?: boolean;
  },
): string {
  const windowDays = opts.sinceDays ?? opts.rollingBudget?.windowDays ?? null;
  const capUsd = opts.rollingBudget?.maxUsd ?? null;
  const summary = aggregateUsage(entries, { now: opts.now, windowDays, capUsd });
  return opts.json ? JSON.stringify(summary, null, 2) : renderUsageTable(summary);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/usageReport.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/usageReport.ts tests/usageReport.test.ts
git commit -m "feat(report): reportOutput window/cap defaulting + --json switch"
```

---

### Task 5: args — `report` command + `--since` + `--json`

**Files:**
- Modify: `src/args.ts`
- Test: `tests/args.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ParsedArgs.command` gains `'report'`; `ParsedArgs` gains `since: number | null` and `json: boolean`. `--since <Nd>` parses to a positive integer day count (accepts a trailing `d`); non-positive/invalid throws. `--json` sets the flag.

- [ ] **Step 1: Write the failing test**

Append to `tests/args.test.ts`:

```ts
describe('report subcommand', () => {
  it('parses the report command with defaults', () => {
    const a = parseArgs(['report']);
    expect(a.command).toBe('report');
    expect(a.since).toBeNull();
    expect(a.json).toBe(false);
  });

  it('parses --since (with or without a trailing d) and --json', () => {
    expect(parseArgs(['report', '--since', '7d']).since).toBe(7);
    expect(parseArgs(['report', '--since', '30']).since).toBe(30);
    expect(parseArgs(['report', '--json']).json).toBe(true);
  });

  it('rejects a non-positive --since', () => {
    expect(() => parseArgs(['report', '--since', '0'])).toThrow(/--since/);
    expect(() => parseArgs(['report', '--since', 'abc'])).toThrow(/--since/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/args.test.ts`
Expected: FAIL — `since`/`json` undefined, `command` not `'report'`.

- [ ] **Step 3: Implement in `src/args.ts`**

In the `command` union (both the `interface ParsedArgs` and the local `let command` declaration) add `| 'report'`. Add two fields to `ParsedArgs`: `since: number | null;` and `json: boolean;`. In the parse loop declare `let since: number | null = null;` and `let json = false;`, and add cases:

```ts
    else if (a === '--since') {
      const raw = argv[++i];
      const n = Number(String(raw ?? '').replace(/d$/, ''));
      if (!Number.isInteger(n) || n <= 0) throw new Error('--since must be a positive integer number of days (e.g. 7 or 7d)');
      since = n;
    } else if (a === '--json') json = true;
    else if (a === 'report' && command === null && positional.length === 0) command = 'report';
```

Add `since,` and `json,` to the returned object.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/args.test.ts`
Expected: PASS — new cases plus all existing arg tests.

- [ ] **Step 5: Commit**

```bash
git add src/args.ts tests/args.test.ts
git commit -m "feat(cli): parse the report command with --since and --json"
```

---

### Task 6: Wire `blox report` into `src/cli.ts`

**Files:**
- Modify: `src/cli.ts`
- Test: `tests/cli.report.test.ts` (create)

**Interfaces:**
- Consumes: `reportOutput` (Task 4), `readAuditEntries` (Task 1), `loadConfig`, `ParsedArgs.{since,json}` (Task 5).
- Produces: a `command === 'report'` branch that prints the report and exits 0. The branch is thin; the testable core (`reportOutput`) is already covered, so the test here is a small end-to-end check that the branch reads the ledger and honors `--json` against a temp project.

- [ ] **Step 1: Write the failing test**

`cli.ts` runs `main()` on import and calls `process.exit`, so test the command by spawning the built CLI is heavy. Instead, extract the branch body into a tiny exported helper and test that. Create `tests/cli.report.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReport } from '../src/cli.js';
import { appendAuditEntry } from '../src/audit.js';

describe('runReport', () => {
  it('reads the project ledger and renders a table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    appendAuditEntry(dir, {
      ts: new Date().toISOString(), user: 'a@x.com', model: 'claude-opus-4-8',
      turns: 1, costUsd: 3, status: 'success', commit: null, prompt: 'p',
    });
    const out = runReport({ projectPath: dir, since: null, json: false, now: new Date() });
    expect(out).toContain('a@x.com');
    expect(out).toContain('$3.00');
  });

  it('honors --json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    appendAuditEntry(dir, {
      ts: new Date().toISOString(), user: 'a@x.com', model: 'm',
      turns: 1, costUsd: 2, status: 'success', commit: null, prompt: 'p',
    });
    const out = runReport({ projectPath: dir, since: null, json: true, now: new Date() });
    expect(JSON.parse(out).totalUsd).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/cli.report.test.ts`
Expected: FAIL — `runReport` is not exported from `../src/cli.js`.

- [ ] **Step 3: Add `runReport` and the command branch in `src/cli.ts`**

Add imports near the other `./` imports:

```ts
import { reportOutput } from './usageReport.js';
import { readAuditEntries } from './audit.js';
```

Add an exported helper (place it above `async function main()`):

```ts
export function runReport(opts: {
  projectPath: string;
  since: number | null;
  json: boolean;
  now?: Date;
}): string {
  const config = loadConfig(opts.projectPath, { projectPath: opts.projectPath });
  return reportOutput(readAuditEntries(config.projectPath), {
    now: opts.now ?? new Date(),
    sinceDays: opts.since,
    rollingBudget: config.policy?.rollingBudget ?? null,
    json: opts.json,
  });
}
```

Add the branch inside `main()`, alongside the other `if (command === …)` blocks (e.g. right after the `doctor` block):

```ts
  if (command === 'report') {
    console.log(runReport({ projectPath: projectPath ?? process.cwd(), since: args.since, json: args.json }));
    process.exit(0);
  }
```

(Note: `args.since`/`args.json` — `since`/`json` aren't destructured from `args` at the top of `main`, so reference them via `args.`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/cli.report.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full engine suite to confirm nothing regressed**

Run: `npm test`
Expected: PASS — all suites green (P5-a audit/policy tests included).

- [ ] **Step 6: Commit**

```bash
git add src/cli.ts tests/cli.report.test.ts
git commit -m "feat(cli): blox report command"
```

---

### Task 7: Panel endpoint `GET /api/v1/usage` + daemon pass-through

**Files:**
- Modify: `src/panel/server.ts`, `src/panel/daemon.ts`
- Test: `tests/panel.server.test.ts`

**Interfaces:**
- Consumes: `readAuditEntries` (Task 1), `aggregateUsage` (Task 2), `BloxConfig.{projectPath, policy}`.
- Produces: `PanelServerOptions` gains `projectPath?: string` and `rollingBudget?: { windowDays: number; maxUsd: number }`. New route `GET /api/v1/usage?since=<Nd>` returns a `UsageSummary` (200). `startDaemon` passes `config.projectPath` and `config.policy?.rollingBudget`.

- [ ] **Step 1: Write the failing test**

Append to `tests/panel.server.test.ts` (`start()` there omits the new opts; add a second helper):

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEntry } from '../src/audit.js';

async function startUsage(dir: string): Promise<string> {
  server = new PanelServer({
    runId: 'run-1', project: 'game', port: 0, holdMs: 50,
    projectPath: dir, rollingBudget: { windowDays: 30, maxUsd: 200 },
  });
  const port = await server.start();
  return `http://127.0.0.1:${port}/api/v1`;
}

describe('GET /api/v1/usage', () => {
  it('returns an aggregated summary from the project ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    appendAuditEntry(dir, {
      ts: new Date().toISOString(), user: 'a@x.com', model: 'claude-opus-4-8',
      turns: 1, costUsd: 12, status: 'success', commit: null, prompt: 'p',
    });
    const base = await startUsage(dir);
    const res = await fetch(`${base}/usage`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalUsd).toBe(12);
    expect(body.capUsd).toBe(200);
    expect(body.byUser[0].key).toBe('a@x.com');
  });

  it('returns an empty summary when no projectPath is configured', async () => {
    server = new PanelServer({ runId: 'run-1', project: 'game', port: 0, holdMs: 50 });
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/usage`);
    expect(res.status).toBe(200);
    expect((await res.json()).totalUsd).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/panel.server.test.ts`
Expected: FAIL — `usage` route 404s; `projectPath`/`rollingBudget` options unknown.

- [ ] **Step 3: Add the options and route in `src/panel/server.ts`**

In `PanelServerOptions` add:

```ts
  projectPath?: string; // ledger location for GET /api/v1/usage; absent → empty summary
  rollingBudget?: { windowDays: number; maxUsd: number }; // default window + cap for usage
```

Add imports at the top:

```ts
import { readAuditEntries } from '../audit.js';
import { aggregateUsage } from '../usageReport.js';
```

In the constructor's `this.opts = { … }`, carry the two new fields through. Because `opts` is typed `Required<Omit<PanelServerOptions,'port'>> & { port: number }`, the simplest path is to store them on dedicated private fields instead of in `opts`:

```ts
  private usageProjectPath: string | undefined;
  private usageRollingBudget: { windowDays: number; maxUsd: number } | undefined;
```

Set them at the end of the constructor:

```ts
    this.usageProjectPath = options.projectPath;
    this.usageRollingBudget = options.rollingBudget;
```

Add the route in `route()` before the final `return json(res, 404, …)`:

```ts
      if (req.method === 'GET' && url.pathname === '/api/v1/usage') {
        const sinceRaw = url.searchParams.get('since');
        const sinceN = sinceRaw != null ? Number(sinceRaw.replace(/d$/, '')) : NaN;
        const sinceDays = Number.isInteger(sinceN) && sinceN > 0 ? sinceN : null;
        const entries = this.usageProjectPath ? readAuditEntries(this.usageProjectPath) : [];
        const windowDays = sinceDays ?? this.usageRollingBudget?.windowDays ?? null;
        const summary = aggregateUsage(entries, {
          now: new Date(),
          windowDays,
          capUsd: this.usageRollingBudget?.maxUsd ?? null,
        });
        return json(res, 200, summary);
      }
```

The route is inside the existing `try { … } catch { return json(res, 400, …) }`, so a read failure already degrades to a 400 without crashing the daemon. (`readAuditEntries` itself returns `[]` for a missing file, so the common case is a clean empty summary.)

- [ ] **Step 4: Thread config through `startDaemon` in `src/panel/daemon.ts`**

In the `new PanelServer({ … })` call, add:

```ts
    projectPath: config.projectPath,
    rollingBudget: config.policy?.rollingBudget,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/panel.server.test.ts tests/daemon.test.ts`
Expected: PASS — new usage tests plus existing server/daemon tests.

- [ ] **Step 6: Commit**

```bash
git add src/panel/server.ts src/panel/daemon.ts tests/panel.server.test.ts
git commit -m "feat(panel): GET /api/v1/usage endpoint"
```

---

### Task 8: Renderer client — `panelClient.usage()` + mirrored `UsageSummary`

**Files:**
- Modify: `app/shared/panelClient.ts`
- Test: `app/shared/panelClient.test.ts`

**Interfaces:**
- Consumes: the engine's `GET /api/v1/usage` (Task 7).
- Produces: an exported `UsageSummary` type mirrored in `app/shared/panelClient.ts` (same shape as `src/usageReport.ts`, mirrored like `PanelInfo` already is), and a client method `usage(sinceDays?: number): Promise<UsageSummary | null>`.

- [ ] **Step 1: Write the failing test**

Append to `app/shared/panelClient.test.ts`:

```ts
it('reads /usage and returns the summary', async () => {
  const base = await stub({
    'GET /api/v1/usage': () => ({
      status: 200,
      json: { window: { days: 30, since: null }, totalUsd: 5, capUsd: 200, capPct: 0.025, runCount: 2, errorCount: 0, byUser: [], byModel: [] },
    }),
  });
  const c = createPanelClient(base);
  const u = await c.usage();
  expect(u?.totalUsd).toBe(5);
  expect(u?.capUsd).toBe(200);
});

it('returns null for usage when the server is down', async () => {
  const c = createPanelClient('http://127.0.0.1:1');
  expect(await c.usage()).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npm test -- shared/panelClient.test.ts`
Expected: FAIL — `c.usage` is not a function.

- [ ] **Step 3: Add the type and method in `app/shared/panelClient.ts`**

Add the mirrored types near `PanelInfo`:

```ts
export interface UsageBucket { key: string; costUsd: number; runs: number }
export interface UsageSummary {
  window: { days: number | null; since: string | null };
  totalUsd: number;
  capUsd: number | null;
  capPct: number | null;
  runCount: number;
  errorCount: number;
  byUser: UsageBucket[];
  byModel: UsageBucket[];
}
```

Add the method to the returned object:

```ts
    usage: (sinceDays?: number) =>
      getJson<UsageSummary>(`/usage${sinceDays ? `?since=${sinceDays}d` : ''}`),
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `app/`): `npm test -- shared/panelClient.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/shared/panelClient.ts app/shared/panelClient.test.ts
git commit -m "feat(app): panelClient.usage() + UsageSummary type"
```

---

### Task 9: Renderer — Usage view in `app/renderer/console.ts`

**Files:**
- Modify: `app/renderer/console.ts`
- Create: `app/renderer/usageView.ts`
- Test: `app/renderer/usageView.test.ts`

**Interfaces:**
- Consumes: `UsageSummary` from `../shared/panelClient.js` (Task 8).
- Produces: `usageHtml(summary: UsageSummary | null): string` (pure, testable); `console.ts` adds a "Refresh usage" button that fetches `client.usage()` and writes `usageHtml(...)` into a container.

- [ ] **Step 1: Write the failing test**

Create `app/renderer/usageView.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { usageHtml } from './usageView.js';

const summary = {
  window: { days: 30, since: null }, totalUsd: 142.3, capUsd: 200, capPct: 0.7115,
  runCount: 5, errorCount: 1, byUser: [{ key: 'a@x.com', costUsd: 142.3, runs: 5 }],
  byModel: [{ key: 'claude-opus-4-8', costUsd: 142.3, runs: 5 }],
};

describe('usageHtml', () => {
  it('renders totals, cap percent and per-user rows', () => {
    const html = usageHtml(summary);
    expect(html).toContain('$142.30');
    expect(html).toContain('71%');
    expect(html).toContain('a@x.com');
  });

  it('shows a fallback when usage is unavailable', () => {
    expect(usageHtml(null)).toContain('usage unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `app/`): `npm test -- renderer/usageView.test.ts`
Expected: FAIL — `Cannot find module './usageView.js'`.

- [ ] **Step 3: Create `app/renderer/usageView.ts`**

```ts
import type { UsageSummary } from '../shared/panelClient.js';

const usd = (n: number) => `$${n.toFixed(2)}`;

export function usageHtml(s: UsageSummary | null): string {
  if (!s) return '<p>usage unavailable</p>';
  const win = s.window.days != null ? `last ${s.window.days}d` : 'all time';
  const cap =
    s.capUsd != null && s.capPct != null
      ? `used ${usd(s.totalUsd)} / cap ${usd(s.capUsd)} (${Math.round(s.capPct * 100)}%)`
      : `used ${usd(s.totalUsd)}`;
  const rows = (bs: { key: string; costUsd: number; runs?: number }[]) =>
    bs.map((b) => `<tr><td>${b.key}</td><td>${usd(b.costUsd)}</td><td>${b.runs ?? ''}</td></tr>`).join('');
  return `
    <h3>Usage — ${win}</h3>
    <p>${cap} · ${s.runCount} runs, ${s.errorCount} errors</p>
    <table><thead><tr><th>User</th><th>Cost</th><th>Runs</th></tr></thead><tbody>${rows(s.byUser)}</tbody></table>
    <table><thead><tr><th>Model</th><th>Cost</th><th></th></tr></thead><tbody>${rows(s.byModel)}</tbody></table>
  `;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `app/`): `npm test -- renderer/usageView.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the view into `app/renderer/console.ts`**

Add the import at the top:

```ts
import { usageHtml } from './usageView.js';
```

Append to the `app.innerHTML` template (after the `<pre id="log">` line):

```html
  <div><button id="refresh-usage">Refresh usage</button></div>
  <div id="usage"></div>
```

Add the handler near the bottom (after the cancel listener), reusing the same panel base + client:

```ts
document.getElementById('refresh-usage')!.addEventListener('click', async () => {
  const client = createPanelClient(await window.blox.panelBase());
  document.getElementById('usage')!.innerHTML = usageHtml(await client.usage());
});
```

- [ ] **Step 6: Run the app test suite and typecheck**

Run (from `app/`): `npm test`
Expected: PASS — usageView, panelClient, and existing app suites.

- [ ] **Step 7: Commit**

```bash
git add app/renderer/console.ts app/renderer/usageView.ts app/renderer/usageView.test.ts
git commit -m "feat(app): usage view in the desktop console"
```

---

### Task 10: Docs + full-suite green

**Files:**
- Modify: `README.md` (or the CLI command reference, wherever subcommands are listed)

**Interfaces:** none.

- [ ] **Step 1: Document `blox report`**

Find where commands are listed:

Run: `grep -rn "blox doctor\|blox panel\|## Commands\|blox auth" README.md`

Add a line/section documenting:

```
blox report [--since Nd] [--json]
  Summarize the committed .blox/audit.jsonl ledger: spend vs the rolling cap,
  and cost per user and per model. --since overrides the policy window;
  --json prints the raw summary.
```

Also carry over the P5-a deferred note (so it lives with the report docs): for CCR-routed models, `policy.models` and the report's "by model" keys use the `provider,slug` string.

- [ ] **Step 2: Run the full engine + app suites**

Run: `npm test`
Then (from `app/`): `npm test`
Expected: both green.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(report): document blox report"
```

---

## Self-Review

**Spec coverage:**
- §1 `UsageSummary` shape → Task 2 (engine) + Task 8 (mirror). ✓
- §2 `aggregateUsage` → Task 2. ✓
- §3 `readAuditEntries` extract + reuse → Task 1. ✓
- §4 `renderUsageTable` → Task 3. ✓
- §5 CLI `blox report` (+ `--since`, `--json`) → Tasks 4 (output core), 5 (args), 6 (wiring). ✓
- §6 `GET /api/v1/usage` + projectPath/rollingBudget threading → Task 7. ✓
- §7 renderer (`panelClient.usage()` + Usage view) → Tasks 8, 9. ✓
- Error-handling table (missing ledger, malformed, unknown bucket, non-number cost, bad `--since`, endpoint/renderer failure) → covered across Tasks 1, 2, 5, 7, 8. ✓
- Testing section → each task is TDD. ✓
- Deferred scope (per-run dump, charts, CSV, dock tab, token accounting, relay) → not built. ✓

**Placeholder scan:** no TBD/TODO; every code step has full code. ✓

**Type consistency:** `UsageSummary`/`UsageBucket` identical in `src/usageReport.ts` (Task 2) and `app/shared/panelClient.ts` (Task 8). `reportOutput` opts (`sinceDays`, `rollingBudget`, `json`) consistent Tasks 4/6. `aggregateUsage` opts (`now`, `windowDays`, `capUsd`) consistent Tasks 2/3/4/7. Endpoint options `projectPath`/`rollingBudget` consistent Tasks 7. `ParsedArgs.{since,json}` consistent Tasks 5/6. ✓
