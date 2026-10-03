import type { MetricResult } from '../metrics/gamefeel.js';
import type { AssetManifest } from './manifest.js';

export type AssetRule = 'licence' | 'provenance' | 'sanitized' | 'budget' | 'rejected' | 'untracked';
export const ASSET_RULES: AssetRule[] = ['licence', 'provenance', 'sanitized', 'budget', 'rejected', 'untracked'];
export interface AssetFinding {
  rule: AssetRule;
  severity: 'error' | 'warn';
  asset: string;
  detail: string;
}
export interface ScanSummary {
  untracked: { id: string; where: string }[];
}

const MAX_TRIS = 20_000; // MeshPart hard limit
const TARGET_TRIS = 10_000; // mobile-friendly target
const MAX_PARTS = 5_000;

export function lintAssets(m: AssetManifest, scan?: ScanSummary): AssetFinding[] {
  const out: AssetFinding[] = [];
  const add = (rule: AssetRule, severity: AssetFinding['severity'], asset: string, detail: string) => out.push({ rule, severity, asset, detail });
  for (const a of m.assets) {
    if (a.licence === 'unknown') add('licence', 'error', a.id, 'licence unknown — record it before shipping');
    else if (a.licence === 'cc-by' && !a.attribution) add('licence', 'error', a.id, 'cc-by needs an attribution line');
    if (!a.provenance.tool.trim()) add('provenance', 'error', a.id, 'provenance.tool is empty');
    if (a.source === 'creator-store' && !a.sanitized && !(a.status === 'rejected' && !a.ref.path)) add('sanitized', 'error', a.id, 'Creator Store model not sanitized — asset {action:"sanitize", path}');
    const tris = a.budget?.tris;
    if (tris !== undefined && tris > MAX_TRIS) add('budget', 'error', a.id, `${tris} triangles > ${MAX_TRIS} (MeshPart limit) — asset {action:"normalize"}`);
    else if (tris !== undefined && tris > TARGET_TRIS) add('budget', 'warn', a.id, `${tris} triangles > ${TARGET_TRIS} mobile target`);
    if ((a.budget?.parts ?? 0) > MAX_PARTS) add('budget', 'warn', a.id, `${a.budget!.parts} parts > ${MAX_PARTS}`);
    if (a.status === 'rejected' && a.ref.path) add('rejected', 'error', a.id, `rejected by a human but still at ${a.ref.path} — remove it`);
  }
  for (const u of scan?.untracked ?? []) add('untracked', 'warn', u.id, `referenced at ${u.where} but not in .blox/assets.json`);
  return out;
}

export function assetResults(findings: AssetFinding[]): MetricResult[] {
  return ASSET_RULES.map((rule) => {
    const errs = findings.filter((f) => f.rule === rule && f.severity === 'error');
    const warns = findings.filter((f) => f.rule === rule && f.severity === 'warn').length;
    return { id: `asset:${rule}`, ok: errs.length === 0, actual: errs.length, detail: errs.length ? `${errs[0].asset}: ${errs[0].detail}` : warns ? `${warns} warning(s)` : 'ok' };
  });
}

export function formatAssetLint(findings: AssetFinding[], results: MetricResult[]): string {
  const lines = [`asset lint: ${results.filter((r) => r.ok).length}/${results.length} rules pass`];
  for (const f of findings) lines.push(`  ${f.severity === 'error' ? 'ERROR' : 'WARN '} ${f.rule} [${f.asset}] ${f.detail}`);
  return lines.join('\n');
}
