import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadManifest } from '../src/assets/manifest.js';
import { readJson } from '../src/state/store.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { fakeStudio, type FakeStudio } from './fakeStudio.js';

const env = (v: unknown) => JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] });
const hit = (assetId: string, name: string, extra: Record<string, unknown> = {}) => ({
  assetId, name, description: '', creatorName: 'Maker', assetType: 'Model', isFree: true, priceCents: 0,
  creatorStoreUrl: `https://create.roblox.com/store/asset/${assetId}`, source: 'creator_store', ...extra,
});

function ctx(opts: { scripts?: { path: string; class: string; source: string }[] } = {}): { c: ToolCtx; f: FakeStudio; luau: string[] } {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-scout-'));
  const luau: string[] = [];
  const f = fakeStudio({
    luau: (code) => {
      luau.push(code);
      if (code.includes('className = cur.ClassName')) {
        return env(JSON.stringify({ path: 'ServerStorage.BloxScout.obby', className: 'Model', parts: 120, meshParts: 3, guis: 0, screenGuis: 0, sounds: 0, size: [200, 30, 150], scripts: opts.scripts ?? [] }));
      }
      if (code.includes('LuaSourceContainer') && code.includes('removed')) {
        return env(JSON.stringify({ path: 'ServerStorage.BloxScout.obby', removed: (opts.scripts ?? []).length, parts: 120, meshParts: 3, textures: 0, scripts: opts.scripts ?? [] }));
      }
      if (code.includes('BLOX_SCOUT_MOVE')) return env(JSON.stringify({ path: 'Workspace.obby' }));
      return env('ok');
    },
    tools: {
      search_asset: (a) => {
        const q = String(a.query);
        if (q === 'obby map template') return JSON.stringify({ status: 'success', results: [hit('11', 'Obby Map Template'), hit('99', 'Paid Obby', { isFree: false, priceCents: 900 })] });
        if (q === 'obby map') return JSON.stringify({ status: 'success', results: [hit('11', 'Obby Map Template'), hit('12', 'Obby course')] });
        return JSON.stringify({ status: 'success', results: [] });
      },
      insert_asset: (a) => JSON.stringify({ status: 'success', insertedInstances: [{ fullPath: `game.${a.parentPath}.${a.assetName}`, name: a.assetName, className: 'Model' }] }),
    },
  });
  const c: ToolCtx = {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
  return { c, f, luau };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('scout')!, args, c);

describe('scout tool', () => {
  it('search queries free creator-store, ranks, saves the file', async () => {
    const { c, f } = ctx();
    const r = await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    expect(r.isError).toBeFalsy();
    const searches = f.calls.filter((x) => x.name === 'search_asset');
    expect(searches.map((x) => x.args.query)).toEqual(['obby map template', 'obby map', 'obby kit']);
    expect(searches.every((x) => x.args.priceFilter === 'free' && x.args.scope === 'creator_store')).toBe(true);
    expect(r.text).toMatch(/1\. 11 Obby Map Template/);
    expect(r.text).not.toMatch(/Paid Obby/);
    const saved = readJson<{ results: { assetId: string }[] }>(c.projectPath, 'scout/obby-map.json')!;
    expect(saved.results.map((x) => x.assetId)).toEqual(['11', '12']);
  });

  it('try refuses ids not found in a saved search', async () => {
    const { c, f } = ctx();
    const r = await call({ action: 'try', asset_id: '99', id: 'obby' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not in a saved scout search/);
    expect(f.calls.some((x) => x.name === 'insert_asset')).toBe(false);
  });

  it('try inserts into quarantine, inspects, records a candidate without sanitized, gives a verdict', async () => {
    const { c, f } = ctx();
    await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    const r = await call({ action: 'try', asset_id: '11', id: 'obby' }, c);
    expect(r.isError).toBeFalsy();
    const ins = f.calls.find((x) => x.name === 'insert_asset')!;
    expect(ins.args).toMatchObject({ assetId: '11', assetName: 'obby', parentPath: 'ServerStorage.BloxScout' });
    expect(r.text).toMatch(/verdict: adapt\b/);
    const e = loadManifest(c.projectPath).assets[0];
    expect(e).toMatchObject({ id: 'obby', kind: 'model', source: 'creator-store', licence: 'roblox-creator-store', attribution: 'Maker', status: 'candidate', ref: { assetId: 11, path: 'ServerStorage.BloxScout.obby' }, provenance: { tool: 'scout', prompt: 'obby', url: 'https://create.roblox.com/store/asset/11' }, budget: { parts: 120 } });
    expect(e.sanitized).toBeUndefined();
    expect((await call({ action: 'try', asset_id: '11', id: 'obby' }, c)).text).toMatch(/already/);
  });

  it('adopt refuses keep_scripts when risks were found; default strips and records sanitized', async () => {
    const scripts = [{ path: 'ServerStorage.BloxScout.obby.Evil', class: 'Script', source: 'loadstring("x")()' }];
    const { c, luau } = ctx({ scripts });
    await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    const t = await call({ action: 'try', asset_id: '11', id: 'obby' }, c);
    expect(t.text).toMatch(/adapt-with-care/);
    expect(t.text).toMatch(/Evil: loadstring/);
    const k = await call({ action: 'adopt', id: 'obby', to: 'Workspace', keep_scripts: true }, c);
    expect(k.isError).toBe(true);
    expect(k.text).toMatch(/risk/);
    expect((await call({ action: 'adopt', id: 'obby', to: 'CoreGui' }, c)).isError).toBe(true);
    const a = await call({ action: 'adopt', id: 'obby', to: 'Workspace' }, c);
    expect(a.isError).toBeFalsy();
    expect(luau.some((l) => l.includes('d:Destroy() removed += 1'))).toBe(true);
    const e = loadManifest(c.projectPath).assets[0];
    expect(e.ref.path).toBe('Workspace.obby');
    expect(e.sanitized).toMatchObject({ scriptsRemoved: 1 });
    expect(e.sanitized!.findings[0]).toMatch(/loadstring/);
  });

  it('discard destroys the copy and rejects the entry', async () => {
    const { c, luau } = ctx();
    await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    await call({ action: 'try', asset_id: '11', id: 'obby' }, c);
    const d = await call({ action: 'discard', id: 'obby' }, c);
    expect(d.isError).toBeFalsy();
    expect(luau.some((l) => l.includes('BLOX_SCOUT_DISCARD'))).toBe(true);
    const e = loadManifest(c.projectPath).assets[0];
    expect(e.status).toBe('rejected');
    expect(e.ref.path).toBeUndefined();
  });

  it('adopt and discard refuse entries scout did not try', async () => {
    const { c } = ctx();
    expect((await call({ action: 'adopt', id: 'nope', to: 'Workspace' }, c)).isError).toBe(true);
    expect((await call({ action: 'discard', id: 'nope' }, c)).isError).toBe(true);
  });
});

describe('scout CLI', () => {
  it('maps flags', () => {
    expect(cliArgs('scout', parseFlags(['lava', 'obby', '--kind', 'map', '--max', '5']))).toEqual({ tool: 'scout', args: { action: 'search', need: 'lava obby', kind: 'map', max: 5 } });
    expect(cliArgs('scout', parseFlags(['try', '123', '--id', 'obby']))).toEqual({ tool: 'scout', args: { action: 'try', asset_id: '123', id: 'obby' } });
    expect(cliArgs('scout', parseFlags(['adopt', 'obby', '--to', 'StarterGui', '--unpack']))).toEqual({ tool: 'scout', args: { action: 'adopt', id: 'obby', to: 'StarterGui', unpack: true } });
    expect(cliArgs('scout', parseFlags(['discard', 'obby']))).toEqual({ tool: 'scout', args: { action: 'discard', id: 'obby' } });
  });
});

