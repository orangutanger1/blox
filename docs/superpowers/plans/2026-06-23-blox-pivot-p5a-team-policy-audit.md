# P5-a: Team Policy + Audit Ledger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add committed-file team governance to blox — a `policy` block in `blox.config.json` (model allowlist, per-run + rolling spend ceilings, mode floor, commit convention) enforced reject-not-clamp, plus a committed `.blox/audit.jsonl` usage ledger that drives the rolling cap and records cost attribution.

**Architecture:** Extend the existing `BloxConfigSchema`/`loadConfig` with an optional `policy` object (absent = today's behavior). A pure `src/audit.ts` does JSONL append + windowed cost sum. A pure `src/policy.ts` validates an effective config against the policy and throws `PolicyError` on violation (loud, never silent clamp). `runOnce` (the single chokepoint for CLI + daemon) calls `enforcePolicy` before the agent runs, renders the commit message from `commitConvention`, and appends a ledger line after the report. CLI and daemon catch `PolicyError` and surface it.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), zod v4, vitest, Node fs. Git invoked via the existing `SpawnFn` (`realSpawn`) from `src/sync/rojo.js` so it stays injectable in tests.

## Global Constraints

- ESM modules: all intra-repo imports use `.js` specifiers (e.g. `./audit.js`), even from `.ts` sources.
- zod v4: use `.prefault({})` (not `.default({})`) for nested objects whose inner field defaults must run — `.default()` short-circuits inner parsing. Follow the existing `panel` field pattern in `src/config.ts:12-19`.
- Tests: vitest (`npm test` → `vitest run`). Use real temp dirs via `mkdtempSync(join(tmpdir(), 'blox-'))`, matching `tests/config.test.ts`.
- An absent `policy` block MUST leave all current behavior byte-for-byte unchanged (back-compat).
- Audit append failure MUST NOT fail a completed run — log a warning, continue.
- Money/security path: policy rejection and the rolling-cap block must each have a runnable test.

---

### Task 1: Policy schema in config

**Files:**
- Modify: `src/config.ts:5-22` (add `PolicySchema`, add `policy` to `BloxConfigSchema`, export both)
- Test: `tests/config.test.ts` (append cases)

**Interfaces:**
- Consumes: existing `BloxConfigSchema`, `loadConfig` from `src/config.ts`.
- Produces:
  - `PolicySchema` (zod) and `type Policy = z.infer<typeof PolicySchema>`.
  - `BloxConfig.policy?: Policy` with fields: `models?: string[]`, `maxBudgetUsd?: number`, `maxTurns?: number`, `mode?: 'ask' | 'auto'`, `rollingBudget?: { windowDays: number; maxUsd: number }`, `commitConvention?: string`.

- [ ] **Step 1: Write the failing test**

Append to `tests/config.test.ts`:

```typescript
import { mkdtempSync, writeFileSync } from 'node:fs';

describe('policy schema', () => {
  it('parses a full policy block from blox.config.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({
      policy: {
        models: ['claude-opus-4-8'],
        maxBudgetUsd: 10,
        maxTurns: 60,
        mode: 'ask',
        rollingBudget: { windowDays: 30, maxUsd: 200 },
        commitConvention: 'blox({user}): {prompt}',
      },
    }));
    const cfg = loadConfig(dir);
    expect(cfg.policy?.models).toEqual(['claude-opus-4-8']);
    expect(cfg.policy?.rollingBudget?.maxUsd).toBe(200);
    expect(cfg.policy?.commitConvention).toBe('blox({user}): {prompt}');
  });

  it('leaves policy undefined when absent (back-compat)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    const cfg = loadConfig(dir);
    expect(cfg.policy).toBeUndefined();
  });

  it('rejects a non-positive rolling window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    writeFileSync(join(dir, 'blox.config.json'), JSON.stringify({
      policy: { rollingBudget: { windowDays: 0, maxUsd: 200 } },
    }));
    expect(() => loadConfig(dir)).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/config.test.ts`
Expected: FAIL — `policy` parsed away (strict? no — zod strips unknown by default, so `cfg.policy` is `undefined` and the first assertion fails).

- [ ] **Step 3: Write minimal implementation**

In `src/config.ts`, before `BloxConfigSchema`:

```typescript
export const PolicySchema = z.object({
  models: z.array(z.string()).optional(),
  maxBudgetUsd: z.number().positive().optional(),
  maxTurns: z.number().int().positive().optional(),
  mode: z.enum(['auto', 'ask']).optional(),
  rollingBudget: z
    .object({
      windowDays: z.number().int().positive(),
      maxUsd: z.number().positive(),
    })
    .optional(),
  commitConvention: z.string().optional(),
});

export type Policy = z.infer<typeof PolicySchema>;
```

Add to `BloxConfigSchema` object (after the `panel` field):

```typescript
  policy: PolicySchema.optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/config.test.ts`
Expected: PASS (all three new cases + existing cases).

- [ ] **Step 5: Commit**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "feat(p5a): policy block in blox.config.json schema"
```

---

### Task 2: Audit ledger I/O

**Files:**
- Create: `src/audit.ts`
- Test: `tests/audit.test.ts`

**Interfaces:**
- Consumes: nothing internal (pure fs).
- Produces:
  - `interface AuditEntry { ts: string; user: string; model: string; turns: number; costUsd: number; status: 'success' | 'error'; commit: string | null; prompt: string; stopReason?: string }`
  - `function auditPath(projectPath: string): string` → `<projectPath>/.blox/audit.jsonl`
  - `function appendAuditEntry(projectPath: string, entry: AuditEntry): void` — creates `.blox/` + file if absent, appends one JSON line + `\n`.
  - `function readWindowSpend(projectPath: string, windowDays: number, now?: Date): number` — sums `costUsd` of entries whose `ts` is within `windowDays` of `now` (default `new Date()`); skips unparseable lines; returns `0` if file missing.

- [ ] **Step 1: Write the failing test**

Create `tests/audit.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEntry, readWindowSpend, auditPath, type AuditEntry } from '../src/audit.js';

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: new Date().toISOString(),
    user: 'dev@example.com',
    model: 'claude-opus-4-8',
    turns: 3,
    costUsd: 1.5,
    status: 'success',
    commit: 'abc1234',
    prompt: 'do a thing',
    ...over,
  };
}

