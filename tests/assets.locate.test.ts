import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLocate, assetTag, locateItems, locateProgram } from '../src/assets/locate.js';
import { addAsset, loadManifest, type AssetManifest } from '../src/assets/manifest.js';
import { StudioSession } from '../src/studio/session.js';
import { findTool, invokeTool } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';
import { luneBin, luneCheck } from './helpers/lune.js';

const entry = (id: string, ref: Record<string, unknown>) => ({ id, kind: 'model' as const, source: 'creator-store' as const, licence: 'roblox-creator-store' as const, ref, provenance: { tool: 'scout', createdAt: 'x' }, status: 'approved' as const });
const manifest = (...assets: ReturnType<typeof entry>[]): AssetManifest => ({ version: 1, assets });
const reply = (result: Record<string, { paths: string[]; tagged: boolean }>) => JSON.stringify({ result });

describe('asset locate', () => {
  it('locates every placed entry by its tag, falling back to the path', () => {
    const m = manifest(entry('trees', { assetId: 1, path: 'ServerStorage.trees' }), entry('dog', { assetId: 2, path: 'Workspace.dog', tag: 'BloxAsset_dog' }), entry('gone', { assetId: 3 }));
    expect(locateItems(m)).toEqual([{ id: 'trees', tag: 'BloxAsset_trees', path: 'ServerStorage.trees' }, { id: 'dog', tag: 'BloxAsset_dog', path: 'Workspace.dog' }]);
    expect(locateItems(m, ['dog']).map((x) => x.id)).toEqual(['dog']);
  });
  // Dog Walk: the agent renamed Workspace.dog_rigged to Workspace.ParkDog and the manifest kept the old path.
  it('follows a rename and backfills the tag', () => {
    const m = manifest(entry('dog_rigged', { assetId: 2, path: 'Workspace.dog_rigged' }));
    const notes = applyLocate(m, reply({ dog_rigged: { paths: ['Workspace.ParkDog'], tagged: false } }));
    expect(m.assets[0].ref).toEqual({ assetId: 2, path: 'Workspace.ParkDog', tag: assetTag('dog_rigged') });
    expect(notes).toEqual(['dog_rigged: Workspace.dog_rigged → Workspace.ParkDog']);
  });
  it('keeps the path when it is one of several tagged copies, else the common parent', () => {
    const m = manifest(entry('a', { path: 'Workspace.Trees.Oak', tag: 'BloxAsset_a' }), entry('ui', { path: 'ServerStorage.BloxScout.ui', tag: 'BloxAsset_ui' }));
    applyLocate(m, reply({ a: { paths: ['Workspace.Trees.Oak', 'Workspace.Trees.Oak2'], tagged: false }, ui: { paths: ['StarterGui.Shop', 'StarterGui.Settings'], tagged: false } }));
    expect(m.assets.map((x) => x.ref.path)).toEqual(['Workspace.Trees.Oak', 'StarterGui']);
  });
  it('drops the path of a tagged asset that was deleted; leaves an untagged miss alone', () => {
    const m = manifest(entry('a', { path: 'Workspace.a', tag: 'BloxAsset_a' }), entry('b', { path: 'Workspace.b' }));
    const notes = applyLocate(m, reply({ a: { paths: [], tagged: false }, b: { paths: [], tagged: false } }));
    expect(m.assets[0].ref).toEqual({ tag: 'BloxAsset_a' });
    expect(m.assets[1].ref).toEqual({ path: 'Workspace.b' });
    expect(notes[0]).toBe('a: no longer in the place (was Workspace.a)');
    expect(notes[1]).toMatch(/^b: not found at Workspace\.b — .*relink/);
  });
  it('an empty reply (Luau encodes {} as []) changes nothing', () => {
    const m = manifest(entry('a', { path: 'Workspace.a' }));
    expect(applyLocate(m, JSON.stringify({ result: [] }))).toEqual([]);
  });
  it.skipIf(!luneBin())('Luau compiles', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-locate-'));
    writeFileSync(join(d, 'l.luau'), locateProgram([{ id: 'a', tag: 'BloxAsset_a', path: 'Workspace.a' }]));
    expect(luneCheck([join(d, 'l.luau')])).toEqual([]);
  });
});

describe('asset relink', () => {
  it('moves the tag to the instance at path and records it', async () => {
    const projectPath = mkdtempSync(join(tmpdir(), 'blox-relink-'));
    addAsset(projectPath, entry('dog_rigged', { assetId: 2, path: 'Workspace.dog_rigged' }));
    const env = (v: unknown) => JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] });
    const codes: string[] = [];
    const f = fakeStudio({
      luau: (code) => {
        codes.push(code);
        if (code.includes('BLOX_LOCATE')) return env(JSON.stringify({ result: { dog_rigged: { paths: ['Workspace.ParkDog'], tagged: false } } }));
        return env('ok');
      },
    });
    const c = { session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }), projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
    const r = await invokeTool(findTool('asset')!, { action: 'relink', id: 'dog_rigged', path: 'Workspace.ParkDog' }, c);
    expect(r.isError).toBeFalsy();
    expect(codes[0]).toContain('BLOX_RELINK');
    expect(codes[0]).toContain('Workspace.ParkDog');
    expect(loadManifest(projectPath).assets[0].ref).toMatchObject({ path: 'Workspace.ParkDog', tag: 'BloxAsset_dog_rigged' });
    expect(cliArgs('asset', parseFlags(['relink', 'x', 'ServerStorage.Leftovers.small', 'chest']))).toEqual({ tool: 'asset', args: { action: 'relink', id: 'x', path: 'ServerStorage.Leftovers.small chest' } });
  });
});
