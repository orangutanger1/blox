import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson, withSyntheticResults } from '../src/state/store.js';
import { releaseCheck } from '../src/release/check.js';
import { BloxConfigSchema } from '../src/config.js';

const rep = (ok: boolean) => ({ ranAt: '2030-01-01T00:00:00Z', raw: {}, results: [{ id: 'map:pockets', ok }, { id: 'map:triangles', ok: true }] });

describe('map criteria and release gate', () => {
  it('binds map:<id> results as synthetic tests', () => {
    const P = mkdtempSync(join(tmpdir(), 'blox-mapg-'));
    writeJson(P, 'map-report.json', rep(false));
    const t = withSyntheticResults(P, null)!;
    expect(t.tests.find((x) => x.name === 'map:pockets')!.status).toBe('fail');
  });
  it('the map gate is n/a without a map config, required with one', () => {
    const P = mkdtempSync(join(tmpdir(), 'blox-mapg-'));
    expect(releaseCheck(P).gates.find((g) => g.id === 'map')!.status).toBe('n/a');
    writeFileSync(join(P, 'blox.config.json'), JSON.stringify({ map: { root: 'Workspace.Farm' } }));
    expect(releaseCheck(P).gates.find((g) => g.id === 'map')).toMatchObject({ status: 'missing', required: true });
    writeJson(P, 'map-report.json', rep(false));
    expect(releaseCheck(P).gates.find((g) => g.id === 'map')!.status).toBe('fail');
    writeJson(P, 'map-report.json', rep(true));
    expect(releaseCheck(P).gates.find((g) => g.id === 'map')!.status).toBe('pass');
  });
  it('config map defaults', () => {
    const c = BloxConfigSchema.parse({ projectPath: '/x', map: { root: 'Workspace.Farm', spawns: { Dogs: 'Workspace.Farm.Dogs' } } });
    expect(c.map).toMatchObject({ root: 'Workspace.Farm', interiorTag: 'Interior', triangleBudget: 40000 });
  });
});
