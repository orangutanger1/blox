import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioSession } from '../src/studio/session.js';
import { mapCheckProgram, triangleProgram, PROBE } from '../src/map/program.js';
import { runMapCheck, mapViews } from '../src/map/run.js';
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
    expect(p).toMatch(/probe:Destroy\(\)\nif not ok then error/);
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
