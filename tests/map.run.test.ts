import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioSession } from '../src/studio/session.js';
import { mapCheckProgram, triangleProgram, stageProgram, PROBE, STAGE } from '../src/map/program.js';
import { runMapCheck, runMapChecks, mapReportFile, mapViews } from '../src/map/run.js';
import { readJson } from '../src/state/store.js';
import { fakeStudio } from './fakeStudio.js';

const env = (values: unknown[]) => JSON.stringify({ ok: true, n: values.length, values: Object.fromEntries(values.map((v, i) => [`v${i + 1}`, v])), logs: [] });
const params = { root: 'Workspace.Farm', groups: { Dogs: 'Workspace.Farm.DogSpawns' }, jump: null, step: 2, headroom: 4.6, maxColumns: 60000, interiorTag: 'Interior' };

describe('map check program', () => {
  it('embeds the parameters and the real-movement search', () => {
    const p = mapCheckProgram(params);
    expect(p).toContain('Workspace.Farm.DogSpawns');
    expect(p).toContain('TAKEOFF = 0.9');
    expect(p).toMatch(/GetPartsInPart\(probe, overlap\)/); // standing volume
    expect(p).toMatch(/bfs\(starts, radj\)/); // way back
    expect(p).toMatch(/ToHSV/);
    expect(p).toContain(`probe.Name = "${PROBE}"`);
    expect(p).toMatch(/probe:Destroy\(\)\nif tmp then tmp:Destroy\(\) end\nif not ok then error/);
  });
  it('the triangle probe restores the camera', () => {
    const t = triangleProgram({ position: [0, 50, 0], lookAt: [0, 0, 1] });
    expect(t).toContain('GetTriangleCompositionAsync');
    expect(t).toMatch(/cam\.CFrame = oldCf\ncam\.CameraType = oldType/);
  });
  it('views: a play view behind the spawn and a top view over the play area', () => {
    const v = mapViews({ spawnPos: [0, 5, 0], playBbox: { min: [-50, 0, -50], max: [50, 20, 50] } });
    expect(v.map((x) => x.name)).toEqual(['play', 'top']);
    expect(v[1].position[1]).toBeGreaterThan(100);
  });
});

describe('runMapCheck', () => {
  it('runs the check, two triangle views, writes the report', async () => {
    const seen: string[] = [];
    const raw = { root: 'Workspace.Farm', jump: 8.1, step: 2, groundY: 0, standable: 10, reachable: 10, playerSpawns: 1, spawnPos: [0, 1, 0], bbox: { min: [0, 0, 0], max: [10, 5, 10] }, playBbox: { min: [0, 0, 0], max: [10, 5, 10] }, groups: [], pockets: 0, pocketSamples: [], high: 0, highSamples: [], covered: 0, coveredOutside: 0, coveredSamples: [], outside: 0, outsideSamples: [], floating: 0, floatSamples: [], overlaps: 0, overlapSamples: [], saturation: 0.5, parts: 5, shadowCasters: 5 };
    const f = fakeStudio({
      luau: (code) => {
        if (code.includes('GetTriangleCompositionAsync')) { seen.push('tri'); return env([JSON.stringify({ opaque: 900, shadows: 100, drawcalls: 9 })]); }
        if (code.includes(PROBE)) { seen.push('check'); return env([JSON.stringify(raw)]); }
        return env([]);
      },
    });
    const s = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
    const P = mkdtempSync(join(tmpdir(), 'blox-map-'));
    const rep = await runMapCheck(s, P, { root: 'Workspace.Farm', spawns: {}, interiorTag: 'Interior', triangleBudget: 60000 });
    expect(seen).toEqual(['check', 'tri', 'tri']);
    expect(rep.raw.triangles!.views[0]).toMatchObject({ name: 'play', opaque: 900, shadows: 100 });
    expect(readJson<{ results: unknown[] }>(P, 'map-report.json')!.results).toHaveLength(9);
  });
});

