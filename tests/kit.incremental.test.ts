import { describe, it, expect } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDesign } from '../src/design/schema.js';
import { runSimulation } from '../src/design/report.js';
import { renderTunables, TUNABLES_PATH } from '../src/design/codegen.js';
import { luneBin, luneCheck, runLuneSpecs } from './helpers/lune.js';

const KIT = fileURLToPath(new URL('../kits/incremental/', import.meta.url));

function kitDesign() {
  const v = validateDesign(JSON.parse(readFileSync(join(KIT, 'design.json'), 'utf8')));
  if (!v.ok) throw new Error(JSON.stringify(v.errors));
  return v.doc;
}

// A project made of the kit's files plus Tunables generated from its design.
export function kitProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'blox-kit-'));
  cpSync(join(KIT, 'files'), d, { recursive: true });
  mkdirSync(join(d, 'src/ReplicatedStorage/Design'), { recursive: true });
  writeFileSync(join(d, TUNABLES_PATH), renderTunables(kitDesign()));
  return d;
}

function luauFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && /\.luau$/.test(e.name))
    .map((e) => join(e.parentPath, e.name));
}

describe('incremental kit', () => {
  it('ships a design that passes its own assertions', () => {
    const r = runSimulation(kitDesign(), { runs: 10 });
    expect(r.assertions.filter((a) => !a.ok).map((a) => a.detail)).toEqual([]);
  });
  it.skipIf(!luneBin())('edit specs pass offline', () => {
    const d = kitProject();
    const specs = readdirSync(join(d, 'tests')).filter((f) => f.endsWith('.spec.luau'));
    const edit = specs.filter((f) => readFileSync(join(d, 'tests', f), 'utf8').startsWith('-- @context edit')).map((f) => `tests/${f}`);
    expect(edit.length).toBeGreaterThanOrEqual(2);
    const r = runLuneSpecs(d, edit);
    expect(r.fileErrors).toEqual([]);
    expect(r.results.filter((t) => t.status !== 'pass')).toEqual([]);
    expect(r.results.length).toBeGreaterThan(10);
  });
  it.skipIf(!luneBin())('every kit Luau file compiles', () => {
    expect(luneCheck(luauFiles(kitProject()))).toEqual([]);
  });
});
