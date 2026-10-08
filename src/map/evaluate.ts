import type { MetricResult } from '../metrics/gamefeel.js';

// Raw `map check` measurements (from the edit-mode Luau program) → results
// bound as map:<id> criteria. Movement faults and budgets fail; things that
// may be on purpose (reachable roofs, covered areas, overlaps) only warn.

export interface MapPoint {
  name: string;
  pos: string;
  reaches: boolean; // can walk/jump/drop to a player spawn
}
export interface MapGroup {
  name: string;
  path: string;
  found: boolean;
  points: MapPoint[];
}
export interface TriangleView {
  name: string;
  opaque: number;
  shadows: number;
  drawcalls: number;
}
export interface MapRaw {
  root: string;
  jump: number;
  step: number;
  groundY: number;
  standable: number;
  reachable: number;
  playerSpawns: number;
  bbox: { min: number[]; max: number[] };
  playBbox: { min: number[]; max: number[] };
  groups: MapGroup[];
  pockets: number;
  pocketSamples: string[];
  high: number;
  highSamples: string[];
  covered: number;
  coveredOutside: number; // covered + reachable, not inside a part tagged as an interior
  coveredSamples: string[];
  outside: number;
  outsideSamples: string[];
  floating: number;
  floatSamples: string[];
  overlaps: number;
  overlapSamples: string[];
  saturation: number; // area-weighted mean HSV saturation of visible parts
  parts: number;
  shadowCasters: number;
  triangles: { views: TriangleView[] } | null;
  shotSaturation?: number; // mean pixel saturation of the last map shots sheet
  lighting?: { haze: number; density: number; ccSaturation: number; brightness: number };
}
export interface MapReport {
  ranAt: string;
  raw: MapRaw;
  results: MetricResult[];
}

export const MIN_SATURATION = 0.3;
const s = (xs: string[], n = 4) => xs.slice(0, n).join('; ');
const warn = (n: number, what: string, samples: string[], fix: string): MetricResult => ({
  id: '',
  ok: true,
  actual: n,
  detail: n ? `warn: ${n} ${what} (e.g. ${s(samples)}) — ${fix}` : 'clean',
});

