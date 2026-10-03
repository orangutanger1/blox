import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAsset, approveAsset, loadManifest, saveManifest, validateManifest, type AssetEntry } from '../src/assets/manifest.js';
import { lintAssets, assetResults } from '../src/assets/lint.js';

const proj = () => mkdtempSync(join(tmpdir(), 'blox-assets-'));
const entry = (o: Partial<AssetEntry> = {}): Record<string, unknown> => ({
  id: 'tree',
  kind: 'model',
  source: 'creator-store',
  licence: 'roblox-creator-store',
  ref: { assetId: 123, path: 'Workspace.Tree' },
  provenance: { tool: 'insert_asset', createdAt: '2026-10-02T00:00:00Z' },
  ...o,
});

describe('manifest', () => {
  it('empty project loads an empty manifest; add validates and forces candidate', () => {
    const p = proj();
    expect(loadManifest(p)).toEqual({ version: 1, assets: [] });
    const r = addAsset(p, { ...entry(), status: 'approved' });
    expect(r.ok).toBe(true);
    expect(loadManifest(p).assets[0].status).toBe('candidate');
    expect(addAsset(p, entry()).ok).toBe(false); // duplicate id
    const bad = addAsset(p, { ...entry({ id: 'x' }), licence: 'whatever' });
    expect(bad.ok).toBe(false);
  });
  it('approve is explicit and per id', () => {
    const p = proj();
    addAsset(p, entry());
    expect(approveAsset(p, 'nope')).toMatch(/unknown asset/);
    expect(approveAsset(p, 'tree')).toBeNull();
    expect(loadManifest(p).assets[0].status).toBe('approved');
  });
  it('validateManifest rejects unknown keys', () => {
    expect(validateManifest({ version: 1, assets: [], extra: 1 }).ok).toBe(false);
  });
});

describe('lintAssets', () => {
  const lint = (assets: Record<string, unknown>[], scan?: { untracked: { id: string; where: string }[] }) => {
    const v = validateManifest({ version: 1, assets });
    if (!v.ok) throw new Error(JSON.stringify(v.errors));
    return lintAssets(v.doc, scan).map((f) => `${f.rule}:${f.severity}:${f.asset}`);
  };
  it('clean manifest', () => {
    expect(lint([{ ...entry(), sanitized: { at: 'x', scriptsRemoved: 0, findings: [] }, status: 'approved' }])).toEqual([]);
  });
  it('licence, attribution, provenance, sanitize, budgets, rejected, untracked', () => {
    const f = lint(
      [
        { ...entry({ id: 'a', licence: 'unknown' }) },
        { ...entry({ id: 'b', source: 'external', licence: 'cc-by' }), ref: { file: 'b.fbx' } },
        { ...entry({ id: 'c', source: 'generated', licence: 'generated-roblox' }), provenance: { tool: '', createdAt: 'x' } },
        { ...entry({ id: 'd', source: 'code', licence: 'owned' }), budget: { tris: 25000 } },
        { ...entry({ id: 'e', source: 'code', licence: 'owned' }), budget: { tris: 12000, parts: 6000 } },
        { ...entry({ id: 'g', source: 'code', licence: 'owned' }), status: 'rejected' },
      ],
      { untracked: [{ id: 'rbxassetid://9', where: 'Workspace.Rock.MeshId' }] },
    );
    expect(f.sort()).toEqual(
      [
        'licence:error:a', 'sanitized:error:a',
        'licence:error:b',
        'provenance:error:c',
        'budget:error:d',
        'budget:warn:e', 'budget:warn:e',
        'rejected:error:g',
        'untracked:warn:rbxassetid://9',
      ].sort(),
    );
  });
  it('a rejected Creator Store entry no longer in the place needs no sanitize record', () => {
    // scout discard: the quarantine copy is gone, the entry stays as a record.
    expect(lint([{ ...entry({ id: 'x' }), status: 'rejected', ref: { assetId: 5 } }])).toEqual([]);
    expect(lint([{ ...entry({ id: 'y' }), status: 'rejected', ref: { assetId: 5, path: 'Workspace.Y' } }]).sort()).toEqual(['rejected:error:y', 'sanitized:error:y']);
  });
  it('results per rule', () => {
    const r = assetResults([{ rule: 'licence', severity: 'error', asset: 'a', detail: 'x' }]);
    expect(r.find((x) => x.id === 'asset:licence')!.ok).toBe(false);
    expect(r.find((x) => x.id === 'asset:budget')!.ok).toBe(true);
  });
  it('save round-trips', () => {
    const p = proj();
    saveManifest(p, { version: 1, assets: [] });
    expect(loadManifest(p).version).toBe(1);
  });
});
