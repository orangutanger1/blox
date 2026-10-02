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