export function evaluateMap(raw: MapRaw, cfg: { triangleBudget: number }): MapReport {
  const r: MetricResult[] = [];
  const bad: string[] = [];
  for (const g of raw.groups) {
    if (!g.found) bad.push(`${g.name}: ${g.path} not found`);
    for (const p of g.points) if (!p.reaches) bad.push(`${g.name}/${p.name} at ${p.pos} can't reach a player spawn`);
  }
  const total = raw.groups.reduce((a, g) => a + g.points.length, 0);
  r.push({ id: 'map:spawns-reach', ok: bad.length === 0, actual: bad.length, detail: bad.length ? s(bad, 6) : `${total} spawn point(s) in ${raw.groups.length} group(s) reach a player spawn` });
  r.push({ id: 'map:pockets', ok: raw.pockets === 0, actual: raw.pockets, detail: raw.pockets ? `${raw.pockets} reachable point(s) with no way back to the spawns (e.g. ${s(raw.pocketSamples)}): fill the hole or add a way out` : 'clean' });
  r.push({ ...warn(raw.high, `reachable point(s) more than ${raw.jump.toFixed(1)} studs above the ground`, raw.highSamples, 'fine if meant (stairs, platforms); else raise the eaves or move what players jump from'), id: 'map:roofs' });
  r.push({ ...warn(raw.coveredOutside, 'reachable covered point(s) outside interiors', raw.coveredSamples, 'tag real interiors "Interior" (CollectionService) or block the gap'), id: 'map:covered' });
  r.push({ ...warn(raw.floating, 'floating part(s)', raw.floatSamples, 'rest them on something or delete them'), id: 'map:floating' });
  r.push({ ...warn(raw.overlaps, 'overlapping part pair(s)', raw.overlapSamples, 'split or shorten the pieces so faces meet instead of crossing'), id: 'map:overlap' });
  r.push({ id: 'map:leak', ok: raw.outside === 0, actual: raw.outside, detail: raw.outside ? `${raw.outside} reachable point(s) outside the boundary (e.g. ${s(raw.outsideSamples)}): close the wall or add an invisible barrier` : 'clean' });
  if (!raw.triangles?.views.length) r.push({ id: 'map:triangles', ok: true, actual: 0, detail: 'not measured (SceneAnalysisService unavailable)' });
  else {
    const worst = [...raw.triangles.views].sort((a, b) => b.opaque + b.shadows - (a.opaque + a.shadows))[0];
    const tot = worst.opaque + worst.shadows;
    const views = raw.triangles.views.map((v) => `${v.name} ${v.opaque} opaque + ${v.shadows} shadow`).join(', ');
    r.push({
      id: 'map:triangles',
      ok: tot <= cfg.triangleBudget,
      actual: tot,
      detail: `${tot <= cfg.triangleBudget ? '' : `over the ${cfg.triangleBudget} budget: `}${views} (${raw.shadowCasters}/${raw.parts} parts cast shadows)${tot > cfg.triangleBudget ? ' — set CastShadow = false on small props, use fewer cylinders/balls, merge decor' : ''}`,
    });
  }
  // Vibrancy is mostly lighting: the bake-off's two maps had the same part
  // saturation (0.52 / 0.54); the washed-out one had Atmosphere haze 0.8 and no colour correction.
  const sat = raw.saturation;
  const L = raw.lighting;
  const dull = [
    sat < MIN_SATURATION ? `part saturation ${sat.toFixed(2)} < ${MIN_SATURATION} (use BloxMap.Palette)` : '',
    L && L.haze > 0.5 ? `Atmosphere.Haze ${L.haze.toFixed(2)} washes colours out (≤ 0.3)` : '',
    L && L.density > 0.35 ? `Atmosphere.Density ${L.density.toFixed(2)} (≤ 0.3)` : '',
    L && L.ccSaturation < 0.05 ? 'no ColorCorrection saturation boost (+0.1–0.2)' : '',
    raw.shotSaturation !== undefined && raw.shotSaturation < 0.45 ? `rendered shots saturation ${raw.shotSaturation.toFixed(2)}` : '',
  ].filter(Boolean);
  const facts = `part saturation ${sat.toFixed(2)}${raw.shotSaturation !== undefined ? `, shots ${raw.shotSaturation.toFixed(2)}` : ''}${L ? `, haze ${L.haze.toFixed(2)}, colour correction ${L.ccSaturation >= 0 ? '+' : ''}${L.ccSaturation.toFixed(2)}` : ''}`;
  r.push({ id: 'map:saturation', ok: true, actual: Number(sat.toFixed(2)), detail: dull.length ? `warn: ${dull.join('; ')} — young players like bright, saturated maps: BloxMap.Lighting.apply("bright")` : facts });
  return { ranAt: new Date().toISOString(), raw, results: r };
}

export function formatMap(rep: MapReport): string {
  const x = rep.raw;
  const fails = rep.results.filter((r) => !r.ok).length;
  const size = (b: { min: number[]; max: number[] }) => `${Math.round(b.max[0] - b.min[0])}×${Math.round(b.max[2] - b.min[2])}`;
  const lines = [
    `map check ${x.root}: ${rep.results.length - fails}/${rep.results.length} pass — jump ${x.jump.toFixed(1)} studs (incl. 0.9 take-off), grid ${x.step} studs, ${x.reachable}/${x.standable} standable points reachable, play area ${size(x.playBbox)} of ${size(x.bbox)}`,
  ];
  for (const r of rep.results) lines.push(`  ${r.ok ? '✓' : '✗'} ${r.id}  ${r.detail}`);
  return lines.join('\n');
}
