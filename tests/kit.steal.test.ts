import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runSimulation } from '../src/design/report.js';
import { luneBin, luneCheck, runLuneSpecs } from './helpers/lune.js';
import { kitDesign, kitProject } from './helpers/kit.js';

function luauFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.luau$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe('steal kit', () => {
  it('ships a design that passes its own assertions', () => {
    const r = runSimulation(kitDesign('steal'), { runs: 10 });
    expect(r.assertions.filter((a) => !a.ok).map((a) => a.detail)).toEqual([]);
  });
  it('baseSlots covers every pet cap (stolen pets never exceed the sim model)', () => {
    const d = kitDesign('steal');
    expect(d.tunables.baseSlots).toBe(d.economy.generators.reduce((a, g) => a + (g.max ?? 0), 0));
  });
  it.skipIf(!luneBin())('edit specs pass offline', () => {
    const d = kitProject('steal');
    const specs = readdirSync(join(d, 'tests')).filter((f) => f.endsWith('.spec.luau'));
    const edit = specs.filter((f) => readFileSync(join(d, 'tests', f), 'utf8').startsWith('-- @context edit')).map((f) => `tests/${f}`);
    expect(edit).toContain('tests/kit_rules.spec.luau');
    const r = runLuneSpecs(d, edit);
    expect(r.fileErrors).toEqual([]);
    expect(r.results.filter((t) => t.status !== 'pass')).toEqual([]);
  });
  it.skipIf(!luneBin())('every kit Luau file compiles', () => {
    expect(luneCheck(luauFiles(kitProject('steal')))).toEqual([]);
  });
});
