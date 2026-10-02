# design.json + Economy Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a validated `.blox/design.json`, a deterministic offline economy simulator with declarative assertions, Luau codegen of tunables, and one `design` tool (MCP + CLI) that ties it together.

**Architecture:** Pure modules in `src/design/` (schema → sim → metrics/assert → report, plus codegen). The registry tool `design` wraps them and never touches Studio. Sim assertions become synthetic test results (`design:<id>`) so task criteria bind to them with the existing test-binding mechanism.

**Tech Stack:** TypeScript (NodeNext ESM, `.js` import suffixes), zod v4, vitest 4.

**Spec:** `docs/superpowers/specs/2026-10-01-design-economy-sim-design.md`

## Global Constraints

- Node ≥ 20, ESM, imports end in `.js`; tests live in `tests/*.test.ts` (vitest include glob).
- No new dependencies.
- `src/design/*` is pure: no Studio, network, or `node:fs` imports. File IO lives in the registry tool.
- Sim defaults: runs 50, horizon 86400 s, seed 1, percentiles nearest-rank 10/50/90, event cap 2,000,000 per run.
- Codegen target: `src/ReplicatedStorage/Design/Tunables.luau`, header line exactly `-- GENERATED from .blox/design.json by \`blox design codegen\`. Do not edit.`
- Before claiming green: `npx vitest run` AND `npx tsc --noEmit` both clean.

## Review Focus