describe('map check: marker spawns, roots outside Workspace, several roots', () => {
  it('the program takes marker player spawns and clones a root outside Workspace for the raycasts', () => {
    const p = mapCheckProgram({ ...params, root: 'ServerStorage.Maps.Farm', playerSpawns: 'PlayerSpawns' });
    expect(p).toContain('"playerSpawns":"PlayerSpawns"');
    expect(p).toMatch(/IsDescendantOf\(workspace\)/);
    expect(p).toMatch(/:Clone\(\)/);
    expect(p).toMatch(/if tmp then tmp:Destroy\(\) end/);
    // group paths may be child names under the root
    expect(p).toMatch(/src:FindFirstChild\(path, true\)/);
  });
  it('runs every configured root, keeps a report per root and merges them into map-report.json', async () => {
    const raw = (root: string, pockets: number) => ({ root, jump: 8.1, step: 2, groundY: 0, standable: 10, reachable: 10, playerSpawns: 2, spawnPos: [0, 1, 0], bbox: { min: [0, 0, 0], max: [10, 5, 10] }, playBbox: { min: [0, 0, 0], max: [10, 5, 10] }, groups: [], pockets, pocketSamples: pockets ? ['1,2,3'] : [], high: 0, highSamples: [], covered: 0, coveredOutside: 0, coveredSamples: [], outside: 0, outsideSamples: [], floating: 0, floatSamples: [], overlaps: 0, overlapSamples: [], saturation: 0.5, parts: 5, shadowCasters: 5 });
    const roots: string[] = [];
    const f = fakeStudio({
      luau: (code) => {
        if (code.includes('GetTriangleCompositionAsync')) return env([JSON.stringify({ opaque: 900, shadows: 100, drawcalls: 9 })]);
        if (code.includes(PROBE)) {
          const root = /"root":"([^"]+)"/.exec(code)![1];
          roots.push(root);
          expect(code).toContain('"playerSpawns":"PlayerSpawns"');
          return env([JSON.stringify(raw(root, root.endsWith('Island') ? 2 : 0))]);
        }
        return env([]);
      },
    });
    const s = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
    const P = mkdtempSync(join(tmpdir(), 'blox-map-'));
    const cfg = { root: ['ServerStorage.Maps.Farm', 'ServerStorage.Maps.Island'], playerSpawns: 'PlayerSpawns', spawns: { Dogs: 'DogSpawns' }, interiorTag: 'Interior', triangleBudget: 60000 };
    const reps = await runMapChecks(s, P, cfg);
    expect(roots).toEqual(['ServerStorage.Maps.Farm', 'ServerStorage.Maps.Island']);
    expect(reps).toHaveLength(2);
    expect(readJson(P, mapReportFile('ServerStorage.Maps.Island'))).toBeTruthy();
    const merged = readJson<{ roots: string[]; results: { id: string; ok: boolean; detail: string }[] }>(P, 'map-report.json')!;
    expect(merged.roots).toEqual(cfg.root);
    const pockets = merged.results.find((r) => r.id === 'map:pockets')!;
    expect(pockets.ok).toBe(false);
    expect(pockets.detail).toMatch(/Island: 2 reachable/);
    // one root again (--root): the merged report keeps the other root's last result
    roots.length = 0;
    await runMapChecks(s, P, cfg, ['ServerStorage.Maps.Farm']);
    expect(roots).toEqual(['ServerStorage.Maps.Farm']);
    expect(readJson<{ results: { id: string; ok: boolean }[] }>(P, 'map-report.json')!.results.find((r) => r.id === 'map:pockets')!.ok).toBe(false);
  });
});

describe('map stage: renders of a map kept outside Workspace', () => {
  it('stages a copy in Workspace around the triangle views and removes it after', async () => {
    const seen: string[] = [];
    const raw = { root: 'ServerStorage.Maps.Farm', jump: 8.1, step: 2, groundY: 0, standable: 10, reachable: 10, playerSpawns: 1, spawnPos: [0, 1, 0], bbox: { min: [0, 0, 0], max: [10, 5, 10] }, playBbox: { min: [0, 0, 0], max: [10, 5, 10] }, groups: [], pockets: 0, pocketSamples: [], high: 0, highSamples: [], covered: 0, coveredOutside: 0, coveredSamples: [], outside: 0, outsideSamples: [], floating: 0, floatSamples: [], overlaps: 0, overlapSamples: [], saturation: 0.5, parts: 5, shadowCasters: 5 };
    const f = fakeStudio({
      luau: (code) => {
        if (code.includes(STAGE)) { seen.push(code.includes(':Clone()') ? 'stage' : 'unstage'); return env([true]); }
        if (code.includes('GetTriangleCompositionAsync')) { seen.push('tri'); return env([JSON.stringify({ opaque: 1, shadows: 0, drawcalls: 1 })]); }
        if (code.includes(PROBE)) { seen.push('check'); return env([JSON.stringify(raw)]); }
        return env([]);
      },
    });
    const s = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
    const P = mkdtempSync(join(tmpdir(), 'blox-map-'));
    await runMapCheck(s, P, { root: 'ServerStorage.Maps.Farm', spawns: {}, interiorTag: 'Interior', triangleBudget: 60000 });
    expect(seen).toEqual(['check', 'stage', 'tri', 'tri', 'unstage']);
  });
  it('a Workspace root needs no stage', () => {
    expect(stageProgram('Workspace.Farm', true)).toMatch(/IsDescendantOf\(workspace\)/);
  });
});
