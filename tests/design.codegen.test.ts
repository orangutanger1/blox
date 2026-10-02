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
    ftue: [{ id: 'core-verb', text: 'x', targetSec: 5 }, { id: 'first-egg', text: 'y', targetSec: 60 }],
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
    expect(out).toMatch(/ftue = table\.freeze\(\{ "core-verb", "first-egg" \}\),/);
    expect(renderTunables(doc())).toBe(out);
    expect(out.split('{').length).toBe(out.split('}').length);
    expect(out.trimEnd().endsWith('})')).toBe(true);
  });
});
