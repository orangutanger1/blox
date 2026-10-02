import { z } from 'zod';
import { readJson, writeJson } from '../state/store.js';

// .blox/assets.json — where every non-code asset came from, under what licence,
// whether it was sanitized, its budget, and whether a human approved it.

const Entry = z
  .object({
    id: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    kind: z.enum(['model', 'mesh', 'image', 'audio', 'animation']),
    source: z.enum(['code', 'creator-store', 'generated', 'external']),
    licence: z.enum(['roblox-creator-store', 'owned', 'generated-roblox', 'cc0', 'cc-by', 'proprietary', 'unknown']),
    attribution: z.string().optional(),
    ref: z.object({ assetId: z.number().int().positive().optional(), path: z.string().optional(), file: z.string().optional(), tag: z.string().optional() }).strict().default({}),
    provenance: z.object({ tool: z.string(), prompt: z.string().optional(), url: z.string().optional(), createdAt: z.string() }).strict(),
    sanitized: z.object({ at: z.string(), scriptsRemoved: z.number().int().nonnegative(), findings: z.array(z.string()) }).strict().optional(),
    budget: z.object({ tris: z.number().int().nonnegative().optional(), parts: z.number().int().nonnegative().optional() }).strict().optional(),
    status: z.enum(['candidate', 'approved', 'rejected']).default('candidate'),
    uploaded: z.object({ assetId: z.number().int().positive(), operation: z.string(), at: z.string() }).strict().optional(),
  })
  .strict();

export const ManifestSchema = z
  .object({
    version: z.literal(1),
    creator: z.object({ userId: z.number().int().positive().optional(), groupId: z.number().int().positive().optional() }).strict().optional(),
    assets: z.array(Entry).default([]),
  })
  .strict();

export type AssetManifest = z.infer<typeof ManifestSchema>;
export type AssetEntry = AssetManifest['assets'][number];

const FILE = 'assets.json';

export function validateManifest(raw: unknown): { ok: true; doc: AssetManifest } | { ok: false; errors: string[] } {
  const p = ManifestSchema.safeParse(raw);
  if (!p.success) return { ok: false, errors: p.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  const seen = new Set<string>();
  const dup = p.data.assets.find((a) => (seen.has(a.id) ? true : (seen.add(a.id), false)));
  return dup ? { ok: false, errors: [`duplicate asset id "${dup.id}"`] } : { ok: true, doc: p.data };
}

export function loadManifest(projectPath: string): AssetManifest {
  const raw = readJson<unknown>(projectPath, FILE);
  if (raw === null) return { version: 1, assets: [] };
  const v = validateManifest(raw);
  if (!v.ok) throw new Error(`.blox/assets.json is invalid:\n  ${v.errors.join('\n  ')}`);
  return v.doc;
}

export function saveManifest(projectPath: string, m: AssetManifest): void {
  writeJson(projectPath, FILE, m);
}

// New entries always start as candidates: approval is a human decision.
export function addAsset(projectPath: string, raw: unknown): { ok: true; entry: AssetEntry } | { ok: false; errors: string[] } {
  const m = loadManifest(projectPath);
  const candidate = raw && typeof raw === 'object' ? { ...(raw as Record<string, unknown>), status: 'candidate' } : raw;
  const v = validateManifest({ ...m, assets: [...m.assets, candidate] });
  if (!v.ok) return v;
  saveManifest(projectPath, v.doc);
  return { ok: true, entry: v.doc.assets[v.doc.assets.length - 1] };
}

// CLI-only (`blox asset approve <id>`): never exposed to agents over MCP.
export function approveAsset(projectPath: string, id: string, status: 'approved' | 'rejected' = 'approved'): string | null {
  const m = loadManifest(projectPath);
  const e = m.assets.find((a) => a.id === id);
  if (!e) return `unknown asset "${id}"`;
  e.status = status;
  saveManifest(projectPath, m);
  return null;
}
