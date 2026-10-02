import type { StudioSession } from '../studio/session.js';
import { runLuau } from '../studio/luau.js';
import type { SpecFile } from '../testing/runner.js';
import { runLaneJob } from './lane.js';
import { CLEANUP, discoverMpSpecs, installProgram, MAX_CLIENTS, specsModule } from './program.js';

export interface MpRunOptions {
  clients?: number;
  filter?: string;
  timeoutSec?: number; // whole job, default 180
  testTimeoutSec?: number; // per test, default 30
  lanePort?: number;
  pickupMs?: number;
}
export interface MpResult {
  file: string;
  name: string;
  status: string;
  message?: string;
}
export interface MpReport {
  ranAt: string;
  clients: number;
  results: MpResult[];
  fileErrors: { file: string; message: string }[];
  error?: string;
}

// "ServerStorage.__BloxMp.Specs:12: msg" → "tests/theft.mp.luau:3: msg"
export function mapMpPositions(msg: string, specs: SpecFile[], specLines: number[]): string {
  return msg.replace(/[\w.]*__BloxMp\.Specs:(\d+)/g, (m, n: string) => {
    const line = Number(n);
    for (let i = specs.length - 1; i >= 0; i--) {
      const len = specs[i].source.replace(/\n$/, '').split('\n').length;
      if (line >= specLines[i] && line < specLines[i] + len) return `${specs[i].file}:${line - specLines[i] + 1}`;
    }
    return m;
  });
}

export async function runMultiplayer(session: StudioSession, projectPath: string, o: MpRunOptions = {}): Promise<MpReport> {
  const found = discoverMpSpecs(projectPath, o.filter);
  if (!found.specs.length) throw new Error(`no multiplayer specs: add tests/<name>.mp.luau (first line "-- @context multiplayer")${o.filter ? ` matching "${o.filter}"` : ''}`);
  const clients = Math.min(MAX_CLIENTS, Math.max(1, o.clients ?? found.clients));
  const st = await session.state();
  if (st.mode !== 'Edit') throw new Error('stop the playtest first: the multiplayer lane starts its own test session');
  const mod = specsModule(found.specs, o.testTimeoutSec ?? 30);
  const report: MpReport = { ranAt: new Date().toISOString(), clients, results: [], fileErrors: [] };
  const install = await runLuau(session, installProgram(mod.source, { clients, joinTimeout: 60 }), 'edit', { chunkName: 'mp-install', timeoutMs: 60_000 });
  if (!install.ok) throw new Error(`could not install the multiplayer harness: ${install.error?.message}`);
  try {
    const lane = await runLaneJob({ kind: 'multiplayer', clients }, { port: o.lanePort, pickupMs: o.pickupMs, timeoutMs: (o.timeoutSec ?? 180) * 1000 });
    if (!lane.ok) {
      report.error = `StudioTestService: ${lane.error ?? 'failed'}`;
      return report;
    }
    let out: { ok?: boolean; error?: string; results?: unknown; fileErrors?: unknown };
    try {
      out = typeof lane.result === 'string' ? JSON.parse(lane.result) : (lane.result as typeof out) ?? {};
    } catch {
      report.error = `unreadable test result: ${String(lane.result).slice(0, 200)}`;
      return report;
    }
    if (!out.ok) report.error = mapMpPositions(out.error ?? 'harness failed', found.specs, mod.specLines);
    const list = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
    report.results = list<MpResult>(out.results).map((r) => ({ ...r, ...(r.message ? { message: mapMpPositions(r.message, found.specs, mod.specLines) } : {}) }));
    report.fileErrors = list<{ file: string; message: string }>(out.fileErrors).map((e) => ({ ...e, message: mapMpPositions(e.message, found.specs, mod.specLines) }));
    return report;
  } finally {
    await runLuau(session, CLEANUP, 'edit', { chunkName: 'mp-cleanup' }).catch(() => undefined);
  }
}

export function formatMp(r: MpReport): string {
  const passed = r.results.filter((t) => t.status === 'pass').length;
  const lines = [`multiplayer (${r.clients} clients): ${passed}/${r.results.length} passed${r.error ? ` — ${r.error}` : ''}`];
  for (const e of r.fileErrors) lines.push(`  FILE ERROR ${e.file}: ${e.message}`);
  for (const t of r.results) if (t.status !== 'pass') lines.push(`  ${t.status.toUpperCase()} ${t.file} › ${t.name}\n        ${t.message ?? ''}`);
  return lines.join('\n');
}
