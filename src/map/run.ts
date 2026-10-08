import type { StudioSession } from '../studio/session.js';
import { runLuau } from '../studio/luau.js';
import { readJson, writeJson } from '../state/store.js';
import { evaluateMap, mergeMapReports, type MapRaw, type MapReport, type TriangleView } from './evaluate.js';
import { mapCheckProgram, stageProgram, triangleProgram } from './program.js';

export interface MapConfig {
  root: string | string[]; // several maps (ServerStorage.Maps.Farm, …): one check each, merged for the gate
  playerSpawns?: string; // marker parts players start at (path or name under the root); default SpawnLocations
  spawns: Record<string, string>;
  jumpHeight?: number; // studs as players really jump (overrides StarterPlayer + take-off)
  walkSpeed?: number;
  boundary?: { min: [number, number]; max: [number, number] };
  interiorTag: string;
  triangleBudget: number;
  step?: number;
}

type V3 = number[];
export interface MapView {
  name: string;
  position: V3;
  lookAt: V3;
}

// The two views the triangle budget is measured from: what a player sees
// standing behind the spawn, and the whole play area from above.
export function mapViews(raw: { spawnPos: V3; playBbox: { min: V3; max: V3 } }): MapView[] {
  const b = raw.playBbox;
  const c = [(b.min[0] + b.max[0]) / 2, raw.spawnPos[1], (b.min[2] + b.max[2]) / 2];
  const dx = c[0] - raw.spawnPos[0], dz = c[2] - raw.spawnPos[2];
  const len = Math.hypot(dx, dz) || 1;
  const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2], 40);
  return [
    { name: 'play', position: [raw.spawnPos[0] - (dx / len) * 10, raw.spawnPos[1] + 7, raw.spawnPos[2] - (dz / len) * 10], lookAt: [c[0], raw.spawnPos[1] + 4, c[2]] },
    { name: 'top', position: [c[0], b.max[1] + span * 1.1, c[2] + 0.01], lookAt: [c[0], b.min[1], c[2]] },
  ];
}

export const mapRoots = (root: string | string[]): string[] => (Array.isArray(root) ? root : [root]);
// .blox/map-report.<root>.json keeps each map's last check; map-report.json is the merge the gate reads
export const mapReportFile = (root: string): string => `map-report.${root.replace(/[^A-Za-z0-9_-]+/g, '-')}.json`;

// Check `only` (default: every configured root), then merge the latest report
// of every configured root (plus the ones just run) into map-report.json.
export async function runMapChecks(session: StudioSession, projectPath: string, cfg: MapConfig, only?: string[]): Promise<MapReport[]> {
  const run = only?.length ? only : mapRoots(cfg.root);
  const reps: MapReport[] = [];
  for (const root of run) reps.push(await runMapCheck(session, projectPath, { ...cfg, root }));
  mergeLatestMapReports(projectPath, [...new Set([...mapRoots(cfg.root), ...run])]);
  return reps;
}

export function readMapReport(projectPath: string, root: string): MapReport | null {
  const own = readJson<MapReport>(projectPath, mapReportFile(root));
  if (own) return own;
  const old = readJson<MapReport>(projectPath, 'map-report.json'); // written before per-root reports
  return old && !old.roots && old.raw?.root === root ? old : null;
}

export function mergeLatestMapReports(projectPath: string, roots: string[]): void {
  const latest = roots.map((r) => readMapReport(projectPath, r)).filter((x): x is MapReport => !!x);
  if (latest.length) writeJson(projectPath, 'map-report.json', latest.length > 1 ? mergeMapReports(latest) : latest[0]);
}

// Run renders with a map kept outside Workspace copied into it (no-op for a Workspace root).
export async function withStage<T>(session: StudioSession, root: string | undefined, f: () => Promise<T>): Promise<T> {
  const staged = root && !/^(game\.)?Workspace\./.test(root) ? await runLuau(session, stageProgram(root, true), 'edit', { chunkName: 'mapStage' }) : null;
  try {
    return await f();
  } finally {
    if (staged?.ok && staged.values[0] === true) await runLuau(session, stageProgram(root!, false), 'edit', { chunkName: 'mapUnstage' });
  }
}

export async function runMapCheck(session: StudioSession, projectPath: string, cfg: MapConfig & { root: string }): Promise<MapReport> {
  if ((await session.state()).mode !== 'Edit') throw new Error('map check runs in the edit DataModel: stop the playtest first');
  const r = await runLuau(
    session,
    mapCheckProgram({ root: cfg.root, playerSpawns: cfg.playerSpawns, groups: cfg.spawns, jump: cfg.jumpHeight ?? null, step: cfg.step ?? 2, headroom: 4.6, maxColumns: 60_000, interiorTag: cfg.interiorTag, boundary: cfg.boundary }),
    'edit',
    { chunkName: 'mapCheck', timeoutMs: 600_000 },
  );
  if (!r.ok) throw new Error(`map check failed: ${r.error?.message}`);
  const raw = JSON.parse(String(r.values[0])) as MapRaw & { spawnPos: V3 };
  const views: TriangleView[] = [];
  await withStage(session, cfg.root, async () => {
    for (const v of mapViews(raw)) {
      const t = await runLuau(session, triangleProgram(v), 'edit', { chunkName: `mapTris-${v.name}`, timeoutMs: 60_000 });
      const j = t.ok ? (JSON.parse(String(t.values[0])) as { unavailable?: boolean; opaque: number; shadows: number; drawcalls: number }) : { unavailable: true, opaque: 0, shadows: 0, drawcalls: 0 };
      if (!j.unavailable) views.push({ name: v.name, opaque: j.opaque, shadows: j.shadows, drawcalls: j.drawcalls });
    }
  });
  raw.triangles = views.length ? { views } : null;
  const rep = evaluateMap(raw, { triangleBudget: cfg.triangleBudget });
  writeJson(projectPath, mapReportFile(cfg.root), rep);
  writeJson(projectPath, 'map-report.json', rep);
  return rep;
}
