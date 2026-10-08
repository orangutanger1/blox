import { describe, expect, it } from 'vitest';
import { evaluateMap, formatMap, type MapRaw } from '../src/map/evaluate.js';

const base = (o: Partial<MapRaw> = {}): MapRaw => ({
  root: 'Workspace.Map', jump: 8.1, step: 2, groundY: 0, standable: 1000, reachable: 900,
  playerSpawns: 1, bbox: { min: [0, 0, 0], max: [100, 20, 100] }, playBbox: { min: [2, 0, 2], max: [98, 20, 98] },
  groups: [{ name: 'DogSpawns', path: 'Workspace.Map.DogSpawns', found: true, points: [{ name: 'D1', pos: '1,0,1', reaches: true }, { name: 'D2', pos: '5,0,5', reaches: true }] }],
  pockets: 0, pocketSamples: [], high: 0, highSamples: [], covered: 10, coveredOutside: 0, coveredSamples: [],
  outside: 0, outsideSamples: [], floating: 0, floatSamples: [], overlaps: 0, overlapSamples: [],
  saturation: 0.42, parts: 300, shadowCasters: 120,
  triangles: { views: [{ name: 'play', opaque: 8000, shadows: 0, drawcalls: 20 }, { name: 'top', opaque: 12000, shadows: 3000, drawcalls: 30 }] },
  ...o,
});
const res = (raw: MapRaw, budget = 60000) => Object.fromEntries(evaluateMap(raw, { triangleBudget: budget }).results.map((r) => [r.id, r]));

describe('evaluateMap', () => {
  it('a clean map passes every check', () => {
    const r = res(base());
    expect(Object.keys(r)).toEqual(['map:spawns-reach', 'map:pockets', 'map:roofs', 'map:covered', 'map:floating', 'map:overlap', 'map:leak', 'map:triangles', 'map:saturation']);
    expect(Object.values(r).every((x) => x.ok)).toBe(true);
  });
  it('a spawn that cannot reach the player fails, naming it', () => {
    const raw = base({ groups: [{ name: 'DogSpawns', path: 'p', found: true, points: [{ name: 'D1', pos: '1,0,1', reaches: true }, { name: 'D7', pos: '9,0,9', reaches: false }] }] });
    expect(res(raw)['map:spawns-reach']).toMatchObject({ ok: false });
    expect(res(raw)['map:spawns-reach'].detail).toMatch(/D7 at 9,0,9/);
  });
  it('a missing spawn group fails', () => {
    expect(res(base({ groups: [{ name: 'Boss', path: 'Workspace.Map.BossSpawn', found: false, points: [] }] }))['map:spawns-reach'].detail).toMatch(/Boss.*not found/);
  });
  it('pockets and leaks fail with samples', () => {
    expect(res(base({ pockets: 3, pocketSamples: ['4,8,4'] }))['map:pockets']).toMatchObject({ ok: false, actual: 3 });
    expect(res(base({ outside: 2, outsideSamples: ['200,0,5'] }))['map:leak'].detail).toMatch(/200,0,5/);
  });
  it('roofs, covered, floating, overlap and saturation only warn', () => {
    const r = res(base({ high: 5, highSamples: ['1,9,1'], coveredOutside: 4, floating: 1, floatSamples: ['Workspace.Map.Wagon.Tongue'], overlaps: 2, overlapSamples: ['A × B'], saturation: 0.18 }));
    for (const id of ['map:roofs', 'map:covered', 'map:floating', 'map:overlap', 'map:saturation']) {
      expect(r[id].ok).toBe(true);
      expect(r[id].detail).toMatch(/^warn/);
    }
    expect(r['map:saturation'].detail).toMatch(/0\.18/);
    expect(res(base({ lighting: { haze: 0.8, density: 0.2, ccSaturation: 0, brightness: 2 } }))['map:saturation'].detail).toMatch(/Haze 0\.80[\s\S]*ColorCorrection/);
    expect(res(base({ lighting: { haze: 0.2, density: 0.2, ccSaturation: 0.15, brightness: 2 } }))['map:saturation'].detail).not.toMatch(/^warn/);
  });
  it('triangles over budget fail on the worst view; unmeasured is a note', () => {
    expect(res(base(), 10000)['map:triangles']).toMatchObject({ ok: false, actual: 15000 });
    expect(res(base(), 10000)['map:triangles'].detail).toMatch(/top.*12000 opaque.*3000 shadow/);
    expect(res(base({ triangles: null }))['map:triangles']).toMatchObject({ ok: true });
    expect(res(base({ triangles: null }))['map:triangles'].detail).toMatch(/not measured/);
  });
  it('the text names the jump used and each result', () => {
    const t = formatMap(evaluateMap(base(), { triangleBudget: 60000 }));
    expect(t).toMatch(/jump 8\.1 studs/);
    expect(t).toMatch(/✓ map:pockets/);
  });
});