- Monetization with a non-`upgrade:` effect (e.g. `chance:egg1`) — must validate and be ignored by the sim, not crash.
- An archetype session longer than its slot (`lengthSec > 86400/perDay`) — must be a validation error, not overlapping sessions.
- Exponential blowup (`mult` compounding over many rebirths) — must produce a named `SimError`, not hang or print `NaN`.
- Assertion filter by `archetypes` on `simulate` — assertions referencing an archetype not run (incl. `vs`) are skipped, not reported as failures.
- Malformed JSON passed via CLI `blox design set '<json>'` — readable error, nothing written.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/design/schema.ts` | zod schema, `DesignDoc` types, `validateDesign`, ref helpers |
| `src/design/sim.ts` | PRNG, rates, closed-form advance, purchases, policies, `simulate` |
| `src/design/metrics.ts` | trace → metric values; `percentile` |
| `src/design/assert.ts` | evaluate assertions over traces |
| `src/design/report.ts` | `runSimulation` (Monte Carlo orchestration), `formatReport` |
| `src/design/codegen.ts` | `renderTunables` → Luau source |
| `src/state/store.ts` | + `withDesignResults` (sim assertions as synthetic tests) |
| `src/tools/registry.ts` | + `design` tool; status/run_tests/task use `withDesignResults` |
| `src/dashboard/server.ts` | criteria use `withDesignResults` |
| `src/cliTools.ts` | + `blox design <action> [json]` mapping |
| `src/agentGuide.ts` | + short "Design first" section |
| `docs/examples/design/*.json` | two passing example designs |
| `tests/design.*.test.ts` | one test file per module |

---

### Task 1: Schema + validation

**Files:**
- Create: `src/design/schema.ts`
- Test: `tests/design.schema.test.ts`

**Interfaces:**
- Produces:
  - `type DesignDoc = z.infer<typeof DesignSchema>` (defaults applied)
  - `type Archetype = DesignDoc['archetypes'][number]`, `type Assertion = DesignDoc['assertions'][number]`
  - `interface DesignError { path: string; message: string }`
  - `validateDesign(raw: unknown): { ok: true; doc: DesignDoc } | { ok: false; errors: DesignError[] }`
  - `parseRef(ref: string): { kind: string; id: string; n?: number }`
  - `RESET_KEYWORDS = ['generators','upgrades','gates','chance'] as const`

- [ ] **Step 1: Write the failing test**

```ts
// tests/design.schema.test.ts
import { describe, it, expect } from 'vitest';
import { validateDesign, parseRef } from '../src/design/schema.js';

export function minimal(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    meta: { title: 'T', format: 'incremental' },
    economy: {
      resources: [{ id: 'cash', start: 0 }],
      actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1 }],
      generators: [{ id: 'dropper', produces: { cash: 1 }, cost: { res: 'cash', base: 10, growth: 1.15 } }],
    },
    archetypes: [{ id: 'active', session: { lengthSec: 900, perDay: 2 }, policy: 'roi' }],
    assertions: [{ id: 'first-dropper', archetype: 'active', metric: 'timeTo', target: 'generator:dropper', op: '<=', value: 60 }],
    ...over,
  };
}
const errs = (raw: unknown) => {
  const r = validateDesign(raw);
  return r.ok ? [] : r.errors.map((e) => `${e.path}: ${e.message}`);
};

describe('validateDesign', () => {
  it('accepts a minimal doc and applies defaults', () => {
    const r = validateDesign(minimal());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.doc.economy.resources[0].spendable).toBe(true);
    expect(r.doc.assertions[0].pct).toBe(50);
    expect(r.doc.assertions[0].clock).toBe('play');
    expect(r.doc.tunables).toEqual({});
  });
  it('reports zod shape errors with paths', () => {
    expect(errs({ ...minimal(), version: 2 }).join()).toMatch(/^version:/);
  });
  it('rejects unknown keys', () => {
    expect(errs({ ...minimal(), bogus: 1 }).length).toBeGreaterThan(0);
  });
  it('rejects duplicate ids', () => {
    const d = minimal();
    (d.economy as any).resources.push({ id: 'cash' });
    expect(errs(d).join()).toMatch(/duplicate id "cash"/);
  });
  it('rejects dangling refs', () => {
    const d = minimal();
    (d.economy as any).generators[0].requires = 'gate:nope';
    expect(errs(d).join()).toMatch(/economy\.generators\.0\.requires: unknown ref "gate:nope"/);
  });
  it('rejects costs on non-spendable resources', () => {
    const d = minimal();
    (d.economy as any).resources.push({ id: 'speed', spendable: false });
    (d.economy as any).generators[0].cost.res = 'speed';
    expect(errs(d).join()).toMatch(/not spendable/);
  });
  it('rejects growth below 1', () => {
    const d = minimal();
    (d.economy as any).generators[0].cost.growth = 0.9;
    expect(errs(d).length).toBeGreaterThan(0);
  });
  it('rejects a gate whose resource nothing produces', () => {
    const d = minimal();
    (d.economy as any).resources.push({ id: 'gems' });
    (d.economy as any).gates = [{ id: 'z2', needs: { res: 'gems', amount: 5 } }];
    expect(errs(d).join()).toMatch(/nothing produces "gems"/);
  });
  it('rejects consume on a stat', () => {
    const d = minimal();
    (d.economy as any).resources.push({ id: 'speed', spendable: false });
    (d.economy as any).actions[0].yields.speed = 1;
    (d.economy as any).gates = [{ id: 'z2', needs: { res: 'speed', amount: 5, consume: true } }];
    expect(errs(d).join()).toMatch(/cannot consume/);
  });
  it('rejects sessions longer than their slot', () => {
    const d = minimal({ archetypes: [{ id: 'active', session: { lengthSec: 50000, perDay: 2 }, policy: 'roi' }] });
    expect(errs(d).join()).toMatch(/longer than its slot/);
  });
  it('requires target for timeTo, res+at for balanceAt, of+vs for ratio', () => {
    const d = minimal({
      archetypes: [
        { id: 'active', session: { lengthSec: 900, perDay: 2 }, policy: 'roi' },
        { id: 'payer', session: { lengthSec: 900, perDay: 2 }, policy: 'roi' },
      ],
      assertions: [
        { id: 'a', archetype: 'active', metric: 'timeTo', op: '<=', value: 1 },
        { id: 'b', archetype: 'active', metric: 'balanceAt', op: '>=', value: 1 },
        { id: 'c', archetype: 'active', metric: 'ratio', op: '<=', value: 3 },
        { id: 'd', archetype: 'active', metric: 'balanceAt', res: 'cash', at: 60, clock: 'play', op: '>=', value: 1 },
        { id: 'e', archetype: 'active', metric: 'timeTo', target: 'generator:dropper', op: 'between', value: 5 },
        { id: 'f', archetype: 'active', metric: 'timeTo', target: 'generator:dropper', op: 'between', value: [9, 2] },
      ],
    });
    const e = errs(d).join('\n');
    expect(e).toMatch(/assertions\.0: timeTo needs target/);
    expect(e).toMatch(/assertions\.1: balanceAt needs res and at/);
    expect(e).toMatch(/assertions\.2: ratio needs of and vs/);
    expect(e).toMatch(/assertions\.3: balanceAt supports clock "wall" only/);
    expect(e).toMatch(/assertions\.4: between needs \[lo, hi\]/);
    expect(e).toMatch(/assertions\.5: between needs lo <= hi/);
  });
  it('accepts non-upgrade monetization effects (sim ignores them)', () => {
    const d = minimal({ monetization: [{ id: 'luck', kind: 'product', effect: 'generator:dropper' }] });
    expect(errs(d)).toEqual([]);
  });
  it('rejects owns that is not a monetization id', () => {
    const d = minimal({ archetypes: [{ id: 'active', session: { lengthSec: 900, perDay: 2 }, policy: 'roi', owns: ['vip'] }] });
    expect(errs(d).join()).toMatch(/unknown monetization "vip"/);
  });
  it('rejects rebirth refs when no rebirth is defined', () => {
    const d = minimal();
    (d.assertions as any)[0].target = 'rebirth:1';
    expect(errs(d).join()).toMatch(/unknown ref "rebirth:1"/);
  });
  it('rejects add on target "*"', () => {
    const d = minimal();
    (d.economy as any).upgrades = [{ id: 'u', cost: { res: 'cash', base: 5 }, effect: { target: '*', add: 1 } }];
    expect(errs(d).join()).toMatch(/add needs a resource target/);
  });
  it('rejects upgrades with both or neither of mult/add', () => {
    const d = minimal();
    (d.economy as any).upgrades = [{ id: 'u', cost: { res: 'cash', base: 5 }, effect: { target: 'cash' } }];
    expect(errs(d).join()).toMatch(/exactly one of mult or add/);
  });
});

describe('parseRef', () => {
  it('splits kind, id and optional count', () => {
    expect(parseRef('generator:dropper:3')).toEqual({ kind: 'generator', id: 'dropper', n: 3 });
    expect(parseRef('gate:z2')).toEqual({ kind: 'gate', id: 'z2' });
    expect(parseRef('rebirth:2')).toEqual({ kind: 'rebirth', id: '2' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/design.schema.test.ts`
Expected: FAIL — cannot resolve `../src/design/schema.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/design/schema.ts
import { z } from 'zod';

// .blox/design.json — the machine-checked game design. Descriptive fields
// (meta, loop, ftue, monetization) are shape-checked for later pipeline stages;
// economy + archetypes + assertions drive the offline simulator (sim.ts).

const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'ids start with a letter; letters, digits, _ and - only');
const Ref = z.string().regex(/^[a-z]+:[A-Za-z0-9_-]+(:\d+)?$/, 'expected kind:id (e.g. gate:zone2)');
const Cost = z.object({ res: Id, base: z.number().positive(), growth: z.number().min(1).default(1) }).strict();

const Assertion = z
  .object({
    id: Id,
    archetype: Id,
    metric: z.enum(['timeTo', 'countAt', 'balanceAt', 'maxIdleGap', 'ratio']),
    of: z.enum(['timeTo', 'countAt', 'balanceAt', 'maxIdleGap']).optional(),
    vs: Id.optional(),
    target: Ref.optional(),
    res: Id.optional(),
    at: z.number().nonnegative().optional(),
    horizon: z.number().int().positive().optional(),
    op: z.enum(['<=', '>=', 'between']),
    value: z.union([z.number(), z.tuple([z.number(), z.number()])]),
    pct: z.union([z.literal(10), z.literal(50), z.literal(90)]).default(50),
    clock: z.enum(['play', 'wall']).default('play'),
  })
  .strict();

export const DesignSchema = z
  .object({
    version: z.literal(1),
    meta: z
      .object({
        title: z.string().min(1),
        format: z.enum(['incremental', 'steal-tycoon', 'round', 'survival', 'collection', 'battlegrounds', 'other']),
        verb: z.string().optional(),
        object: z.string().optional(),
        serverSize: z.number().int().positive().optional(),
      })
      .strict(),
    loop: z.array(z.string()).default([]),
    ftue: z.array(z.object({ id: Id, text: z.string(), targetSec: z.number().nonnegative() }).strict()).default([]),
    monetization: z
      .array(z.object({ id: Id, kind: z.enum(['pass', 'product', 'subscription']), effect: Ref }).strict())
      .default([]),
    economy: z
      .object({
        resources: z
          .array(z.object({ id: Id, start: z.number().nonnegative().default(0), spendable: z.boolean().default(true) }).strict())
          .min(1),
        actions: z
          .array(z.object({ id: Id, yields: z.record(Id, z.number()), perSec: z.number().positive(), requires: Ref.optional() }).strict())
          .default([]),
        generators: z
          .array(
            z
              .object({
                id: Id,
                produces: z.record(Id, z.number().nonnegative()),
                cost: Cost,
                max: z.number().int().positive().optional(),
                requires: Ref.optional(),
              })
              .strict(),
          )
          .default([]),
        upgrades: z
          .array(
            z
              .object({
                id: Id,
                cost: Cost,
                effect: z.object({ target: z.string(), mult: z.number().positive().optional(), add: z.number().optional() }).strict(),
                max: z.number().int().positive().default(1),
                requires: Ref.optional(),
              })
              .strict(),
          )
          .default([]),
        gates: z
          .array(
            z
              .object({
                id: Id,
                needs: z.object({ res: Id, amount: z.number().positive(), consume: z.boolean().default(false) }).strict(),
                requires: Ref.optional(),
              })
              .strict(),
          )
          .default([]),
        chance: z
          .array(
            z
              .object({
                id: Id,
                cost: Cost,
                outcomes: z.array(z.object({ id: Id, weight: z.number().positive(), grants: z.record(Ref, z.number()) }).strict()).min(1),
                max: z.number().int().positive().optional(),
                requires: Ref.optional(),
              })
              .strict(),
          )
          .default([]),
        rebirth: z
          .object({
            needs: Cost,
            mult: z.object({ target: z.string(), per: z.number().min(1) }).strict(),
            resets: z.array(z.string()).default([]),
          })
          .strict()
          .optional(),
        offline: z.object({ fraction: z.number().min(0).max(1), capSec: z.number().nonnegative() }).strict().optional(),
        drains: z.array(z.object({ id: Id, res: Id, fractionPerHour: z.number().min(0).max(1) }).strict()).default([]),
      })
      .strict(),
    tunables: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).default({}),
    archetypes: z
      .array(
        z
          .object({
            id: Id,
            session: z.object({ lengthSec: z.number().int().positive(), perDay: z.number().int().positive() }).strict(),
            policy: z.enum(['roi', 'cheapest', 'saver']),
            owns: z.array(Id).default([]),
          })
          .strict(),
      )
      .min(1),
    assertions: z.array(Assertion).default([]),
  })
  .strict();

export type DesignDoc = z.infer<typeof DesignSchema>;
export type Archetype = DesignDoc['archetypes'][number];
export type Assertion = DesignDoc['assertions'][number];
export interface DesignError {
  path: string;
  message: string;
}

export const RESET_KEYWORDS = ['generators', 'upgrades', 'gates', 'chance'] as const;

export function parseRef(ref: string): { kind: string; id: string; n?: number } {
  const [kind, id, n] = ref.split(':');
  return n === undefined ? { kind, id } : { kind, id, n: Number(n) };
}

function refExists(doc: DesignDoc, ref: string): boolean {
  const { kind, id } = parseRef(ref);
  const e = doc.economy;
  const has = (xs: { id: string }[]) => xs.some((x) => x.id === id);
  switch (kind) {
    case 'gate':
      return has(e.gates);
    case 'upgrade':
      return has(e.upgrades);
    case 'generator':
      return has(e.generators);
    case 'chance':
      return has(e.chance);
    case 'action':
      return has(e.actions);
    case 'res':
    case 'income':
      return has(e.resources);
    case 'rebirth':
      return !!e.rebirth && /^[1-9]\d*$/.test(id);
    default:
      return false;
  }
}

function semanticErrors(doc: DesignDoc): DesignError[] {
  const out: DesignError[] = [];
  const err = (path: string, message: string) => out.push({ path, message });
  const e = doc.economy;
  const resIds = new Set(e.resources.map((r) => r.id));
  const spendable = new Set(e.resources.filter((r) => r.spendable).map((r) => r.id));

  const uniq = (path: string, xs: { id: string }[]) => {
    const seen = new Set<string>();
    xs.forEach((x, i) => {
      if (seen.has(x.id)) err(`${path}.${i}.id`, `duplicate id "${x.id}"`);
      seen.add(x.id);
    });
  };
  uniq('economy.resources', e.resources);
  uniq('economy.actions', e.actions);
  uniq('economy.generators', e.generators);
  uniq('economy.upgrades', e.upgrades);
  uniq('economy.gates', e.gates);
  uniq('economy.chance', e.chance);
  uniq('economy.drains', e.drains);
  uniq('archetypes', doc.archetypes);
  uniq('assertions', doc.assertions);
  uniq('monetization', doc.monetization);
  uniq('ftue', doc.ftue);

  const ref = (path: string, r: string | undefined) => {
    if (r !== undefined && !refExists(doc, r)) err(path, `unknown ref "${r}"`);
  };
  const res = (path: string, r: string) => {
    if (!resIds.has(r)) err(path, `unknown resource "${r}"`);
  };
  const cost = (path: string, c: { res: string }) => {
    if (!resIds.has(c.res)) err(`${path}.res`, `unknown resource "${c.res}"`);
    else if (!spendable.has(c.res)) err(`${path}.res`, `"${c.res}" is not spendable`);
  };
  const target = (path: string, t: string) => {
    if (t !== '*' && !resIds.has(t)) err(path, `unknown target "${t}" (resource id or "*")`);
  };

  e.actions.forEach((a, i) => {
    Object.keys(a.yields).forEach((r) => res(`economy.actions.${i}.yields.${r}`, r));
    ref(`economy.actions.${i}.requires`, a.requires);
  });
  e.generators.forEach((g, i) => {
    Object.keys(g.produces).forEach((r) => res(`economy.generators.${i}.produces.${r}`, r));
    cost(`economy.generators.${i}.cost`, g.cost);
    ref(`economy.generators.${i}.requires`, g.requires);
  });
  e.upgrades.forEach((u, i) => {
    cost(`economy.upgrades.${i}.cost`, u.cost);
    ref(`economy.upgrades.${i}.requires`, u.requires);
    target(`economy.upgrades.${i}.effect.target`, u.effect.target);
    if ((u.effect.mult === undefined) === (u.effect.add === undefined)) err(`economy.upgrades.${i}.effect`, 'exactly one of mult or add');
    if (u.effect.add !== undefined && u.effect.target === '*') err(`economy.upgrades.${i}.effect`, 'add needs a resource target, not "*"');
  });
  e.chance.forEach((c, i) => {
    cost(`economy.chance.${i}.cost`, c.cost);
    ref(`economy.chance.${i}.requires`, c.requires);
    c.outcomes.forEach((o, j) =>
      Object.keys(o.grants).forEach((g) => {
        const k = parseRef(g).kind;
        if (k !== 'income' && k !== 'res') err(`economy.chance.${i}.outcomes.${j}.grants.${g}`, 'grants keys are income:<res> or res:<res>');
        else ref(`economy.chance.${i}.outcomes.${j}.grants.${g}`, g);
      }),
    );
  });
  const producible = (r: string) =>
    e.actions.some((a) => (a.yields[r] ?? 0) > 0) ||
    e.generators.some((g) => (g.produces[r] ?? 0) > 0) ||
    e.upgrades.some((u) => u.effect.target === r && (u.effect.add ?? 0) > 0) ||
    e.chance.some((c) => c.outcomes.some((o) => (o.grants[`income:${r}`] ?? 0) > 0 || (o.grants[`res:${r}`] ?? 0) > 0));
  e.gates.forEach((g, i) => {
    const p = `economy.gates.${i}.needs.res`;
    if (!resIds.has(g.needs.res)) return err(p, `unknown resource "${g.needs.res}"`);
    if (g.needs.consume && !spendable.has(g.needs.res)) err(p, `cannot consume non-spendable "${g.needs.res}"`);
    const start = e.resources.find((r) => r.id === g.needs.res)!.start;
    if (start < g.needs.amount && !producible(g.needs.res)) err(p, `nothing produces "${g.needs.res}"`);
    ref(`economy.gates.${i}.requires`, g.requires);
  });
  if (e.rebirth) {
    cost('economy.rebirth.needs', e.rebirth.needs);
    target('economy.rebirth.mult.target', e.rebirth.mult.target);
    e.rebirth.resets.forEach((r, i) => {
      if (!resIds.has(r) && !(RESET_KEYWORDS as readonly string[]).includes(r))
        err(`economy.rebirth.resets.${i}`, `"${r}" is not a resource id or one of ${RESET_KEYWORDS.join(', ')}`);
    });
  }
  e.drains.forEach((d, i) => res(`economy.drains.${i}.res`, d.res));
  doc.monetization.forEach((m, i) => ref(`monetization.${i}.effect`, m.effect));

  const archIds = new Set(doc.archetypes.map((a) => a.id));
  const monIds = new Set(doc.monetization.map((m) => m.id));
  doc.archetypes.forEach((a, i) => {
    if (a.session.lengthSec > Math.floor(86400 / a.session.perDay))
      err(`archetypes.${i}.session`, `lengthSec ${a.session.lengthSec} is longer than its slot (86400/${a.session.perDay})`);
    a.owns.forEach((o, j) => {
      if (!monIds.has(o)) err(`archetypes.${i}.owns.${j}`, `unknown monetization "${o}"`);
    });
  });

  doc.assertions.forEach((a, i) => {
    const p = `assertions.${i}`;
    if (!archIds.has(a.archetype)) err(`${p}.archetype`, `unknown archetype "${a.archetype}"`);
    const m = a.metric === 'ratio' ? a.of : a.metric;
    if (a.metric === 'ratio') {
      if (!a.of || !a.vs) err(p, 'ratio needs of and vs');
      else if (!archIds.has(a.vs)) err(`${p}.vs`, `unknown archetype "${a.vs}"`);
    }
    if ((m === 'timeTo' || m === 'countAt') && !a.target) err(p, `${m} needs target`);
    if (m === 'countAt' && a.at === undefined) err(p, 'countAt needs at');
    if (m === 'balanceAt') {
      if (!a.res || a.at === undefined) err(p, 'balanceAt needs res and at');
      else res(`${p}.res`, a.res);
      if (a.clock !== 'wall') err(p, 'balanceAt supports clock "wall" only');
    }
    ref(`${p}.target`, a.target);
    if (a.op === 'between') {
      if (!Array.isArray(a.value)) err(p, 'between needs [lo, hi]');
      else if (a.value[0] > a.value[1]) err(p, 'between needs lo <= hi');
    } else if (Array.isArray(a.value)) err(p, `${a.op} needs a single number`);
  });
  return out;
}

export function validateDesign(raw: unknown): { ok: true; doc: DesignDoc } | { ok: false; errors: DesignError[] } {
  const parsed = DesignSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  const errors = semanticErrors(parsed.data);
  return errors.length ? { ok: false, errors } : { ok: true, doc: parsed.data };
}

export function formatErrors(errors: DesignError[]): string {
  return errors.map((e) => `  ${e.path || '(root)'}: ${e.message}`).join('\n');
}
```

Note: the balanceAt-clock test uses `clock: 'play'` explicitly; since `clock` defaults to `play`, a `balanceAt` assertion must always set `clock: "wall"`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/design.schema.test.ts`
Expected: PASS (all). If `assertions.1` also reports the wall-only error, that's fine — the test only checks that the required messages are present.

- [ ] **Step 5: Commit**

```bash
git add src/design/schema.ts tests/design.schema.test.ts
git commit -m "feat(design): design.json schema + semantic validation"
```

---

### Task 2: Simulator core

**Files:**
- Create: `src/design/sim.ts`
- Test: `tests/design.sim.test.ts`

**Interfaces:**
- Consumes: `DesignDoc`, `Archetype`, `parseRef`, `validateDesign` (tests) from Task 1.
- Produces:
  - `interface SimEvent { t: number; play: number; ref: string; n: number }` — `ref` is `generator:<id>`, `upgrade:<id>`, `chance:<id>`, `gate:<id>`, or `rebirth`; `n` = count after the event (rebirth number for `rebirth`).
  - `interface SimSample { t: number; play: number; bal: Record<string, number> }`
  - `interface Trace { archetype: string; seed: number; horizonSec: number; events: SimEvent[]; samples: SimSample[]; endPlay: number }`
  - `interface SimOptions { archetype: string; horizonSec: number; seed: number; probes?: number[]; mode?: 'skip' | 'tick' }`
  - `class SimError extends Error`
  - `simulate(doc: DesignDoc, opts: SimOptions): Trace`
  - `mulberry32(seed: number): () => number`
  - `ttr(b0: number, target: number, rate: number, decay: number): number`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/design.sim.test.ts
import { describe, it, expect } from 'vitest';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';
import { simulate, ttr, mulberry32, SimError } from '../src/design/sim.js';

function doc(raw: Record<string, unknown>): DesignDoc {
  const r = validateDesign({ version: 1, meta: { title: 'T', format: 'other' }, ...raw });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}
const always = [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'roi' }];
const first = (tr: { events: { ref: string; n: number; t: number }[] }, ref: string, n = 1) => tr.events.find((e) => e.ref === ref && e.n >= n);

describe('ttr', () => {
  it('linear', () => expect(ttr(0, 10, 2, 0)).toBe(5));
  it('already there', () => expect(ttr(10, 10, 0, 0)).toBe(0));
  it('no income', () => expect(ttr(0, 10, 0, 0)).toBe(Infinity));
  it('decay below target equilibrium is never', () => expect(ttr(0, 10, 1, 0.2)).toBe(Infinity)); // eq = 5
  it('decay with reachable target', () => expect(ttr(0, 5, 1, 0.1)).toBeCloseTo(Math.log(2) / 0.1, 9)); // eq = 10
});

describe('mulberry32', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(7), b = mulberry32(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(mulberry32(8)()).not.toBe(mulberry32(7)());
  });
});

describe('simulate', () => {
  it('buys the first generator when affordable (closed form)', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash' }],
        actions: [{ id: 'click', yields: { cash: 2 }, perSec: 1 }],
        generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 10 }, max: 1 }],
      },
      archetypes: always,
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 100, seed: 1 });
    expect(first(tr, 'generator:g')!.t).toBe(5);
  });
  it('generator cost grows by growth^owned', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash', start: 100 }],
        generators: [{ id: 'g', produces: { cash: 0 }, cost: { res: 'cash', base: 10, growth: 2 }, max: 3 }],
      },
      archetypes: [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'cheapest' }],
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 10, seed: 1 });
    expect(tr.events.filter((e) => e.ref === 'generator:g').length).toBe(3); // 10+20+40 = 70 <= 100
    expect(tr.samples.length).toBe(0);
  });
  it('requires gates purchases until the gate opens (auto-open on threshold)', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash' }, { id: 'speed', spendable: false }],
        actions: [{ id: 'walk', yields: { speed: 1, cash: 1 }, perSec: 1 }],
        gates: [{ id: 'z2', needs: { res: 'speed', amount: 30 } }],
        generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 1 }, max: 1, requires: 'gate:z2' }],
      },
      archetypes: always,
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 100, seed: 1 });
    expect(first(tr, 'gate:z2')!.t).toBe(30);
    expect(first(tr, 'generator:g')!.t).toBe(30);
  });
  it('offline earns fraction up to cap, actions stop offline', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash', start: 0 }],
        upgrades: [{ id: 'base', cost: { res: 'cash', base: 1e12 }, effect: { target: 'cash', add: 1 } }],
        offline: { fraction: 0.5, capSec: 100 },
      },
      archetypes: [{ id: 'a', session: { lengthSec: 10, perDay: 1 }, policy: 'roi' }],
    });
    // no generators owned → no income at all; prove offline uses generator income only
    const tr = simulate(d, { archetype: 'a', horizonSec: 1000, seed: 1, probes: [1000] });
    expect(tr.samples.at(-1)!.bal.cash).toBe(0);
    const d2 = doc({
      economy: {
        resources: [{ id: 'cash', start: 10 }],
        generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 10 }, max: 1 }],
        offline: { fraction: 0.5, capSec: 100 },
      },
      archetypes: [{ id: 'a', session: { lengthSec: 10, perDay: 1 }, policy: 'roi' }],
    });
    const t2 = simulate(d2, { archetype: 'a', horizonSec: 1000, seed: 1, probes: [10, 1000] });
    // bought at t=0, online 10s → 10 cash; offline 100s × 0.5 → +50
    expect(t2.samples[0].bal.cash).toBeCloseTo(10, 9);
    expect(t2.samples[1].bal.cash).toBeCloseTo(60, 9);
    expect(t2.endPlay).toBe(10);
  });
  it('drains decay balances', () => {
    const d = doc({
      economy: { resources: [{ id: 'cash', start: 1000 }], drains: [{ id: 'theft', res: 'cash', fractionPerHour: 0.5 }] },
      archetypes: always,
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 3600, seed: 1, probes: [3600] });
    expect(tr.samples[0].bal.cash).toBeCloseTo(1000 * Math.exp(-0.5), 6);
  });
  it('rebirth resets listed state, multiplies income, and re-grants owned passes', () => {
    const d = doc({
      monetization: [{ id: 'x2', kind: 'pass', effect: 'upgrade:x2' }],
      economy: {
        resources: [{ id: 'cash' }],
        actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1 }],
        upgrades: [{ id: 'x2', cost: { res: 'cash', base: 1e9 }, effect: { target: 'cash', mult: 2 } }],
        rebirth: { needs: { res: 'cash', base: 100, growth: 1 }, mult: { target: '*', per: 2 }, resets: ['cash', 'upgrades'] },
      },
      archetypes: [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'roi', owns: ['x2'] }],
    });
    const tr = simulate(d, { archetype: 'a', horizonSec: 200, seed: 1 });
    // income 2/s (pass) → rebirth 1 at 50s; then 4/s → rebirth 2 at 75s
    expect(first(tr, 'rebirth', 1)!.t).toBe(50);
    expect(first(tr, 'rebirth', 2)!.t).toBe(75);
  });
  it('chance rolls are seeded and deterministic', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash', start: 1000 }],
        chance: [{ id: 'egg', cost: { res: 'cash', base: 10 }, max: 20, outcomes: [{ id: 'c', weight: 9, grants: { 'res:cash': 1 } }, { id: 'r', weight: 1, grants: { 'res:cash': 100 } }] }],
      },
      archetypes: [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'cheapest' }],
    });
    const a = simulate(d, { archetype: 'a', horizonSec: 5, seed: 3, probes: [5] });
    const b = simulate(d, { archetype: 'a', horizonSec: 5, seed: 3, probes: [5] });
    expect(a.samples).toEqual(b.samples);
    const balances = new Set([1, 2, 3, 4, 5, 6].map((s) => simulate(d, { archetype: 'a', horizonSec: 5, seed: s, probes: [5] }).samples[0].bal.cash));
    expect(balances.size).toBeGreaterThan(1);
  });
  it('event skipping matches the plain 1 s loop', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash' }],
        actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1.5 }],
        generators: [{ id: 'g', produces: { cash: 0.7 }, cost: { res: 'cash', base: 7, growth: 1.13 } }],
        upgrades: [{ id: 'u', cost: { res: 'cash', base: 120 }, effect: { target: 'cash', mult: 1.5 }, max: 3 }],
        drains: [{ id: 'd', res: 'cash', fractionPerHour: 0.02 }],
        offline: { fraction: 0.3, capSec: 3600 },
      },
      archetypes: [{ id: 'a', session: { lengthSec: 1200, perDay: 3 }, policy: 'roi' }],
    });
    const o = { archetype: 'a', horizonSec: 86400, seed: 1, probes: [43200, 86400] };
    const skip = simulate(d, { ...o, mode: 'skip' });
    const tick = simulate(d, { ...o, mode: 'tick' });
    expect(skip.events.map((e) => `${e.ref}#${e.n}@${e.t}`)).toEqual(tick.events.map((e) => `${e.ref}#${e.n}@${e.t}`));
    expect(skip.samples[1].bal.cash).toBeCloseTo(tick.samples[1].bal.cash, 6);
  });
  it('runaway economies raise a named SimError', () => {
    const d = doc({
      economy: {
        resources: [{ id: 'cash', start: 1 }],
        actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1 }],
        rebirth: { needs: { res: 'cash', base: 1, growth: 1 }, mult: { target: '*', per: 1000 }, resets: [] },
      },
      archetypes: always,
    });
    expect(() => simulate(d, { archetype: 'a', horizonSec: 86400, seed: 1 })).toThrow(SimError);
  });
  it('monetization with non-upgrade effect is ignored', () => {
    const d = doc({
      monetization: [{ id: 'luck', kind: 'product', effect: 'generator:g' }],
      economy: {
        resources: [{ id: 'cash' }],
        actions: [{ id: 'click', yields: { cash: 1 }, perSec: 1 }],
        generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 5 }, max: 1 }],
      },
      archetypes: [{ id: 'a', session: { lengthSec: 86400, perDay: 1 }, policy: 'roi', owns: ['luck'] }],
    });
    expect(first(simulate(d, { archetype: 'a', horizonSec: 20, seed: 1 }), 'generator:g')!.t).toBe(5);
  });
  it('unknown archetype throws SimError', () => {
    const d = doc({ economy: { resources: [{ id: 'cash' }] }, archetypes: always });
    expect(() => simulate(d, { archetype: 'nope', horizonSec: 10, seed: 1 })).toThrow(/unknown archetype/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/design.sim.test.ts`
Expected: FAIL — cannot resolve `../src/design/sim.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/design/sim.ts
import { parseRef, type Archetype, type DesignDoc } from './schema.js';

// Offline economy simulator. Rates are constant between events, so balances
// advance in closed form (linear, or exponential approach when drains apply)
// and the clock jumps straight to the next moment something can change
// (an item becomes affordable, a gate threshold, a session edge, a probe).
// mode 'tick' forces 1 s online steps; tests use it to prove skipping is exact.

export interface SimEvent {
  t: number;
  play: number;
  ref: string;
  n: number;
}
export interface SimSample {
  t: number;
  play: number;
  bal: Record<string, number>;
}
export interface Trace {
  archetype: string;
  seed: number;
  horizonSec: number;
  events: SimEvent[];
  samples: SimSample[];
  endPlay: number;
}
export interface SimOptions {
  archetype: string;
  horizonSec: number;
  seed: number;
  probes?: number[];
  mode?: 'skip' | 'tick';
}
export class SimError extends Error {}

export const MAX_STEPS = 2_000_000;
const EPS = 1e-9;
const ge = (a: number, b: number) => a >= b - EPS * Math.max(1, Math.abs(b));

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seconds until balance b0 reaches target under income `rate` and proportional
// decay `decay` (per second). Infinity when it never does.
export function ttr(b0: number, target: number, rate: number, decay: number): number {
  if (ge(b0, target)) return 0;
  if (decay === 0) return rate > 0 ? (target - b0) / rate : Infinity;
  const eq = rate / decay;
  if (eq <= target) return Infinity;
  return Math.log((eq - b0) / (eq - target)) / decay;
}

type Kind = 'generator' | 'upgrade' | 'chance' | 'gate' | 'rebirth';
interface Item {
  ref: string;
  kind: Kind;
  id: string;
  cost: { res: string; base: number; growth: number };
  max: number;
  requires?: string;
  goal: boolean;
}
interface State {
  t: number;
  play: number;
  bal: Record<string, number>;
  owned: Record<string, number>;
  open: Set<string>;
  chanceIncome: Record<string, number>;
}

function buildItems(doc: DesignDoc): Item[] {
  const e = doc.economy;
  const items: Item[] = [];
  for (const g of e.generators) items.push({ ref: `generator:${g.id}`, kind: 'generator', id: g.id, cost: g.cost, max: g.max ?? Infinity, requires: g.requires, goal: false });
  for (const u of e.upgrades) items.push({ ref: `upgrade:${u.id}`, kind: 'upgrade', id: u.id, cost: u.cost, max: u.max, requires: u.requires, goal: false });
  for (const c of e.chance) items.push({ ref: `chance:${c.id}`, kind: 'chance', id: c.id, cost: c.cost, max: c.max ?? Infinity, requires: c.requires, goal: false });
  for (const g of e.gates)
    if (g.needs.consume)
      items.push({ ref: `gate:${g.id}`, kind: 'gate', id: g.id, cost: { res: g.needs.res, base: g.needs.amount, growth: 1 }, max: 1, requires: g.requires, goal: true });
  if (e.rebirth) items.push({ ref: 'rebirth', kind: 'rebirth', id: 'rebirth', cost: e.rebirth.needs, max: Infinity, goal: true });
  return items;
}

function requiresMet(s: State, ref: string | undefined): boolean {
  if (!ref) return true;
  const { kind, id, n } = parseRef(ref);
  if (kind === 'gate') return s.open.has(id);
  if (kind === 'rebirth') return (s.owned.rebirth ?? 0) >= Number(id);
  if (kind === 'action') return true;
  return (s.owned[`${kind}:${id}`] ?? 0) >= (n ?? 1);
}

const count = (s: State, i: Item) => s.owned[i.ref] ?? 0;
const costOf = (s: State, i: Item) => i.cost.base * Math.pow(i.cost.growth, count(s, i));
const available = (s: State, i: Item) => requiresMet(s, i.requires) && count(s, i) < i.max && !(i.kind === 'gate' && s.open.has(i.id));

function rates(doc: DesignDoc, s: State, online: boolean): Record<string, number> {
  const e = doc.economy;
  const base: Record<string, number> = {};
  for (const r of e.resources) base[r.id] = 0;
  if (online)
    for (const a of e.actions) if (requiresMet(s, a.requires)) for (const [r, v] of Object.entries(a.yields)) base[r] += v * a.perSec;
  for (const g of e.generators) {
    const n = s.owned[`generator:${g.id}`] ?? 0;
    if (n) for (const [r, v] of Object.entries(g.produces)) base[r] += v * n;
  }
  for (const u of e.upgrades) {
    const n = s.owned[`upgrade:${u.id}`] ?? 0;
    if (n && u.effect.add !== undefined) base[u.effect.target] += u.effect.add * n;
  }
  for (const [r, v] of Object.entries(s.chanceIncome)) base[r] += v;
  const out: Record<string, number> = {};
  for (const r of Object.keys(base)) {
    let m = 1;
    for (const u of e.upgrades) {
      const n = s.owned[`upgrade:${u.id}`] ?? 0;
      if (n && u.effect.mult !== undefined && (u.effect.target === r || u.effect.target === '*')) m *= Math.pow(u.effect.mult, n);
    }
    const rb = e.rebirth;
    if (rb && (rb.mult.target === r || rb.mult.target === '*')) m *= Math.pow(rb.mult.per, s.owned.rebirth ?? 0);
    out[r] = base[r] * m;
  }
  return out;
}

function decays(doc: DesignDoc): Record<string, number> {
  const k: Record<string, number> = {};
  for (const r of doc.economy.resources) k[r.id] = 0;
  for (const d of doc.economy.drains) k[d.res] += d.fractionPerHour / 3600;
  return k;
}

function advance(s: State, dt: number, r: Record<string, number>, k: Record<string, number>): void {
  for (const id of Object.keys(s.bal)) {
    const b0 = s.bal[id];
    if (k[id] === 0) s.bal[id] = b0 + r[id] * dt;
    else {
      const eq = r[id] / k[id];
      s.bal[id] = eq + (b0 - eq) * Math.exp(-k[id] * dt);
    }
  }
}

function grantOwned(doc: DesignDoc, s: State, arch: Archetype): void {
  for (const m of doc.monetization) {
    if (!arch.owns.includes(m.id)) continue;
    const { kind, id } = parseRef(m.effect);
    if (kind !== 'upgrade') continue; // v1 simulates upgrade effects only
    const u = doc.economy.upgrades.find((x) => x.id === id)!;
    s.owned[`upgrade:${id}`] = u.max;
  }
}

function applyGrants(s: State, grants: Record<string, number>, scale: number): void {
  for (const [g, v] of Object.entries(grants)) {
    const { kind, id } = parseRef(g);
    if (kind === 'income') s.chanceIncome[id] = (s.chanceIncome[id] ?? 0) + v * scale;
    else if (scale === 1) s.bal[id] += v; // one-off grants only on real rolls
  }
}

function applyEffect(doc: DesignDoc, s: State, arch: Archetype, i: Item, roll: (() => number) | null): void {
  s.owned[i.ref] = count(s, i) + 1;
  if (i.kind === 'gate') s.open.add(i.id);
  if (i.kind === 'chance') {
    const c = doc.economy.chance.find((x) => x.id === i.id)!;
    const total = c.outcomes.reduce((a, o) => a + o.weight, 0);
    if (!roll) for (const o of c.outcomes) applyGrants(s, o.grants, o.weight / total); // expected value
    else {
      let x = roll() * total;
      const o = c.outcomes.find((o) => (x -= o.weight) < 0) ?? c.outcomes[c.outcomes.length - 1];
      applyGrants(s, o.grants, 1);
    }
  }
  if (i.kind === 'rebirth') {
    for (const r of doc.economy.rebirth!.resets) {
      const res = doc.economy.resources.find((x) => x.id === r);
      if (res) s.bal[r] = res.start;
      else if (r === 'gates') s.open.clear();
      else {
        const prefix = r === 'generators' ? 'generator:' : r === 'upgrades' ? 'upgrade:' : 'chance:';
        for (const key of Object.keys(s.owned)) if (key.startsWith(prefix)) delete s.owned[key];
        if (r === 'chance') s.chanceIncome = {};
      }
    }
    grantOwned(doc, s, arch);
  }
}

const clone = (s: State): State => ({ ...s, bal: { ...s.bal }, owned: { ...s.owned }, open: new Set(s.open), chanceIncome: { ...s.chanceIncome } });

function payback(doc: DesignDoc, s: State, arch: Archetype, i: Item, now: Record<string, number>): number {
  const after = clone(s);
  applyEffect(doc, after, arch, i, null);
  const next = rates(doc, after, true);
  const c = costOf(s, i);
  const res = i.cost.res;
  const d = next[res] - now[res];
  if (d > EPS) return c / d;
  let rel = 0;
  for (const r of Object.keys(next)) {
    const dd = next[r] - now[r];
    if (dd > EPS) rel += now[r] > 0 ? dd / now[r] : 1;
  }
  return rel > 0 && now[res] > 0 ? c / (now[res] * rel) : Infinity;
}

function choose(doc: DesignDoc, s: State, arch: Archetype, items: Item[], r: Record<string, number>, k: Record<string, number>): Item | null {
  const avail = items.filter((i) => available(s, i));
  const affordable = avail.filter((i) => ge(s.bal[i.cost.res], costOf(s, i)));
  const cheapest = () => affordable.sort((a, b) => costOf(s, a) - costOf(s, b) || (a.ref < b.ref ? -1 : 1))[0] ?? null;
  if (arch.policy === 'cheapest') return cheapest();
  const goalWeight = arch.policy === 'saver' ? 0.5 : 1;
  let best: Item | null = null;
  let bestScore = Infinity;
  for (const i of avail) {
    const t = ttr(s.bal[i.cost.res], costOf(s, i), r[i.cost.res], k[i.cost.res]);
    const score = i.goal ? t * goalWeight : t + payback(doc, s, arch, i, r);
    if (score < bestScore) {
      best = i;
      bestScore = score;
    }
  }
  if (!best) return cheapest(); // nothing scores finite: fall back to cheapest affordable
  return affordable.includes(best) ? best : null; // otherwise save for the best item
}

export function simulate(doc: DesignDoc, opts: SimOptions): Trace {
  const arch = doc.archetypes.find((a) => a.id === opts.archetype);
  if (!arch) throw new SimError(`unknown archetype "${opts.archetype}"`);
  const H = opts.horizonSec;
  const roll = mulberry32(opts.seed);
  const items = buildItems(doc);
  const k = decays(doc);
  const zero: Record<string, number> = Object.fromEntries(doc.economy.resources.map((r) => [r.id, 0]));
  const s: State = { t: 0, play: 0, bal: Object.fromEntries(doc.economy.resources.map((r) => [r.id, r.start])), owned: {}, open: new Set(), chanceIncome: {} };
  grantOwned(doc, s, arch);
  const autoGates = doc.economy.gates.filter((g) => !g.needs.consume);
  const period = Math.floor(86400 / arch.session.perDay);
  const len = arch.session.lengthSec;
  const probes = [...new Set(opts.probes ?? [])].filter((p) => p >= 0 && p <= H).sort((a, b) => a - b);
  let pi = 0;
  const events: SimEvent[] = [];
  const samples: SimSample[] = [];
  let steps = 0;
  let last = 'start';
  const bump = () => {
    if (++steps > MAX_STEPS) throw new SimError(`runaway economy: over ${MAX_STEPS} steps (last: ${last})`);
  };
  const openGates = () => {
    for (const g of autoGates)
      if (!s.open.has(g.id) && requiresMet(s, g.requires) && ge(s.bal[g.needs.res], g.needs.amount)) {
        s.open.add(g.id);
        events.push({ t: s.t, play: s.play, ref: `gate:${g.id}`, n: 1 });
      }
  };

  for (;;) {
    while (pi < probes.length && probes[pi] <= s.t) {
      samples.push({ t: s.t, play: s.play, bal: { ...s.bal } });
      pi++;
    }
    if (s.t >= H) break;
    const dayPos = s.t % period;
    const online = dayPos < len;
    const edge = s.t - dayPos + (online ? len : period);
    const bound = Math.min(edge, H, pi < probes.length ? probes[pi] : Infinity) - s.t;
    let dt: number;
    if (online) {
      openGates();
      for (;;) {
        const r = rates(doc, s, true);
        const it = choose(doc, s, arch, items, r, k);
        if (!it) break;
        s.bal[it.cost.res] -= costOf(s, it);
        applyEffect(doc, s, arch, it, roll);
        events.push({ t: s.t, play: s.play, ref: it.ref, n: s.owned[it.ref] });
        last = it.ref;
        bump();
        openGates();
      }
      const r = rates(doc, s, true);
      let need = Infinity;
      for (const i of items) if (available(s, i)) need = Math.min(need, ttr(s.bal[i.cost.res], costOf(s, i), r[i.cost.res], k[i.cost.res]) || Infinity);
      for (const g of autoGates)
        if (!s.open.has(g.id) && requiresMet(s, g.requires)) need = Math.min(need, ttr(s.bal[g.needs.res], g.needs.amount, r[g.needs.res], k[g.needs.res]) || Infinity);
      dt = Math.min(opts.mode === 'tick' ? 1 : Math.max(1, Math.ceil(need)), bound);
      advance(s, dt, r, k);
      s.play += dt;
    } else {
      const capEnd = s.t - dayPos + len + (doc.economy.offline?.capSec ?? 0);
      if (doc.economy.offline && s.t < capEnd) {
        const f = doc.economy.offline.fraction;
        const r = Object.fromEntries(Object.entries(rates(doc, s, false)).map(([id, v]) => [id, v * f]));
        dt = Math.min(bound, capEnd - s.t);
        advance(s, dt, r, k);
      } else {
        dt = bound;
        advance(s, dt, zero, k);
      }
    }
    s.t += dt;
    bump();
    for (const [id, v] of Object.entries(s.bal)) if (!Number.isFinite(v)) throw new SimError(`balance of "${id}" became ${v} (last: ${last})`);
  }
  return { archetype: arch.id, seed: opts.seed, horizonSec: H, events, samples, endPlay: s.play };
}
```

Note the `|| Infinity` after `ttr(...)`: a ttr of 0 means affordable but not chosen (the policy is saving) — it must not force a 1 s wake-up loop; other candidates or edges bound the step.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/design.sim.test.ts`
Expected: PASS. If the skip-vs-tick test differs by one second on a single event, check that `ge` is used for every affordability comparison (floating error from composing many 1 s closed-form steps).

- [ ] **Step 5: Commit**

```bash
git add src/design/sim.ts tests/design.sim.test.ts
git commit -m "feat(design): deterministic event-skipping economy simulator"
```

---

### Task 3: Metrics + assertions

**Files:**
- Create: `src/design/metrics.ts`, `src/design/assert.ts`
- Test: `tests/design.assert.test.ts`

**Interfaces:**
- Consumes: `Trace`, `SimEvent` (Task 2); `Assertion`, `DesignDoc`, `parseRef` (Task 1).
- Produces:
  - `percentile(values: number[], pct: number): number` (nearest rank; Infinity sorts last)
  - `metricValue(tr: Trace, m: MetricSpec): number` where `type MetricSpec = { metric: 'timeTo'|'countAt'|'balanceAt'|'maxIdleGap'; target?: string; res?: string; at?: number; horizon?: number; clock: 'play'|'wall' }`
  - `interface AssertionResult { id: string; ok: boolean; actual: number; detail: string }`
  - `evaluateAssertions(doc: DesignDoc, traces: Record<string, Trace[]>): AssertionResult[]` — skips assertions whose archetype (or `vs`) has no traces.
  - `fmtSeconds(s: number): string`
  - `requiredProbes(doc: DesignDoc): number[]` and `requiredHorizon(doc: DesignDoc, base: number): number`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/design.assert.test.ts
import { describe, it, expect } from 'vitest';
import { percentile, metricValue, fmtSeconds } from '../src/design/metrics.js';
import { evaluateAssertions, requiredProbes, requiredHorizon } from '../src/design/assert.js';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';
import type { Trace } from '../src/design/sim.js';

const tr = (events: [number, number, string, number][], samples: [number, number, number][] = [], endPlay = 1000): Trace => ({
  archetype: 'a',
  seed: 1,
  horizonSec: 1000,
  events: events.map(([t, play, ref, n]) => ({ t, play, ref, n })),
  samples: samples.map(([t, play, cash]) => ({ t, play, bal: { cash } })),
  endPlay,
});

describe('percentile', () => {
  it('nearest rank', () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([5, 1, 3, 2, 4], 10)).toBe(1);
    expect(percentile([5, 1, 3, 2, 4], 90)).toBe(5);
    expect(percentile([1, Infinity], 90)).toBe(Infinity);
  });
});

describe('metricValue', () => {
  const t = tr([[10, 10, 'generator:g', 1], [30, 20, 'generator:g', 2], [50, 40, 'rebirth', 1], [70, 60, 'gate:z', 1]], [[100, 80, 42]], 90);
  it('timeTo by play (default) and wall', () => {
    expect(metricValue(t, { metric: 'timeTo', target: 'generator:g:2', clock: 'play' })).toBe(20);
    expect(metricValue(t, { metric: 'timeTo', target: 'generator:g:2', clock: 'wall' })).toBe(30);
    expect(metricValue(t, { metric: 'timeTo', target: 'rebirth:1', clock: 'play' })).toBe(40);
    expect(metricValue(t, { metric: 'timeTo', target: 'rebirth:2', clock: 'play' })).toBe(Infinity);
  });
  it('countAt', () => expect(metricValue(t, { metric: 'countAt', target: 'generator:g', at: 25, clock: 'play' })).toBe(2));
  it('balanceAt reads the probe sample', () => expect(metricValue(t, { metric: 'balanceAt', res: 'cash', at: 100, clock: 'wall' })).toBe(42));
  it('maxIdleGap over play time incl. start and end', () =>
    expect(metricValue(t, { metric: 'maxIdleGap', clock: 'play' })).toBe(30)); // 90-60
  it('maxIdleGap with horizon uses the probe at that wall time', () =>
    expect(metricValue(t, { metric: 'maxIdleGap', horizon: 100, clock: 'play' })).toBe(20)); // gaps 10,10,20,20,20(80-60)
});

describe('fmtSeconds', () => {
  it('formats', () => {
    expect(fmtSeconds(38)).toBe('38s');
    expect(fmtSeconds(725)).toBe('12m05s');
    expect(fmtSeconds(3720)).toBe('1h02m');
    expect(fmtSeconds(Infinity)).toBe('never (within horizon)');
  });
});

function doc(assertions: unknown[]): DesignDoc {
  const r = validateDesign({
    version: 1,
    meta: { title: 'T', format: 'other' },
    economy: { resources: [{ id: 'cash' }], actions: [{ id: 'c', yields: { cash: 1 }, perSec: 1 }], generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 1 } }] },
    archetypes: [
      { id: 'a', session: { lengthSec: 900, perDay: 1 }, policy: 'roi' },
      { id: 'b', session: { lengthSec: 900, perDay: 1 }, policy: 'roi' },
    ],
    assertions,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}

describe('evaluateAssertions', () => {
  const a1 = tr([[10, 10, 'generator:g', 1]]);
  const a2 = tr([[30, 30, 'generator:g', 1]]);
  const b1 = tr([[5, 5, 'generator:g', 1]]);
  it('<=, >=, between with pct', () => {
    const d = doc([
      { id: 'le', archetype: 'a', metric: 'timeTo', target: 'generator:g', op: '<=', value: 20, pct: 10 },
      { id: 'ge', archetype: 'a', metric: 'timeTo', target: 'generator:g', op: '>=', value: 20, pct: 90 },
      { id: 'bt', archetype: 'a', metric: 'timeTo', target: 'generator:g', op: 'between', value: [25, 35], pct: 50 },
    ]);
    const r = evaluateAssertions(d, { a: [a1, a2] });
    expect(r.map((x) => [x.id, x.ok])).toEqual([['le', true], ['ge', true], ['bt', false]]);
    expect(r[2].detail).toMatch(/p50=10s/);
  });
  it('ratio of two archetypes', () => {
    const d = doc([{ id: 'r', archetype: 'a', vs: 'b', metric: 'ratio', of: 'timeTo', target: 'generator:g', op: '<=', value: 3 }]);
    const r = evaluateAssertions(d, { a: [a2], b: [b1] });
    expect(r[0].actual).toBe(6);
    expect(r[0].ok).toBe(false);
  });
  it('never-reached targets fail with a readable detail', () => {
    const d = doc([{ id: 'n', archetype: 'a', metric: 'timeTo', target: 'generator:g:5', op: '<=', value: 60 }]);
    const r = evaluateAssertions(d, { a: [a1] });
    expect(r[0].ok).toBe(false);
    expect(r[0].detail).toMatch(/never \(within horizon\)/);
  });
  it('skips assertions whose archetypes were not simulated', () => {
    const d = doc([{ id: 'r', archetype: 'a', vs: 'b', metric: 'ratio', of: 'timeTo', target: 'generator:g', op: '<=', value: 3 }]);
    expect(evaluateAssertions(d, { a: [a1] })).toEqual([]);
  });
  it('requiredProbes / requiredHorizon', () => {
    const d = doc([
      { id: 'b', archetype: 'a', metric: 'balanceAt', res: 'cash', at: 500, clock: 'wall', op: '>=', value: 1 },
      { id: 'g', archetype: 'a', metric: 'maxIdleGap', horizon: 200000, op: '<=', value: 300 },
    ]);
    expect(requiredProbes(d).sort((x, y) => x - y)).toEqual([500, 200000]);
    expect(requiredHorizon(d, 86400)).toBe(200000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/design.assert.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write `src/design/metrics.ts`**

```ts
// src/design/metrics.ts
import { parseRef } from './schema.js';
import type { SimEvent, Trace } from './sim.js';

export type MetricSpec = {
  metric: 'timeTo' | 'countAt' | 'balanceAt' | 'maxIdleGap';
  target?: string;
  res?: string;
  at?: number;
  horizon?: number;
  clock: 'play' | 'wall';
};

export function percentile(values: number[], pct: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
}

function matcher(target: string, withCount: boolean): (e: SimEvent) => boolean {
  const { kind, id, n } = parseRef(target);
  if (kind === 'rebirth') {
    const need = withCount ? Number(id) : 1;
    return (e) => e.ref === 'rebirth' && e.n >= need;
  }
  const ref = `${kind}:${id}`;
  const need = withCount ? n ?? 1 : 1;
  return (e) => e.ref === ref && e.n >= need;
}

const at = (e: SimEvent, clock: 'play' | 'wall') => (clock === 'wall' ? e.t : e.play);

export function metricValue(tr: Trace, m: MetricSpec): number {
  switch (m.metric) {
    case 'timeTo': {
      const e = tr.events.find(matcher(m.target!, true));
      return e ? at(e, m.clock) : Infinity;
    }
    case 'countAt': {
      const match = matcher(m.target!, false);
      return tr.events.filter((e) => match(e) && at(e, m.clock) <= m.at!).length;
    }
    case 'balanceAt': {
      const s = tr.samples.find((x) => x.t === m.at);
      return s ? s.bal[m.res!] ?? NaN : NaN;
    }
    case 'maxIdleGap': {
      let end = tr.endPlay;
      let events = tr.events;
      if (m.horizon !== undefined) {
        const s = tr.samples.find((x) => x.t === m.horizon);
        if (s) end = s.play;
        events = events.filter((e) => e.t <= m.horizon!);
      }
      let prev = 0;
      let gap = 0;
      for (const e of events) {
        gap = Math.max(gap, e.play - prev);
        prev = e.play;
      }
      return Math.max(gap, end - prev);
    }
  }
}

export function fmtSeconds(s: number): string {
  if (!Number.isFinite(s)) return 'never (within horizon)';
  const r = Math.round(s);
  if (r < 60) return `${r}s`;
  if (r < 3600) return `${Math.floor(r / 60)}m${String(r % 60).padStart(2, '0')}s`;
  return `${Math.floor(r / 3600)}h${String(Math.floor((r % 3600) / 60)).padStart(2, '0')}m`;
}
```

- [ ] **Step 4: Write `src/design/assert.ts`**

```ts
// src/design/assert.ts
import type { Assertion, DesignDoc } from './schema.js';
import type { Trace } from './sim.js';
import { fmtSeconds, metricValue, percentile, type MetricSpec } from './metrics.js';

export interface AssertionResult {
  id: string;
  ok: boolean;
  actual: number;
  detail: string;
}

const TIME_METRICS = new Set(['timeTo', 'maxIdleGap']);

function fmtValue(metric: string, v: number): string {
  if (TIME_METRICS.has(metric)) return fmtSeconds(v);
  if (!Number.isFinite(v)) return String(v);
  return Number(v.toPrecision(4)).toString();
}

function check(op: Assertion['op'], value: Assertion['value'], actual: number): boolean {
  if (Number.isNaN(actual)) return false;
  if (op === 'between') {
    const [lo, hi] = value as [number, number];
    return actual >= lo && actual <= hi;
  }
  return op === '<=' ? actual <= (value as number) : actual >= (value as number);
}

function spec(a: Assertion): MetricSpec {
  return { metric: a.metric === 'ratio' ? a.of! : a.metric, target: a.target, res: a.res, at: a.at, horizon: a.horizon, clock: a.clock };
}

export function evaluateAssertions(doc: DesignDoc, traces: Record<string, Trace[]>): AssertionResult[] {
  const out: AssertionResult[] = [];
  for (const a of doc.assertions) {
    const mine = traces[a.archetype];
    if (!mine?.length) continue;
    if (a.metric === 'ratio' && !traces[a.vs!]?.length) continue;
    const m = spec(a);
    const p = percentile(mine.map((t) => metricValue(t, m)), a.pct);
    let actual = p;
    let what = `${a.archetype} ${m.metric}${a.target ? ` ${a.target}` : ''}${a.res ? ` ${a.res}` : ''}${a.at !== undefined ? `@${a.at}` : ''}`;
    if (a.metric === 'ratio') {
      const q = percentile(traces[a.vs!].map((t) => metricValue(t, m)), a.pct);
      actual = q === 0 ? Infinity : p / q;
      what = `${a.archetype}/${a.vs} ${what.slice(a.archetype.length + 1)}`;
    }
    const shown = a.metric === 'ratio' ? fmtValue('ratio', actual) : fmtValue(m.metric, actual);
    const bound =
      a.op === 'between'
        ? `between ${(a.value as number[]).map((v) => (a.metric === 'ratio' ? fmtValue('ratio', v) : fmtValue(m.metric, v))).join('–')}`
        : `${a.op} ${a.metric === 'ratio' ? fmtValue('ratio', a.value as number) : fmtValue(m.metric, a.value as number)}`;
    out.push({ id: a.id, ok: check(a.op, a.value, actual), actual, detail: `${what} p${a.pct}=${shown} (${bound})` });
  }
  return out;
}

export function requiredProbes(doc: DesignDoc): number[] {
  const p = new Set<number>();
  for (const a of doc.assertions) {
    if ((a.metric === 'balanceAt' || a.of === 'balanceAt') && a.at !== undefined) p.add(a.at);
    if (a.horizon !== undefined) p.add(a.horizon);
  }
  return [...p];
}

export function requiredHorizon(doc: DesignDoc, base: number): number {
  return Math.max(base, ...requiredProbes(doc), ...doc.assertions.map((a) => (a.clock === 'wall' && a.at !== undefined ? a.at : 0)));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/design.assert.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/design/metrics.ts src/design/assert.ts tests/design.assert.test.ts
git commit -m "feat(design): sim metrics + declarative assertions"
```

---

### Task 4: Monte Carlo runner + report

**Files:**
- Create: `src/design/report.ts`
- Test: `tests/design.report.test.ts`

**Interfaces:**
- Consumes: `simulate`, `Trace`, `SimSample` (Task 2); `evaluateAssertions`, `requiredProbes`, `requiredHorizon`, `AssertionResult`, `percentile`, `fmtSeconds` (Task 3).
- Produces:
  - `interface SimReport { ranAt: string; runs: number; seed: number; horizonSec: number; archetypes: string[]; assertions: AssertionResult[]; milestones: Record<string, { ref: string; p10: number; p50: number; p90: number }[]>; curves: Record<string, SimSample[]> }`
  - `interface RunOptions { archetypes?: string[]; horizonSec?: number; runs?: number; seed?: number }`
  - `runSimulation(doc: DesignDoc, o?: RunOptions): SimReport` (throws `SimError` for unknown archetype filters)
  - `formatReport(r: SimReport): string`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/design.report.test.ts
import { describe, it, expect } from 'vitest';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';
import { runSimulation, formatReport } from '../src/design/report.js';

function doc(extra: Record<string, unknown> = {}): DesignDoc {
  const r = validateDesign({
    version: 1,
    meta: { title: 'T', format: 'incremental' },
    economy: {
      resources: [{ id: 'cash' }],
      actions: [{ id: 'c', yields: { cash: 1 }, perSec: 1 }],
      generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 10, growth: 1.2 } }],
      chance: [{ id: 'egg', cost: { res: 'cash', base: 50, growth: 1.1 }, outcomes: [{ id: 'c', weight: 9, grants: { 'income:cash': 0.5 } }, { id: 'r', weight: 1, grants: { 'income:cash': 5 } }] }],
      rebirth: { needs: { res: 'cash', base: 5000, growth: 2 }, mult: { target: '*', per: 1.5 }, resets: ['cash', 'generators', 'chance'] },
      offline: { fraction: 0.5, capSec: 28800 },
    },
    archetypes: [
      { id: 'active', session: { lengthSec: 1800, perDay: 2 }, policy: 'roi' },
      { id: 'casual', session: { lengthSec: 600, perDay: 1 }, policy: 'cheapest' },
    ],
    assertions: [
      { id: 'first-g', archetype: 'active', metric: 'timeTo', target: 'generator:g', op: '<=', value: 15 },
      { id: 'payer-gap', archetype: 'active', vs: 'casual', metric: 'ratio', of: 'timeTo', target: 'generator:g:5', op: '<=', value: 10 },
    ],
    ...extra,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}

describe('runSimulation', () => {
  it('runs every archetype and evaluates assertions', () => {
    const r = runSimulation(doc(), { runs: 10 });
    expect(r.archetypes).toEqual(['active', 'casual']);
    expect(r.assertions.map((a) => a.id)).toEqual(['first-g', 'payer-gap']);
    expect(r.assertions[0].ok).toBe(true);
    expect(r.milestones.active[0]).toMatchObject({ ref: 'generator:g' });
    expect(r.curves.active.length).toBeGreaterThanOrEqual(48);
  });
  it('archetype filter skips assertions needing others', () => {
    const r = runSimulation(doc(), { runs: 5, archetypes: ['active'] });
    expect(r.assertions.map((a) => a.id)).toEqual(['first-g']);
  });
  it('rejects unknown archetype filters', () => {
    expect(() => runSimulation(doc(), { archetypes: ['nope'] })).toThrow(/unknown archetype/);
  });
  it('is deterministic for a seed', () => {
    const a = runSimulation(doc(), { runs: 5, seed: 9 });
    const b = runSimulation(doc(), { runs: 5, seed: 9 });
    expect({ ...a, ranAt: '' }).toEqual({ ...b, ranAt: '' });
  });
  it('50 runs x 7 days stays fast', () => {
    const t0 = Date.now();
    runSimulation(doc(), { runs: 50, horizonSec: 7 * 86400 });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('formatReport', () => {
  it('prints a pass/fail table and milestones', () => {
    const text = formatReport(runSimulation(doc(), { runs: 5 }));
    expect(text).toMatch(/^design sim: 5 runs × 1d, seed 1 — \d\/2 assertions pass/);
    expect(text).toMatch(/✓ first-g/);
    expect(text).toMatch(/active: generator:g/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/design.report.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/design/report.ts
import type { DesignDoc } from './schema.js';
import { simulate, SimError, type SimSample, type Trace } from './sim.js';
import { evaluateAssertions, requiredHorizon, requiredProbes, type AssertionResult } from './assert.js';
import { fmtSeconds, percentile } from './metrics.js';

export interface SimReport {
  ranAt: string;
  runs: number;
  seed: number;
  horizonSec: number;
  archetypes: string[];
  assertions: AssertionResult[];
  milestones: Record<string, { ref: string; p10: number; p50: number; p90: number }[]>;
  curves: Record<string, SimSample[]>;
}
export interface RunOptions {
  archetypes?: string[];
  horizonSec?: number;
  runs?: number;
  seed?: number;
}

const CURVE_POINTS = 48;
const MAX_MILESTONES = 30;

export function runSimulation(doc: DesignDoc, o: RunOptions = {}): SimReport {
  const runs = o.runs ?? 50;
  const seed = o.seed ?? 1;
  const H = requiredHorizon(doc, o.horizonSec ?? 86400);
  const ids = o.archetypes ?? doc.archetypes.map((a) => a.id);
  for (const id of ids) if (!doc.archetypes.some((a) => a.id === id)) throw new SimError(`unknown archetype "${id}"`);
  const grid = Array.from({ length: CURVE_POINTS + 1 }, (_, i) => Math.round((i * H) / CURVE_POINTS));
  const probes = [...new Set([...grid, ...requiredProbes(doc)])];
  // Without chance tables every run is identical — simulate once.
  const deterministic = doc.economy.chance.length === 0;
  const traces: Record<string, Trace[]> = {};
  for (const id of ids) {
    const list: Trace[] = [];
    for (let i = 0; i < runs; i++) {
      list.push(deterministic && i > 0 ? list[0] : simulate(doc, { archetype: id, horizonSec: H, seed: seed + i, probes }));
    }
    traces[id] = list;
  }
  const milestones: SimReport['milestones'] = {};
  const curves: SimReport['curves'] = {};
  for (const id of ids) {
    const list = traces[id];
    const refs: string[] = [];
    for (const e of list[0].events) if (!refs.includes(e.ref) && refs.length < MAX_MILESTONES) refs.push(e.ref);
    milestones[id] = refs.map((ref) => {
      const times = list.map((t) => t.events.find((e) => e.ref === ref)?.play ?? Infinity);
      return { ref, p10: percentile(times, 10), p50: percentile(times, 50), p90: percentile(times, 90) };
    });
    curves[id] = list[0].samples.filter((s) => grid.includes(s.t));
  }
  return { ranAt: new Date().toISOString(), runs, seed, horizonSec: H, archetypes: ids, assertions: evaluateAssertions(doc, traces), milestones, curves };
}

function fmtHorizon(s: number): string {
  return s % 86400 === 0 ? `${s / 86400}d` : fmtSeconds(s);
}

export function formatReport(r: SimReport): string {
  const pass = r.assertions.filter((a) => a.ok).length;
  const lines = [`design sim: ${r.runs} runs × ${fmtHorizon(r.horizonSec)}, seed ${r.seed} — ${pass}/${r.assertions.length} assertions pass`];
  for (const a of r.assertions) lines.push(`  ${a.ok ? '✓' : '✗'} ${a.id}  ${a.detail}`);
  lines.push('milestones (p50 play time):');
  for (const id of r.archetypes) {
    const ms = r.milestones[id].slice(0, 12).map((m) => `${m.ref} ${fmtSeconds(m.p50)}`);
    lines.push(`  ${id}: ${ms.join(' · ') || '(nothing happened)'}`);
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/design.report.test.ts`
Expected: PASS. If the perf test fails, profile `choose()` — `payback` clones state per candidate; cache `rates(doc, s, true)` per buy loop iteration (already passed in as `r`) and make sure the online `need` loop is not recomputing rates per item.

- [ ] **Step 5: Commit**

```bash
git add src/design/report.ts tests/design.report.test.ts
git commit -m "feat(design): Monte Carlo runner + text report"
```

---

### Task 5: Luau codegen

**Files:**
- Create: `src/design/codegen.ts`
- Test: `tests/design.codegen.test.ts`

**Interfaces:**
- Consumes: `DesignDoc` (Task 1).
- Produces: `TUNABLES_PATH = 'src/ReplicatedStorage/Design/Tunables.luau'`; `renderTunables(doc: DesignDoc): string`; `toLuau(v: unknown, indent: string): string`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/design.codegen.test.ts
import { describe, it, expect } from 'vitest';
import { renderTunables, toLuau, TUNABLES_PATH } from '../src/design/codegen.js';
import { validateDesign, type DesignDoc } from '../src/design/schema.js';

function doc(): DesignDoc {
  const r = validateDesign({
    version: 1,
    meta: { title: 'Snow "Beast"', format: 'steal-tycoon' },
    monetization: [{ id: 'cash2x', kind: 'pass', effect: 'upgrade:cash2x' }],
    economy: {
      resources: [{ id: 'cash' }],
      actions: [{ id: 'click', yields: { cash: 1 }, perSec: 2 }],
      generators: [{ id: 'dropper', produces: { cash: 1.5 }, cost: { res: 'cash', base: 10000, growth: 1.15 } }],
      upgrades: [{ id: 'cash2x', cost: { res: 'cash', base: 500 }, effect: { target: 'cash', mult: 2 } }],
    },
    tunables: { shieldSec: 60, 'guardian-speed': 18, debug: false },
    archetypes: [{ id: 'a', session: { lengthSec: 900, perDay: 2 }, policy: 'roi' }],
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.doc;
}

describe('toLuau', () => {
  it('scalars', () => {
    expect(toLuau(10000, '')).toBe('10000');
    expect(toLuau(1.15, '')).toBe('1.15');
    expect(toLuau(Infinity, '')).toBe('math.huge');
    expect(toLuau('a"b\n', '')).toBe('"a\\"b\\n"');
    expect(toLuau(true, '')).toBe('true');
  });
  it('arrays and sorted, frozen maps with bracketed non-identifier keys', () => {
    expect(toLuau(['x', 'y'], '')).toBe('table.freeze({ "x", "y" })');
    expect(toLuau({ b: 1, 'a-b': 2 }, '')).toBe('table.freeze({\n\t["a-b"] = 2,\n\tb = 1,\n})');
  });
});

describe('renderTunables', () => {
  it('has the generated header, id-keyed economy and is deterministic', () => {
    const out = renderTunables(doc());
    expect(TUNABLES_PATH).toBe('src/ReplicatedStorage/Design/Tunables.luau');
    expect(out.split('\n')[0]).toBe('-- GENERATED from .blox/design.json by `blox design codegen`. Do not edit.');
    expect(out).toMatch(/dropper = table\.freeze\(\{/);
    expect(out).toMatch(/base = 10000,/);
    expect(out).toMatch(/\["guardian-speed"\] = 18,/);
    expect(out).toMatch(/title = "Snow \\"Beast\\""/);
    expect(out).toMatch(/cash2x = table\.freeze\(\{\n\t\t\teffect = "upgrade:cash2x",\n\t\t\tkind = "pass",/);
    expect(renderTunables(doc())).toBe(out);
    expect(out.split('{').length).toBe(out.split('}').length);
    expect(out.trimEnd().endsWith('})')).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/design.codegen.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```ts
// src/design/codegen.ts
import type { DesignDoc } from './schema.js';

// design.json → a deep-frozen Luau module the game requires, so simulated and
// shipped numbers are the same numbers. Arrays of {id,...} become id-keyed maps
// (Tunables.economy.generators.dropper.cost.base).

export const TUNABLES_PATH = 'src/ReplicatedStorage/Design/Tunables.luau';
const HEADER = '-- GENERATED from .blox/design.json by `blox design codegen`. Do not edit.';
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LUAU_KEYWORDS = new Set(['and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while', 'continue']);

function str(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

function byId(v: unknown): unknown {
  if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && typeof (x as { id?: unknown }).id === 'string')) {
    return Object.fromEntries(v.map((x) => {
      const { id, ...rest } = x as { id: string };
      return [id, byId(rest)];
    }));
  }
  if (Array.isArray(v)) return v.map(byId);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, byId(x)]));
  return v;
}

export function toLuau(v: unknown, indent: string): string {
  if (typeof v === 'number') {
    if (v === Infinity) return 'math.huge';
    if (v === -Infinity) return '-math.huge';
    return Number.isInteger(v) && Math.abs(v) < 1e21 ? v.toFixed(0) : String(v);
  }
  if (typeof v === 'string') return str(v);
  if (typeof v === 'boolean') return String(v);
  if (v === null || v === undefined) return 'nil';
  if (Array.isArray(v)) {
    if (!v.length) return 'table.freeze({})';
    return `table.freeze({ ${v.map((x) => toLuau(x, indent)).join(', ')} })`;
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (!entries.length) return 'table.freeze({})';
  const inner = indent + '\t';
  const body = entries.map(([k, x]) => `${inner}${IDENT.test(k) && !LUAU_KEYWORDS.has(k) ? k : `[${str(k)}]`} = ${toLuau(x, inner)},`).join('\n');
  return `table.freeze({\n${body}\n${indent}})`;
}

export function renderTunables(doc: DesignDoc): string {
  const data = {
    meta: doc.meta,
    economy: byId(doc.economy),
    tunables: doc.tunables,
    monetization: byId(doc.monetization),
  };
  return `${HEADER}\nreturn ${toLuau(data, '')}\n`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/design.codegen.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/design/codegen.ts tests/design.codegen.test.ts
git commit -m "feat(design): Tunables.luau codegen"
```

---

### Task 6: `design` tool, criteria binding, CLI, agent guide

**Files:**
- Modify: `src/state/store.ts` (add `withDesignResults` after `evaluateCriteria`)
- Modify: `src/tools/registry.ts` (status handler ~line 115-125, run_tests ~line 165, task ~line 349, new `design` tool before `scaffold`)
- Modify: `src/dashboard/server.ts:38`
- Modify: `src/cliTools.ts` (`cliArgs` switch + `TOOL_COMMANDS` + help text line ~152)
- Modify: `src/agentGuide.ts` (new section after "## Loop")
- Test: `tests/design.tool.test.ts`

**Interfaces:**
- Consumes: `validateDesign`, `formatErrors` (T1); `runSimulation`, `formatReport`, `SimReport` (T4); `renderTunables`, `TUNABLES_PATH` (T5); `SimError` (T2).
- Produces:
  - `withDesignResults(projectPath: string, lt: TestSummaryLike | null): TestSummaryLike | null`
  - tool `design` with shape `{ action: 'get'|'set'|'validate'|'simulate'|'codegen'; doc?: unknown; archetypes?: string[]; horizon?: number; runs?: number; seed?: number }`
  - CLI: `blox design [get|validate|codegen]`, `blox design set '<json>'`, `blox design simulate [--runs N] [--horizon S] [--seed N] [--archetypes a,b]`

- [ ] **Step 1: Write the failing tests**

```ts
// tests/design.tool.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { readJson, withDesignResults, writeJson } from '../src/state/store.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';

function ctx(): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-design-'));
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => { throw new Error('studio must not be touched'); }, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
const call = (name: string, args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool(name)!, args, c);
const DOC = {
  version: 1,
  meta: { title: 'T', format: 'incremental' },
  economy: { resources: [{ id: 'cash' }], actions: [{ id: 'c', yields: { cash: 1 }, perSec: 1 }], generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 10, growth: 1.2 } }] },
  archetypes: [{ id: 'active', session: { lengthSec: 900, perDay: 2 }, policy: 'roi' }],
  assertions: [
    { id: 'first-g', archetype: 'active', metric: 'timeTo', target: 'generator:g', op: '<=', value: 15 },
    { id: 'tenth-g', archetype: 'active', metric: 'timeTo', target: 'generator:g:10', op: '<=', value: 5 },
  ],
};

describe('design tool', () => {
  it('set → validate → simulate → codegen, without Studio', async () => {
    const c = ctx();
    expect((await call('design', { action: 'set', doc: DOC }, c)).isError).toBeFalsy();
    expect((await call('design', { action: 'validate' }, c)).text).toMatch(/valid/);
    const sim = await call('design', { action: 'simulate', runs: 3 }, c);
    expect(sim.isError).toBe(true); // tenth-g fails
    expect(sim.text).toMatch(/✓ first-g/);
    expect(sim.text).toMatch(/✗ tenth-g/);
    expect(readJson<{ assertions: unknown[] }>(c.projectPath, 'sim-report.json')!.assertions).toHaveLength(2);
    const cg = await call('design', { action: 'codegen' }, c);
    expect(cg.text).toMatch(/Tunables\.luau/);
    expect(readFileSync(join(c.projectPath, 'src/ReplicatedStorage/Design/Tunables.luau'), 'utf8')).toMatch(/^-- GENERATED/);
  });
  it('invalid set writes nothing and lists errors', async () => {
    const c = ctx();
    const r = await call('design', { action: 'set', doc: { ...DOC, version: 2 } }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/version/);
    expect(existsSync(join(c.projectPath, '.blox/design.json'))).toBe(false);
  });
  it('missing design gives a hint', async () => {
    const r = await call('design', { action: 'simulate' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/design \{action:"set"/);
  });
  it('unknown archetype filter is a readable error', async () => {
    const c = ctx();
    await call('design', { action: 'set', doc: DOC }, c);
    const r = await call('design', { action: 'simulate', archetypes: ['nope'] }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown archetype "nope"/);
  });
  it('task criteria bound to design:<id> follow the last sim', async () => {
    const c = ctx();
    await call('design', { action: 'set', doc: DOC }, c);
    await call('task', { action: 'set', goal: 'g', criteria: [{ id: 'pace', text: 'first g fast', tests: ['design:first-g'] }, { id: 'late', text: 'x', tests: ['design:tenth-g'] }] }, c);
    await call('design', { action: 'simulate', runs: 2 }, c);
    const t = await call('task', { action: 'get' }, c);
    expect(t.text).toMatch(/pace/);
    const saved = readJson<{ criteria: { id: string; status: string }[] }>(c.projectPath, 'task.json')!;
    expect(saved.criteria.map((x) => [x.id, x.status])).toEqual([['pace', 'pass'], ['late', 'fail']]);
  });
});

describe('withDesignResults', () => {
  it('appends sim assertions as synthetic tests', () => {
    const c = ctx();
    writeJson(c.projectPath, 'sim-report.json', { ranAt: 'x', assertions: [{ id: 'a', ok: true }, { id: 'b', ok: false }] });
    const r = withDesignResults(c.projectPath, { ranAt: 'y', tests: [{ file: 'f', name: 'n', status: 'pass' }] })!;
    expect(r.tests).toEqual([
      { file: 'f', name: 'n', status: 'pass' },
      { file: 'design', name: 'design:a', status: 'pass' },
      { file: 'design', name: 'design:b', status: 'fail' },
    ]);
    expect(withDesignResults(ctx().projectPath, null)).toBeNull();
  });
});

describe('cli mapping', () => {
  it('maps design subcommands', () => {
    expect(cliArgs('design', parseFlags([]))).toEqual({ tool: 'design', args: { action: 'get' } });
    expect(cliArgs('design', parseFlags(['set', '{"version":1}']))).toEqual({ tool: 'design', args: { action: 'set', doc: { version: 1 } } });
    expect(cliArgs('design', parseFlags(['simulate', '--runs', '5', '--horizon', '604800', '--archetypes', 'a,b']))).toEqual({
      tool: 'design',
      args: { action: 'simulate', runs: 5, horizon: 604800, archetypes: ['a', 'b'] },
    });
  });
  it('malformed set json throws (cli reports "bad arguments")', () => {
    expect(() => cliArgs('design', parseFlags(['set', '{nope']))).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/design.tool.test.ts`
Expected: FAIL — `withDesignResults` not exported / tool `design` not found.

- [ ] **Step 3: Add `withDesignResults` to `src/state/store.ts`** (after `evaluateCriteria`)

```ts
// Design-sim assertions (.blox/sim-report.json) count as synthetic test results
// named design:<id>, so a criterion binds to one with tests: ["design:<id>"].
export function withDesignResults(projectPath: string, lt: TestSummaryLike | null): TestSummaryLike | null {
  const sim = readJson<{ ranAt: string; assertions: { id: string; ok: boolean }[] }>(projectPath, 'sim-report.json');
  if (!sim) return lt;
  const tests = sim.assertions.map((a) => ({ file: 'design', name: `design:${a.id}`, status: a.ok ? 'pass' : 'fail' }));
  return { ranAt: lt?.ranAt ?? sim.ranAt, tests: [...(lt?.tests ?? []), ...tests] };
}
```

- [ ] **Step 4: Use it at the four criteria call sites**

`src/tools/registry.ts` imports: add `withDesignResults` and `type TestSummaryLike` to the `../state/store.js` import, plus:

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateDesign, formatErrors } from '../design/schema.js';
import { runSimulation, formatReport } from '../design/report.js';
import { renderTunables, TUNABLES_PATH } from '../design/codegen.js';
```

(merge `mkdirSync, writeFileSync` into the existing `node:fs` import and `dirname` into the existing `node:path` import).

- status handler: `lines.push('', formatTask(loadTask(ctx.projectPath), lt));` → `lines.push('', formatTask(loadTask(ctx.projectPath), withDesignResults(ctx.projectPath, lt)));`
- run_tests handler: `formatTask(task, r, { compact: true })` → `formatTask(task, withDesignResults(ctx.projectPath, r), { compact: true })`
- task handler: right after the `const lt = readJson<...>(ctx.projectPath, 'last-tests.json');` line, change to `const lt = withDesignResults(ctx.projectPath, readJson<{ ranAt: string; tests: { file: string; name: string; status: string }[] }>(ctx.projectPath, 'last-tests.json'));`
- `src/dashboard/server.ts:38`: `evaluateCriteria(task, lastTests)` → `evaluateCriteria(task, withDesignResults(projectPath, lastTests))` and add `withDesignResults` to its store import.

- [ ] **Step 5: Add the `design` tool** to `TOOLS` (insert before the `scaffold` entry)

```ts
  {
    name: 'design',
    description:
      'Game design doc (.blox/design.json) + offline economy simulator. get | set {doc} (validated; invalid docs are not written) | validate | simulate {archetypes?, horizon? s, runs?, seed?} (player archetypes over time → pass/fail assertions + milestones; failing assertions = isError) | codegen (writes src/ReplicatedStorage/Design/Tunables.luau; game code reads numbers from it). Criteria bind to assertions via tests:["design:<id>"]. No Studio needed.',
    shape: {
      action: z.enum(['get', 'set', 'validate', 'simulate', 'codegen']),
      doc: z.unknown().optional(),
      archetypes: z.array(z.string()).optional(),
      horizon: z.number().int().positive().optional(),
      runs: z.number().int().positive().max(1000).optional(),
      seed: z.number().int().optional(),
    },
    async handler(a, ctx) {
      if (a.action === 'set') {
        const v = validateDesign(a.doc);
        if (!v.ok) return { text: `design not saved — ${v.errors.length} error(s):\n${formatErrors(v.errors)}`, isError: true, summary: 'invalid' };
        writeJson(ctx.projectPath, 'design.json', v.doc);
        return { text: `saved .blox/design.json (${v.doc.meta.title}, ${v.doc.assertions.length} assertion(s)). Next: design {action:"simulate"}.`, summary: 'saved' };
      }
      const raw = readJson<unknown>(ctx.projectPath, 'design.json');
      if (raw === null) return { text: 'no .blox/design.json — create one with design {action:"set", doc:{...}}', isError: true, summary: 'no design' };
      if (a.action === 'get') return { text: JSON.stringify(raw, null, 2), summary: 'get' };
      const v = validateDesign(raw);
      if (!v.ok) return { text: `design.json is invalid — ${v.errors.length} error(s):\n${formatErrors(v.errors)}`, isError: true, summary: 'invalid' };
      if (a.action === 'validate') return { text: `design.json is valid (${v.doc.assertions.length} assertion(s))`, summary: 'valid' };
      if (a.action === 'codegen') {
        const file = join(ctx.projectPath, TUNABLES_PATH);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, renderTunables(v.doc));
        return { text: `wrote ${TUNABLES_PATH} — require it for every tuned number; sync/run_tests push it to Studio.`, artifacts: [TUNABLES_PATH], summary: 'codegen' };
      }
      const report = runSimulation(v.doc, {
        archetypes: a.archetypes as string[] | undefined,
        horizonSec: a.horizon as number | undefined,
        runs: a.runs as number | undefined,
        seed: a.seed as number | undefined,
      });
      writeJson(ctx.projectPath, 'sim-report.json', report);
      const task = loadTask(ctx.projectPath);
      if (task) {
        // Same persistence the task tool does, so the dashboard sees fresh statuses.
        const lt = withDesignResults(ctx.projectPath, readJson<TestSummaryLike>(ctx.projectPath, 'last-tests.json'));
        task.criteria = evaluateCriteria(task, lt).map((c, i) => (task.criteria[i].tests?.length ? c : task.criteria[i]));
        saveTask(ctx.projectPath, task);
      }
      const failed = report.assertions.filter((x) => !x.ok).length;
      return { text: formatReport(report), isError: failed > 0, summary: `${report.assertions.length - failed}/${report.assertions.length} assertions` };
    },
  },
```

`SimError` thrown by `runSimulation` is caught by `invokeTool`'s generic catch and returned as `isError` with its message — no extra handling needed.

- [ ] **Step 6: CLI mapping** in `src/cliTools.ts`

Add to the `cliArgs` switch (before `case 'tool':`):

```ts
    case 'design': {
      const action = f.rest[0] ?? 'get';
      if (action === 'set') return { tool: 'design', args: { action, doc: JSON.parse(f.rest.slice(1).join(' ')) } };
      return {
        tool: 'design',
        args: {
          action,
          ...(typeof o.runs === 'string' ? { runs: Number(o.runs) } : {}),
          ...(typeof o.horizon === 'string' ? { horizon: Number(o.horizon) } : {}),
          ...(typeof o.seed === 'string' ? { seed: Number(o.seed) } : {}),
          ...(typeof o.archetypes === 'string' ? { archetypes: o.archetypes.split(',') } : {}),
        },
      };
    }
```

Add `'design'` to `TOOL_COMMANDS`. In the help text block near line 152 add a line:
`           blox design [get|validate|simulate|codegen]  blox design set '<json>'`

- [ ] **Step 7: Agent guide** — in `src/agentGuide.ts`, after the `## Loop` list, add:

```
## Design first (economy games)
design {action:"set"} a .blox/design.json (economy, archetypes, assertions such as
"first egg <= 60s"), then design {action:"simulate"}; tune numbers until assertions
pass, then design {action:"codegen"} and read every tuned number from
ReplicatedStorage.Design.Tunables — never hard-code them. Bind pacing criteria with
tests:["design:<assertionId>"].
```

Keep the wording inside the template literal; escape any backticks.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/design.tool.test.ts tests/tools.registry.test.ts`
Expected: PASS. If an existing test counts tools or snapshots the agent guide, update it to include `design`.

- [ ] **Step 9: Commit**

```bash
git add src/state/store.ts src/tools/registry.ts src/dashboard/server.ts src/cliTools.ts src/agentGuide.ts tests/design.tool.test.ts
git commit -m "feat(design): design tool (MCP+CLI), sim-bound task criteria, agent guide"
```

---

### Task 7: Example designs + full verification

**Files:**
- Create: `docs/examples/design/incremental.json`, `docs/examples/design/steal-tycoon.json`
- Test: `tests/design.examples.test.ts`

**Interfaces:**
- Consumes: `validateDesign` (T1), `runSimulation` (T4), `renderTunables` (T5).

- [ ] **Step 1: Write the failing test**

```ts
// tests/design.examples.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateDesign } from '../src/design/schema.js';
import { runSimulation } from '../src/design/report.js';
import { renderTunables } from '../src/design/codegen.js';

for (const name of ['incremental', 'steal-tycoon']) {
  describe(`example ${name}`, () => {
    const raw = JSON.parse(readFileSync(new URL(`../docs/examples/design/${name}.json`, import.meta.url), 'utf8'));
    it('validates, passes its own assertions, and codegens', () => {
      const v = validateDesign(raw);
      if (!v.ok) throw new Error(JSON.stringify(v.errors, null, 2));
      const r = runSimulation(v.doc, { runs: 20 });
      const failed = r.assertions.filter((a) => !a.ok);
      expect(failed.map((a) => `${a.id}: ${a.detail}`)).toEqual([]);
      expect(r.assertions.length).toBeGreaterThanOrEqual(3);
      expect(renderTunables(v.doc)).toMatch(/^-- GENERATED/);
    });
  });
}
```

- [ ] **Step 2: Write `docs/examples/design/incremental.json`**

```json
{
  "version": 1,
  "meta": { "title": "+1 Speed Escape", "format": "incremental", "verb": "Run", "object": "speed", "serverSize": 12 },
  "loop": ["walk", "+1 speed per step", "reach next wall", "buy pets", "rebirth"],
  "ftue": [
    { "id": "first-step", "text": "Walking already gains speed", "targetSec": 2 },
    { "id": "first-wall", "text": "Break the first wall", "targetSec": 60 }
  ],
  "monetization": [{ "id": "speed2x", "kind": "pass", "effect": "upgrade:speed2x" }],
  "economy": {
    "resources": [{ "id": "wins", "start": 0 }, { "id": "speed", "start": 16, "spendable": false }],
    "actions": [{ "id": "step", "yields": { "speed": 1, "wins": 0.2 }, "perSec": 2 }],
    "gates": [
      { "id": "wall1", "needs": { "res": "speed", "amount": 100 } },
      { "id": "wall2", "needs": { "res": "speed", "amount": 1000 } },
      { "id": "wall3", "needs": { "res": "speed", "amount": 10000 } }
    ],
    "generators": [
      { "id": "pet", "produces": { "speed": 0.5, "wins": 0.1 }, "cost": { "res": "wins", "base": 15, "growth": 1.18 }, "max": 40, "requires": "gate:wall1" }
    ],
    "upgrades": [
      { "id": "shoes", "cost": { "res": "wins", "base": 40, "growth": 1.6 }, "effect": { "target": "speed", "mult": 1.5 }, "max": 5 },
      { "id": "speed2x", "cost": { "res": "wins", "base": 1000000000 }, "effect": { "target": "speed", "mult": 2 }, "max": 1 }
    ],
    "rebirth": { "needs": { "res": "wins", "base": 600, "growth": 2.2 }, "mult": { "target": "*", "per": 1.5 }, "resets": ["wins", "speed", "generators", "upgrades", "gates"] },
    "offline": { "fraction": 0.25, "capSec": 14400 }
  },
  "tunables": { "stepDistance": 4, "wallHealthBase": 100 },
  "archetypes": [
    { "id": "active", "session": { "lengthSec": 1800, "perDay": 2 }, "policy": "roi" },
    { "id": "casual", "session": { "lengthSec": 600, "perDay": 1 }, "policy": "cheapest" },
    { "id": "payer", "session": { "lengthSec": 1800, "perDay": 2 }, "policy": "roi", "owns": ["speed2x"] }
  ],
  "assertions": [
    { "id": "first-wall", "archetype": "active", "metric": "timeTo", "target": "gate:wall1", "op": "<=", "value": 60 },
    { "id": "wall2-pace", "archetype": "active", "metric": "timeTo", "target": "gate:wall2", "op": "between", "value": [300, 1800] },
    { "id": "first-rebirth", "archetype": "active", "metric": "timeTo", "target": "rebirth:1", "op": "between", "value": [1800, 5400] },
    { "id": "no-stall", "archetype": "active", "metric": "maxIdleGap", "op": "<=", "value": 600 },
    { "id": "payer-fair", "archetype": "active", "vs": "payer", "metric": "ratio", "of": "timeTo", "target": "rebirth:1", "op": "<=", "value": 3 }
  ]
}
```

- [ ] **Step 3: Write `docs/examples/design/steal-tycoon.json`**

```json
{
  "version": 1,
  "meta": { "title": "Carve a Snow Beast", "format": "steal-tycoon", "verb": "Carve", "object": "snow beast", "serverSize": 6 },
  "loop": ["train", "raid biome", "escape", "hatch", "passive cash", "upgrade", "steal/defend", "rebirth"],
  "ftue": [
    { "id": "core-verb", "text": "Treadmill next to spawn", "targetSec": 5 },
    { "id": "first-egg", "text": "Hatch the first egg", "targetSec": 60 }
  ],
  "monetization": [
    { "id": "cash2x", "kind": "pass", "effect": "upgrade:cash2x" },
    { "id": "luck", "kind": "product", "effect": "chance:egg2" }
  ],
  "economy": {
    "resources": [{ "id": "cash", "start": 20 }, { "id": "speed", "start": 16, "spendable": false }],
    "actions": [
      { "id": "treadmill", "yields": { "speed": 0.5 }, "perSec": 1 },
      { "id": "carve", "yields": { "cash": 1 }, "perSec": 1 }
    ],
    "gates": [
      { "id": "biome2", "needs": { "res": "speed", "amount": 250 } },
      { "id": "biome3", "needs": { "res": "speed", "amount": 1500 } }
    ],
    "chance": [
      {
        "id": "egg1",
        "cost": { "res": "cash", "base": 25, "growth": 1.25 },
        "max": 30,
        "outcomes": [
          { "id": "common", "weight": 80, "grants": { "income:cash": 0.6 } },
          { "id": "rare", "weight": 18, "grants": { "income:cash": 2 } },
          { "id": "mythic", "weight": 2, "grants": { "income:cash": 12 } }
        ]
      },
      {
        "id": "egg2",
        "cost": { "res": "cash", "base": 800, "growth": 1.22 },
        "max": 30,
        "requires": "gate:biome2",
        "outcomes": [
          { "id": "common", "weight": 80, "grants": { "income:cash": 8 } },
          { "id": "rare", "weight": 18, "grants": { "income:cash": 25 } },
          { "id": "mythic", "weight": 2, "grants": { "income:cash": 150 } }
        ]
      }
    ],
    "upgrades": [
      { "id": "conveyor", "cost": { "res": "cash", "base": 150, "growth": 2 }, "effect": { "target": "cash", "mult": 1.25 }, "max": 6 },
      { "id": "cash2x", "cost": { "res": "cash", "base": 1000000000 }, "effect": { "target": "cash", "mult": 2 }, "max": 1 }
    ],
    "rebirth": { "needs": { "res": "cash", "base": 25000, "growth": 3 }, "mult": { "target": "*", "per": 1.5 }, "resets": ["cash", "speed", "upgrades", "chance", "gates"] },
    "offline": { "fraction": 0.5, "capSec": 28800 },
    "drains": [{ "id": "theft", "res": "cash", "fractionPerHour": 0.05 }]
  },
  "tunables": { "shieldSec": 60, "guardianSpeed": 18, "baseSlots": 10 },
  "archetypes": [
    { "id": "active", "session": { "lengthSec": 1800, "perDay": 2 }, "policy": "roi" },
    { "id": "casual", "session": { "lengthSec": 600, "perDay": 1 }, "policy": "cheapest" },
    { "id": "payer", "session": { "lengthSec": 1800, "perDay": 2 }, "policy": "roi", "owns": ["cash2x"] }
  ],
  "assertions": [
    { "id": "first-egg", "archetype": "active", "metric": "timeTo", "target": "chance:egg1", "op": "<=", "value": 60 },
    { "id": "biome2", "archetype": "active", "metric": "timeTo", "target": "gate:biome2", "op": "between", "value": [300, 900] },
    { "id": "first-rebirth", "archetype": "active", "metric": "timeTo", "target": "rebirth:1", "op": "between", "value": [2700, 3600] },
    { "id": "no-stall", "archetype": "active", "metric": "maxIdleGap", "op": "<=", "value": 600 },
    { "id": "payer-fair", "archetype": "active", "vs": "payer", "metric": "ratio", "of": "timeTo", "target": "rebirth:1", "op": "<=", "value": 3 }
  ]
}
```

- [ ] **Step 4: Run, then tune numbers (never the assertions) until both pass**

Run: `npx vitest run tests/design.examples.test.ts`
Expected first run: likely some assertion failures — the failure list prints each `id: detail` with the actual p50. Tune only `economy` numbers (costs, growth, yields, rebirth base) in the JSON, re-run, repeat. Assertions encode the report's pacing targets (§S.1: first egg ≤ 60 s, biome 2 ≈ 10 min, first rebirth 45–60 min) and must not be loosened. `no-stall` may need a bound per format; if a 600 s idle gap is inherent at end-of-content within one day, lengthen content (raise `max`) rather than the bound.

Expected final: PASS for both examples.

- [ ] **Step 5: Full verification**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all tests pass; tsc prints nothing.

Manual CLI smoke (in a scratch dir, no Studio needed):

```bash
D=$(mktemp -d) && cd "$D" && echo '{}' > blox.config.json
npx --prefix /home/myen/blox tsx /home/myen/blox/src/cli.ts design set "$(cat /home/myen/blox/docs/examples/design/steal-tycoon.json)"
npx --prefix /home/myen/blox tsx /home/myen/blox/src/cli.ts design simulate --runs 20
npx --prefix /home/myen/blox tsx /home/myen/blox/src/cli.ts design codegen && head -5 src/ReplicatedStorage/Design/Tunables.luau
```

Expected: saved; `5/5 assertions pass`; generated header printed. (If `blox.config.json` needs other fields, copy the minimal one from `test-fixtures/game`.)

- [ ] **Step 6: Commit**

```bash
git add docs/examples/design tests/design.examples.test.ts
git commit -m "feat(design): +1 incremental and steal-tycoon example designs"
```
