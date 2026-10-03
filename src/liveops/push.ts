import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readJson, writeJson } from '../state/store.js';
import { validateDesign } from '../design/schema.js';
import { isPathContained } from '../agent/guardrail.js';

// Live pushes (config values, thumbnails) change the running experience, so
// like `blox release approve` a human signs off on the exact payload from the
// CLI; push {confirm:true} refuses anything that differs from what was approved.

export type PushKind = 'config' | 'thumbnails';

export interface ConfigPayload { kind: 'config'; entries: Record<string, unknown>; skipped: string[] }
export interface ThumbnailPayload { kind: 'thumbnails'; files: string[] }
export type PushPayload = ConfigPayload | ThumbnailPayload;

const APPROVAL = 'liveops-approval.json';

export function configPayload(projectPath: string): ConfigPayload {
  const dv = validateDesign(readJson<unknown>(projectPath, 'design.json'));
  if (!dv.ok) throw new Error('push config needs a valid .blox/design.json');
  const monetized = new Set(dv.doc.monetization.map((m) => m.id));
  const entries: Record<string, unknown> = {};
  const skipped: string[] = [];
  for (const [k, v] of Object.entries(dv.doc.tunables)) {
    if (/price|robux|cost.*robux|product|pass/i.test(k) || monetized.has(k)) skipped.push(k);
    else entries[k] = v;
  }
  return { kind: 'config', entries, skipped };
}

export function thumbnailPayload(projectPath: string): ThumbnailPayload {
  const lint = readJson<{ results: { ok: boolean }[] }>(projectPath, 'present-report.json');
  if (!lint || lint.results.some((r) => !r.ok)) throw new Error('present lint must pass first (present {action:"lint"})');
  const pres = readJson<{ shots?: { kind: string; file?: string; provenance?: string }[] }>(projectPath, 'presentation.json');
  const files = (pres?.shots ?? [])
    .filter((s) => s.kind === 'thumbnail' && s.file && (s.provenance === 'render' || s.provenance === 'human'))
    .map((s) => s.file!);
  const outside = files.find((f) => !isPathContained(projectPath, f));
  if (outside) throw new Error(`thumbnail ${outside} is outside the project`);
  return { kind: 'thumbnails', files };
}

export function pushPayload(projectPath: string, kind: PushKind): PushPayload {
  return kind === 'config' ? configPayload(projectPath) : thumbnailPayload(projectPath);
}

// Thumbnails hash their file bytes, so a re-render after approval needs a new sign-off.
export function payloadHash(projectPath: string, p: PushPayload, read: (f: string) => Buffer = (f) => readFileSync(`${projectPath}/${f}`)): string {
  const h = createHash('sha256').update(p.kind);
  if (p.kind === 'config') h.update(JSON.stringify(p.entries));
  else for (const f of p.files) h.update(f).update(read(f));
  return h.digest('hex');
}

// CLI-only (`blox liveops approve config|thumbnails`).
export function approveLiveops(projectPath: string, kind: PushKind): string {
  const sha256 = payloadHash(projectPath, pushPayload(projectPath, kind));
  const prev = readJson<Record<string, unknown>>(projectPath, APPROVAL) ?? {};
  writeJson(projectPath, APPROVAL, { ...prev, [kind]: { sha256, approvedAt: new Date().toISOString() } });
  return sha256;
}

export function isApproved(projectPath: string, p: PushPayload): boolean {
  const a = readJson<Partial<Record<PushKind, { sha256: string }>>>(projectPath, APPROVAL);
  return a?.[p.kind]?.sha256 === payloadHash(projectPath, p);
}