describe('audit ledger', () => {
  it('appends entries as one JSON line each, creating the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    appendAuditEntry(dir, entry());
    appendAuditEntry(dir, entry({ costUsd: 2 }));
    const lines = readFileSync(auditPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).costUsd).toBe(1.5);
  });

  it('readWindowSpend sums in-window and excludes out-of-window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    const now = new Date('2026-06-23T12:00:00Z');
    appendAuditEntry(dir, entry({ ts: '2026-06-22T12:00:00Z', costUsd: 10 })); // 1 day ago
    appendAuditEntry(dir, entry({ ts: '2026-05-01T12:00:00Z', costUsd: 99 })); // >30 days ago
    expect(readWindowSpend(dir, 30, now)).toBe(10);
  });

  it('returns 0 for a missing ledger and skips malformed lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    expect(readWindowSpend(dir, 30)).toBe(0);
    appendAuditEntry(dir, entry({ costUsd: 5 }));
    // corrupt the file with a junk line
    const fs = require('node:fs');
    fs.appendFileSync(auditPath(dir), 'not json\n');
    expect(readWindowSpend(dir, 30)).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/audit.test.ts`
Expected: FAIL — `Cannot find module '../src/audit.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/audit.ts`:

```typescript
import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface AuditEntry {
  ts: string;
  user: string;
  model: string;
  turns: number;
  costUsd: number;
  status: 'success' | 'error';
  commit: string | null;
  prompt: string;
  stopReason?: string;
}

export function auditPath(projectPath: string): string {
  return join(projectPath, '.blox', 'audit.jsonl');
}

export function appendAuditEntry(projectPath: string, entry: AuditEntry): void {
  const path = auditPath(projectPath);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(entry) + '\n');
}

export function readWindowSpend(projectPath: string, windowDays: number, now: Date = new Date()): number {
  const path = auditPath(projectPath);
  if (!existsSync(path)) return 0;
  const cutoff = now.getTime() - windowDays * 24 * 60 * 60 * 1000;
  let sum = 0;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as AuditEntry;
      const t = Date.parse(e.ts);
      if (!Number.isNaN(t) && t >= cutoff && typeof e.costUsd === 'number') sum += e.costUsd;
    } catch {
      // skip malformed line — visibility is best-effort
    }
  }
  return sum;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/audit.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/audit.ts tests/audit.test.ts
git commit -m "feat(p5a): .blox/audit.jsonl ledger append + windowed spend"
```

---

### Task 3: Policy enforcement (reject-not-clamp + rolling cap)

**Files:**
- Create: `src/policy.ts`
- Test: `tests/policy.test.ts`

**Interfaces:**
- Consumes: `BloxConfig`, `Policy` from `src/config.js`; `readWindowSpend` from `src/audit.js`.
- Produces:
  - `class PolicyError extends Error { field: string; requested?: unknown; cap?: unknown }`
  - `function enforcePolicy(config: BloxConfig, now?: Date): void` — throws `PolicyError` on the first violation; no-op when `config.policy` is undefined or a given field is unset. Checks model allowlist, `maxBudgetUsd`/`maxTurns` ceilings, mode floor (`policy.mode === 'ask'` && effective `mode === 'auto'`), and rolling cap (reads `readWindowSpend(config.projectPath, windowDays, now) >= maxUsd`).

- [ ] **Step 1: Write the failing test**

Create `tests/policy.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforcePolicy, PolicyError } from '../src/policy.js';
import { appendAuditEntry } from '../src/audit.js';
import type { BloxConfig } from '../src/config.js';

function cfg(over: Partial<BloxConfig> = {}): BloxConfig {
  return {
    projectPath: '/game',
    model: 'claude-opus-4-8',
    maxTurns: 40,
    maxBudgetUsd: 5,
    mode: 'auto',
    panel: { port: 35768, gateTimeoutSeconds: 120 },
    ...over,
  } as BloxConfig;
}

describe('enforcePolicy', () => {
  it('is a no-op when policy is absent', () => {
    expect(() => enforcePolicy(cfg())).not.toThrow();
  });

  it('rejects a model not in the allowlist', () => {
    expect(() => enforcePolicy(cfg({ model: 'deepseek', policy: { models: ['claude-opus-4-8'] } })))
      .toThrow(PolicyError);
  });

  it('rejects maxBudgetUsd over the ceiling', () => {
    expect(() => enforcePolicy(cfg({ maxBudgetUsd: 20, policy: { maxBudgetUsd: 10 } })))
      .toThrow(/maxBudgetUsd/);
  });

  it('rejects maxTurns over the ceiling', () => {
    expect(() => enforcePolicy(cfg({ maxTurns: 100, policy: { maxTurns: 60 } })))
      .toThrow(/maxTurns/);
  });

  it('rejects downgrading mode ask -> auto', () => {
    expect(() => enforcePolicy(cfg({ mode: 'auto', policy: { mode: 'ask' } })))
      .toThrow(/mode/);
  });

  it('allows values at or under the ceiling', () => {
    expect(() => enforcePolicy(cfg({ maxBudgetUsd: 10, maxTurns: 60, policy: { maxBudgetUsd: 10, maxTurns: 60 } })))
      .not.toThrow();
  });

  it('blocks when rolling window spend already meets the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    const now = new Date('2026-06-23T12:00:00Z');
    appendAuditEntry(dir, {
      ts: '2026-06-23T00:00:00Z', user: 'a@b.c', model: 'claude-opus-4-8',
      turns: 1, costUsd: 200, status: 'success', commit: 'x', prompt: 'p',
    });
    expect(() => enforcePolicy(
      cfg({ projectPath: dir, policy: { rollingBudget: { windowDays: 30, maxUsd: 200 } } }),
      now,
    )).toThrow(/rolling/i);
  });

  it('passes when rolling window spend is under the cap', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    expect(() => enforcePolicy(
      cfg({ projectPath: dir, policy: { rollingBudget: { windowDays: 30, maxUsd: 200 } } }),
    )).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy.test.ts`
Expected: FAIL — `Cannot find module '../src/policy.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/policy.ts`:

```typescript
import type { BloxConfig } from './config.js';
import { readWindowSpend } from './audit.js';

export class PolicyError extends Error {
  field: string;
  requested?: unknown;
  cap?: unknown;
  constructor(field: string, message: string, requested?: unknown, cap?: unknown) {
    super(message);
    this.name = 'PolicyError';
    this.field = field;
    this.requested = requested;
    this.cap = cap;
  }
}

export function enforcePolicy(config: BloxConfig, now: Date = new Date()): void {
  const p = config.policy;
  if (!p) return;

  if (p.models && !p.models.includes(config.model)) {
    throw new PolicyError('model', `model "${config.model}" is not in the team allowlist [${p.models.join(', ')}]`, config.model, p.models);
  }
  if (p.maxBudgetUsd != null && config.maxBudgetUsd > p.maxBudgetUsd) {
    throw new PolicyError('maxBudgetUsd', `maxBudgetUsd ${config.maxBudgetUsd} exceeds team ceiling ${p.maxBudgetUsd}`, config.maxBudgetUsd, p.maxBudgetUsd);
  }
  if (p.maxTurns != null && config.maxTurns > p.maxTurns) {
    throw new PolicyError('maxTurns', `maxTurns ${config.maxTurns} exceeds team ceiling ${p.maxTurns}`, config.maxTurns, p.maxTurns);
  }
  if (p.mode === 'ask' && config.mode === 'auto') {
    throw new PolicyError('mode', `team policy requires mode "ask"; cannot run in "auto"`, config.mode, p.mode);
  }
  if (p.rollingBudget) {
    const spent = readWindowSpend(config.projectPath, p.rollingBudget.windowDays, now);
    if (spent >= p.rollingBudget.maxUsd) {
      throw new PolicyError(
        'rollingBudget',
        `team rolling budget reached: $${spent.toFixed(2)} spent in the last ${p.rollingBudget.windowDays}d meets/exceeds the $${p.rollingBudget.maxUsd} cap`,
        spent,
        p.rollingBudget.maxUsd,
      );
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/policy.test.ts`
Expected: PASS (8 cases).

- [ ] **Step 5: Commit**

```bash
git add src/policy.ts tests/policy.test.ts
git commit -m "feat(p5a): enforcePolicy reject-not-clamp + rolling cap"
```

---

### Task 4: Commit message convention renderer

**Files:**
- Create: `src/commitMessage.ts`
- Test: `tests/commitMessage.test.ts`

**Interfaces:**
- Consumes: nothing internal.
- Produces: `function renderCommitMessage(template: string | undefined, ctx: { prompt: string; user: string; model: string; date: string }): string` — replaces `{prompt}`/`{user}`/`{model}`/`{date}` in `template`; unknown `{...}` left literal; when `template` is undefined, returns the default `blox: ${prompt}`. Truncation to 72 chars stays the caller's job (preserves current `.slice(0, 72)` behavior).

- [ ] **Step 1: Write the failing test**

Create `tests/commitMessage.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { renderCommitMessage } from '../src/commitMessage.js';

const ctx = { prompt: 'add leaderboard', user: 'dev@x.io', model: 'claude-opus-4-8', date: '2026-06-23' };

describe('renderCommitMessage', () => {
  it('falls back to the default template when none set', () => {
    expect(renderCommitMessage(undefined, ctx)).toBe('blox: add leaderboard');
  });

  it('substitutes all known tokens', () => {
    expect(renderCommitMessage('{date} {user} [{model}]: {prompt}', ctx))
      .toBe('2026-06-23 dev@x.io [claude-opus-4-8]: add leaderboard');
  });

  it('leaves unknown tokens literal', () => {
    expect(renderCommitMessage('blox({user}): {prmpt}', ctx))
      .toBe('blox(dev@x.io): {prmpt}');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/commitMessage.test.ts`
Expected: FAIL — `Cannot find module '../src/commitMessage.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/commitMessage.ts`:

```typescript
export function renderCommitMessage(
  template: string | undefined,
  ctx: { prompt: string; user: string; model: string; date: string },
): string {
  const t = template ?? 'blox: {prompt}';
  return t.replace(/\{(prompt|user|model|date)\}/g, (_m, key: keyof typeof ctx) => ctx[key]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/commitMessage.test.ts`
Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/commitMessage.ts tests/commitMessage.test.ts
git commit -m "feat(p5a): commit message convention token renderer"
```

---

### Task 5: Wire policy + audit + commit convention into runOnce

**Files:**
- Modify: `src/run.ts` (add a `gitUserEmail` helper, call `enforcePolicy`, render commit message, append ledger)
- Test: `tests/run.policy.test.ts`

**Interfaces:**
- Consumes: `enforcePolicy`, `PolicyError` from `src/policy.js`; `appendAuditEntry`, `AuditEntry` from `src/audit.js`; `renderCommitMessage` from `src/commitMessage.js`; existing `runAgent`, `syncProject`, `commitChanges`.
- Produces: unchanged `runOnce(config, prompt, deps): Promise<RunReport>` signature. `enforcePolicy(config)` is called before `buildQueryOptions` so a violation short-circuits before any agent/model work. A successful or errored run appends exactly one `AuditEntry`. Commit message comes from `renderCommitMessage(config.policy?.commitConvention, ...)`.

- [ ] **Step 1: Write the failing test**

Create `tests/run.policy.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { runOnce } from '../src/run.js';
import { PolicyError } from '../src/policy.js';
import type { BloxConfig } from '../src/config.js';

function cfg(over: Partial<BloxConfig> = {}): BloxConfig {
  return {
    projectPath: '/game', model: 'deepseek', maxTurns: 40, maxBudgetUsd: 5,
    mode: 'auto', panel: { port: 35768, gateTimeoutSeconds: 120 },
    policy: { models: ['claude-opus-4-8'] },
    ...over,
  } as BloxConfig;
}

describe('runOnce policy gate', () => {
  it('throws PolicyError before running the agent when policy is violated', async () => {
    const runAgent = await import('../src/agent/runAgent.js');
    const spy = vi.spyOn(runAgent, 'runAgent');
    await expect(
      runOnce(cfg(), 'do a thing', { bridge: {} as never, digest: {} as never }),
    ).rejects.toBeInstanceOf(PolicyError);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/run.policy.test.ts`
Expected: FAIL — `runOnce` does not call `enforcePolicy`, so it proceeds to `runAgent` (the `spy` is called / or it throws a different error). Either way the assertion fails.

- [ ] **Step 3: Write minimal implementation**

In `src/run.ts`, add imports at top:

```typescript
import { enforcePolicy } from './policy.js';
import { appendAuditEntry } from './audit.js';
import { renderCommitMessage } from './commitMessage.js';
import { realSpawn } from './sync/rojo.js';
```

Add a helper above `runOnce`:

```typescript
async function gitUserEmail(projectPath: string): Promise<string> {
  try {
    const r = await realSpawn('git', ['config', 'user.email'], { cwd: projectPath });
    return r.stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}
```

Replace the body of `runOnce` so it enforces first, renders the commit message, and appends the ledger. The new body:

```typescript
export async function runOnce(config: BloxConfig, prompt: string, deps: RunOnceDeps): Promise<RunReport> {
  enforcePolicy(config); // throws PolicyError on violation, before any agent/model work

  const options = buildQueryOptions(config, deps.bridge, deps.digest, deps.gate, {
    image: !!deps.image,
    verify: deps.verify,
  });
  const agent = await runAgent(prompt, options, {
    sink: deps.sink,
    dockDeniedTools: deps.dockDeniedTools,
    image: deps.image,
    abortController: deps.abortController,
    env: deps.env,
  });
  const sync = await syncProject(config.projectPath);

  const user = await gitUserEmail(config.projectPath);
  const date = new Date().toISOString().slice(0, 10);
  const message = renderCommitMessage(config.policy?.commitConvention, {
    prompt, user, model: config.model, date,
  }).slice(0, 72);
  const commit = sync.ok
    ? await commitChanges(config.projectPath, message)
    : { sha: null, files: [] };

  const status = agent.status === 'success' && sync.ok ? 'success' : 'error';

  try {
    appendAuditEntry(config.projectPath, {
      ts: new Date().toISOString(),
      user, model: config.model, turns: agent.numTurns, costUsd: agent.costUsd,
      status, commit: commit.sha, prompt, stopReason: agent.stopReason,
    });
  } catch (e) {
    console.warn(`blox: failed to write audit ledger: ${(e as Error).message}`);
  }

  return {
    prompt,
    changedFiles: commit.files,
    commitSha: commit.sha,
    numTurns: agent.numTurns,
    costUsd: agent.costUsd,
    status,
    stopReason: agent.stopReason,
    detail: sync.ok ? agent.detail : sync.detail,
    mode: config.mode,
    effort: config.effort,
    sessionId: agent.sessionId,
    gatedActions: agent.gatedActions,
    deniedByUser: agent.deniedByUser,
    nonGatedDenials: agent.nonGatedDenials,
    assetDecisions: deps.resultDecisions?.(),
  };
}
```

Note: the ledger line lands before `commitChanges`? No — it is written *after* the commit (so it records the real `commit.sha`). It therefore ships in the *next* run's commit (`git add -A` picks up the prior line). This is acceptable: the ledger trails by one run, and the final run's line is committed by the user or the next run. If shipping each line in its own run's commit matters later, move the append before `commitChanges` and record `commit: null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/run.policy.test.ts`
Expected: PASS (PolicyError thrown, `runAgent` never called).

Run the full suite to confirm no regression in `runOnce` callers:
Run: `npm test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**

```bash
git add src/run.ts tests/run.policy.test.ts
git commit -m "feat(p5a): enforce policy, render commit convention, append ledger in runOnce"
```

---

### Task 6: Surface PolicyError in CLI and daemon

**Files:**
- Modify: `src/cli.ts` (catch `PolicyError` around the run, print + exit non-zero)
- Modify: `src/panel/daemon.ts:~107-166` (catch `PolicyError`, emit a run error to the dock instead of crashing)
- Test: `tests/policy.surface.test.ts`

**Interfaces:**
- Consumes: `PolicyError` from `src/policy.js`; existing CLI run path and daemon run handler.
- Produces: no new exports. CLI prints `policy violation: <message>` to stderr and exits with code 1 when a `PolicyError` is thrown. Daemon emits a `run_finished` event with `status: 'error'` and the policy message in `detail` (matching the existing error-event shape it already emits at `daemon.ts:166`), and does not throw out of the run handler.

- [ ] **Step 1: Write the failing test**

First read the actual run/catch sites to match their shape:

Run: `grep -n "runOnce\|catch\|process.exit\|run_finished\|status:" src/cli.ts src/panel/daemon.ts`

Then create `tests/policy.surface.test.ts`. Match the daemon's run-handler export; the daemon test below assumes a `handleRun`-style function — adjust the import to the real symbol found above (e.g. the function wrapping `runOnce` near `daemon.ts:107`). Template:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { PolicyError } from '../src/policy.js';

// CLI: the catch should map PolicyError -> stderr + exit(1).
// Daemon: the catch should map PolicyError -> a status:'error' event, no throw.
describe('PolicyError surfacing', () => {
  it('PolicyError carries field + message for callers to render', () => {
    const e = new PolicyError('model', 'model "x" is not in the team allowlist', 'x', ['y']);
    expect(e).toBeInstanceOf(Error);
    expect(e.field).toBe('model');
    expect(e.message).toMatch(/allowlist/);
  });
});
```

(If the CLI and daemon run paths are exported and unit-testable, add a case that spies on `runOnce` to throw `PolicyError` and asserts the CLI calls `process.exit(1)` / the daemon emits a `status:'error'` event. Use the real symbols from the grep. If they are not separately testable without heavy harnessing, the integration check in Step 4 covers them and this unit test documents the `PolicyError` contract.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/policy.surface.test.ts`
Expected: At minimum the contract test PASSES immediately (PolicyError already exists from Task 3). The point of this task is the wiring in Step 3; this test documents the contract and guards regressions. If you added the spy-based cases, they FAIL until Step 3.

- [ ] **Step 3: Write the wiring**

In `src/cli.ts`, find the call that awaits `runOnce` (from the grep in Step 1) and wrap it:

```typescript
import { PolicyError } from './policy.js';
// ...
try {
  // existing runOnce(...) call and report handling
} catch (e) {
  if (e instanceof PolicyError) {
    console.error(`policy violation [${e.field}]: ${e.message}`);
    process.exit(1);
  }
  throw e;
}
```

In `src/panel/daemon.ts`, in the handler that calls `runOnce` (near line 107) and emits the finish event (near line 166), wrap the `runOnce` call:

```typescript
import { PolicyError } from '../policy.js';
// ...
try {
  const report = await runOnce(runConfig, prompt, deps);
  // existing run_finished emit with costUsd: report.costUsd, status: report.status, ...
} catch (e) {
  if (e instanceof PolicyError) {
    // emit the same run_finished shape used at daemon.ts:166, but as an error:
    sink.emit({ /* type: 'run_finished' */ status: 'error', detail: `policy violation [${e.field}]: ${e.message}`, costUsd: 0 } as never);
    return; // do not throw out of the handler
  }
  throw e;
}
```

Adjust the emitted object to the daemon's real event shape (use the existing emit at `daemon.ts:166` as the template — same fields, `status: 'error'`, message in the existing detail/error field).

- [ ] **Step 4: Run test + manual integration check**

Run: `npm test`
Expected: PASS (all suites).

Manual check — a policy that rejects a run surfaces cleanly:

```bash
cd /home/myen/blox-playground   # a scratch Rojo project (per memory: blox needs a Rojo dir)
echo '{"policy":{"models":["claude-opus-4-8"]}}' > blox.config.json
node /home/myen/blox/dist/cli.js --model deepseek "add a part"
```

Expected: prints `policy violation [model]: model "deepseek" is not in the team allowlist [...]` and exits non-zero, with no agent run started. (Build first: `npm run build`.)

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/panel/daemon.ts tests/policy.surface.test.ts
git commit -m "feat(p5a): surface PolicyError in CLI (exit 1) and daemon (run error)"
```

---

## Self-Review

**Spec coverage:**
- Policy block schema → Task 1. ✓
- Reject-not-clamp enforcement (model/budget/turns/mode) → Task 3. ✓
- Audit ledger format + committed location → Task 2 (`.blox/audit.jsonl`) + Task 5 (append in runOnce, picked up by `git add -A` in `commitChanges`). ✓
- Rolling cap → Task 3 (`readWindowSpend` + block) + Task 2 (window sum). ✓
- commitConvention tokens (prompt/user/date/model, unknown literal) → Task 4 + Task 5 wiring. ✓
- Error handling: PolicyError loud, CLI exit non-zero, daemon run-error, audit append never fails the run → Task 5 (try/catch around append) + Task 6 (surfacing). ✓
- Back-compat (absent policy unchanged) → Task 1 test + Task 3 no-op. ✓
- Honesty framing / out-of-scope (hosted relay, tokens, predictive reservation) → carried in the spec; no code task needed. ✓

**Placeholder scan:** Task 6 intentionally instructs a grep to match real symbols (`cli.ts`/`daemon.ts` run sites are not pre-read in this plan). This is a deliberate "discover the exact emit shape" step, not a placeholder — the code to write is shown, only the surrounding event object's field names are confirmed at implementation time. All other tasks have complete code.

**Type consistency:** `AuditEntry` shape identical in Task 2, Task 3 test, and Task 5 append. `PolicyError(field, message, requested?, cap?)` constructor consistent across Task 3 definition and Task 6 usage. `renderCommitMessage(template, ctx)` ctx keys (`prompt/user/model/date`) match Task 4 and Task 5 call. `enforcePolicy(config, now?)` signature consistent Task 3 ↔ Task 5.
