import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadManifest, saveManifest } from '../src/assets/manifest.js';
import { readJson } from '../src/state/store.js';
import { cliArgs, parseFlags, TOOL_COMMANDS } from '../src/cliTools.js';
import { fakeStudio, type FakeStudio } from './fakeStudio.js';
import { luneBin, luneCheck } from './helpers/lune.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { unzipTo } from '../src/assets/unzip.js';
import { crc32, deflateRawSync } from 'node:zlib';

const env = (v: unknown) => JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] });
const hit = (assetId: string, name: string, extra: Record<string, unknown> = {}) => ({
  assetId, name, description: '', creatorName: 'Maker', assetType: 'Model', isFree: true, priceCents: 0,
  creatorStoreUrl: `https://create.roblox.com/store/asset/${assetId}`, source: 'creator_store', ...extra,
});

// Fake web: DevForum search + topics, economy details, and file downloads.
type Web = Record<string, unknown | ((url: string) => unknown)>;
const NO_WEB: Web = {};
function fakeFetch(web: Web, seen: string[] = []) {
  return async (url: string) => {
    seen.push(url);
    const key = Object.keys(web).find((k) => url.startsWith(k));
    if (!key) return { ok: false, status: 404, json: async () => ({}) };
    const v = typeof web[key] === 'function' ? (web[key] as (u: string) => unknown)(url) : web[key];
    if (v instanceof Uint8Array) return { ok: true, status: 200, json: async () => ({}), arrayBuffer: async () => v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) };
    return { ok: true, status: 200, json: async () => v };
  };
}
// Minimal zip writer (deflate) for import tests.
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text);
    const data = deflateRawSync(raw);
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8);
    h.writeUInt32LE(crc32(raw), 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(raw.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(crc32(raw), 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    locals.push(h, n, data);
    centrals.push(c, n);
    off += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(Object.keys(files).length, 8); e.writeUInt16LE(Object.keys(files).length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, e]);
}
const details = (name: string, typeId: number, free: boolean) => ({ Name: name, Description: '', AssetTypeId: typeId, IsPublicDomain: free, PriceInRobux: null, Creator: { Name: 'Forumer' } });

function ctx(opts: { scripts?: { path: string; class: string; source: string }[]; moveFails?: boolean; left?: number; web?: Web; fetched?: string[] } = {}): { c: ToolCtx; f: FakeStudio; luau: string[] } {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-scout-'));
  const luau: string[] = [];
  const f = fakeStudio({
    luau: (code) => {
      luau.push(code);
      if (code.includes('local KEEP = ')) {
        const strip = code.includes('local KEEP = false');
        return env(JSON.stringify({ path: 'ServerStorage.BloxScout.obby', className: 'Model', parts: 120, meshParts: 3, textures: 0, guis: 0, screenGuis: 0, sounds: 0, size: [200, 30, 150], removed: strip ? (opts.scripts ?? []).length : 0, scripts: opts.scripts ?? [], next: null }));
      }
      if (code.includes('BLOX_SCOUT_MOVE')) {
        if (opts.moveFails) { opts.moveFails = false; return JSON.stringify({ ok: false, error: { message: 'Workspace already has obby' }, logs: [] }); }
        return env(JSON.stringify(code.includes('if true then') ? { paths: ['game.StarterGui.HUD'], moved: 1, left: opts.left ?? 0 } : { paths: ['game.Workspace.obby'], moved: 1, left: 0 }));
      }
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
    fetch: fakeFetch(opts.web ?? NO_WEB, opts.fetched),
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

  it('try refuses an unsaved id the economy API says is paid, missing, or a plugin', async () => {
    const { c, f } = ctx({ web: {
      'https://economy.roblox.com/v2/assets/99/': details('Paid Obby', 10, false),
      'https://economy.roblox.com/v2/assets/38/': details('Some Plugin', 38, true),
    } });
    expect((await call({ action: 'try', asset_id: '99', id: 'obby' }, c)).text).toMatch(/not free/);
    expect((await call({ action: 'try', asset_id: '77', id: 'obby' }, c)).text).toMatch(/not found on Roblox/);
    expect((await call({ action: 'try', asset_id: '38', id: 'obby' }, c)).text).toMatch(/not usable as model/);
    expect(f.calls.some((x) => x.name === 'insert_asset')).toBe(false);
  });

  it('try takes a free id found on the web without a saved search', async () => {
    const { c, f } = ctx({ web: { 'https://economy.roblox.com/v2/assets/555/': details('Low Poly Pack', 10, true) } });
    const r = await call({ action: 'try', asset_id: '555', id: 'trees', kind: 'model', need: 'park trees' }, c);
    expect(r.isError).toBeFalsy();
    expect(f.calls.find((x) => x.name === 'insert_asset')!.args).toMatchObject({ assetId: '555', assetType: 'Model' });
    expect(loadManifest(c.projectPath).assets[0]).toMatchObject({ id: 'trees', source: 'creator-store', attribution: 'Forumer', provenance: { prompt: 'park trees' } });
  });

  it('search adds DevForum community-resource packs (free ones only) and off-site leads', async () => {
    const fetched: string[] = [];
    const { c } = ctx({ fetched, web: {
      'https://devforum.roblox.com/search.json': { topics: [{ id: 1, slug: 'obby-map-pack', title: 'Obby Map Pack' }, { id: 2, slug: 'obby-ui', title: 'Obby UI' }] },
      'https://devforum.roblox.com/t/1.json': { post_stream: { posts: [{ cooked: '<p>Free to use, credit appreciated.</p><a href="https://create.roblox.com/store/asset/50000/Obby-Map">get</a> <a href="https://www.roblox.com/library/60000/Paid">x</a>' }] } },
      'https://devforum.roblox.com/t/2.json': { post_stream: { posts: [{ cooked: '<p>Download: <a href="https://maker.itch.io/obby-ui">itch</a></p>' }] } },
      'https://economy.roblox.com/v2/assets/50000/': details('Obby Map Pack', 10, true),
      'https://economy.roblox.com/v2/assets/60000/': details('Paid Map', 10, false),
    } });
    const r = await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/50000 Obby Map Pack .*\[devforum https:\/\/devforum\.roblox\.com\/t\/obby-map-pack\/1\] terms: "Free to use, credit appreciated\."/);
    expect(r.text).not.toMatch(/Paid Map/);
    expect(r.text).toMatch(/off-site packs[\s\S]*Obby UI https:\/\/maker\.itch\.io\/obby-ui/);
    expect(fetched.some((u) => u.includes('search.json'))).toBe(true);
    const tried = await call({ action: 'try', asset_id: '50000', id: 'forumMap' }, c);
    expect(tried.isError).toBeFalsy();
    expect(loadManifest(c.projectPath).assets[0].provenance.url).toBe('https://devforum.roblox.com/t/obby-map-pack/1');
  });

  it('search sources:["store"] skips the web', async () => {
    const fetched: string[] = [];
    const { c } = ctx({ fetched });
    await call({ action: 'search', need: 'obby', kind: 'map', sources: ['store'] }, c);
    expect(fetched).toEqual([]);
  });

  it('import records a downloaded file as an external candidate; refuses html and missing licence', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    const { c } = ctx({ web: {
      'https://kenney.nl/coin.png': png,
      'https://itch.io/page': new TextEncoder().encode('<!DOCTYPE html><html>download</html>'),
    } });
    expect((await call({ action: 'import', url: 'https://kenney.nl/coin.png', id: 'coinIcon' }, c)).text).toMatch(/needs licence/);
    expect((await call({ action: 'import', url: 'https://itch.io/page', id: 'x', licence: 'cc0' }, c)).text).toMatch(/web page, not a file/);
    expect((await call({ action: 'import', url: 'http://kenney.nl/coin.png', id: 'x', licence: 'cc0' }, c)).text).toMatch(/https/);
    const r = await call({ action: 'import', url: 'https://kenney.nl/coin.png', id: 'coinIcon', licence: 'cc0', source_url: 'https://kenney.nl/assets/ui-pack', attribution: 'Kenney' }, c);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/blox asset approve coinIcon/);
    expect(loadManifest(c.projectPath).assets[0]).toMatchObject({ id: 'coinIcon', kind: 'image', source: 'external', licence: 'cc0', attribution: 'Kenney', status: 'candidate', ref: { file: 'assets/vendor/coinIcon/coin.png' }, provenance: { url: 'https://kenney.nl/assets/ui-pack' } });
  });

  it('import lists a zip and records the picked file', async () => {
    const { c } = ctx();
    const dir = join(c.projectPath, 'dl');
    mkdirSync(join(dir, 'pack', 'PNG'), { recursive: true });
    writeFileSync(join(dir, 'pack', 'PNG', 'star.png'), 'x');
    writeFileSync(join(dir, 'pack', 'PNG', 'coin.png'), 'x');
    writeFileSync(join(dir, 'pack', 'readme.txt'), 'x');
    writeFileSync(join(dir, 'pack.zip'), makeZip({ 'pack/PNG/star.png': 'x', 'pack/PNG/coin.png': 'x', 'pack/readme.txt': 'x' }));
    const list = await call({ action: 'import', file: 'dl/pack.zip', id: 'uiPack', licence: 'cc0', source_url: 'https://kenney.nl' }, c);
    expect(list.text).toMatch(/2 usable file\(s\)/);
    expect(list.text).toMatch(/coin\.png/);
    expect(list.text).not.toMatch(/readme/);
    expect(loadManifest(c.projectPath).assets).toEqual([]);
    const r = await call({ action: 'import', file: 'dl/pack.zip', pick: 'PNG/coin.png', id: 'uiPack', licence: 'cc0', source_url: 'https://kenney.nl' }, c);
    expect(r.isError).toBeFalsy();
    expect(loadManifest(c.projectPath).assets[0].ref.file).toBe('assets/vendor/uiPack/unzipped/pack/PNG/coin.png');
  });

  it('try takes this project\'s uploaded import by its asset id, keeping its licence', async () => {
    const { c, f } = ctx();
    writeFileSync(join(c.projectPath, 'trees.rbxm'), 'x');
    await call({ action: 'import', file: 'trees.rbxm', id: 'trees', licence: 'cc-by', source_url: 'https://x.itch.io/trees', attribution: 'X' }, c);
    const m = loadManifest(c.projectPath);
    m.assets[0].status = 'approved';
    m.assets[0].uploaded = { assetId: 4242, operation: 'op', at: 'now' };
    saveManifest(c.projectPath, m);
    const r = await call({ action: 'try', asset_id: 4242, id: 'treesTry' }, c);
    expect(r.isError).toBeFalsy();
    expect(f.calls.find((x) => x.name === 'insert_asset')!.args).toMatchObject({ assetId: '4242' });
    expect(loadManifest(c.projectPath).assets[1]).toMatchObject({ id: 'treesTry', source: 'external', licence: 'cc-by', attribution: 'X' });
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

  it('adopt unpack moves the top-most GUI containers when there are any', async () => {
    const { c, luau } = ctx();
    await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    await call({ action: 'try', asset_id: '11', id: 'obby' }, c);
    await call({ action: 'adopt', id: 'obby', to: 'StarterGui', unpack: true }, c);
    const mv = luau.find((l) => l.includes('BLOX_SCOUT_MOVE'))!;
    expect(mv).toMatch(/IsA\("LayerCollector"\)/);
    expect(mv).toMatch(/src:GetChildren\(\)/);
  });

  it('adopt normalises the to path, and a failed move then retry keeps the scripts-removed count', async () => {
    const scripts = [{ path: 'ServerStorage.BloxScout.obby.Old', class: 'Script', source: 'print(1)' }];
    const o = { scripts, moveFails: true };
    const { c, luau } = ctx(o);
    await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    await call({ action: 'try', asset_id: '11', id: 'obby' }, c);
    const first = await call({ action: 'adopt', id: 'obby', to: 'game.Workspace..' }, c);
    expect(first.isError).toBe(true);
    expect(loadManifest(c.projectPath).assets[0].sanitized).toMatchObject({ scriptsRemoved: 1 });
    o.scripts = []; // already stripped
    const again = await call({ action: 'adopt', id: 'obby', to: 'Workspace' }, c);
    expect(again.isError, again.text).toBeFalsy();
    expect(loadManifest(c.projectPath).assets[0].sanitized).toMatchObject({ scriptsRemoved: 1 });
    expect(luau.filter((l) => l.includes('BLOX_SCOUT_MOVE'))[0]).toContain('[[Workspace]]');
  });

  it('adopt unpack leaves non-GUI leftovers in the quarantine and says so', async () => {
    const { c } = ctx({ left: 4 });
    await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    await call({ action: 'try', asset_id: '11', id: 'obby' }, c);
    const a = await call({ action: 'adopt', id: 'obby', to: 'StarterGui', unpack: true }, c);
    expect(a.text).toMatch(/StarterGui\.HUD/);
    expect(a.text).toMatch(/4 instance\(s\) that were not GUI stayed in ServerStorage\.BloxScout\.obby/);
    expect(loadManifest(c.projectPath).assets[0].ref.path).toBe('ServerStorage.BloxScout.obby');
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

  it('discard cleans the quarantine even when try failed before recording', async () => {
    const { c, luau } = ctx();
    const d = await call({ action: 'discard', id: 'orphan' }, c);
    expect(d.isError).toBeFalsy();
    expect(d.text).toMatch(/no manifest entry/);
    expect(luau.some((l) => l.includes('BLOX_SCOUT_DISCARD') && l.includes('orphan'))).toBe(true);
  });

  it('adopt and discard refuse entries scout did not try', async () => {
    const { c } = ctx();
    expect((await call({ action: 'adopt', id: 'nope', to: 'Workspace' }, c)).isError).toBe(true);
  });
});

describe('scout Luau', () => {
  it.skipIf(!luneBin())('every generated program compiles', async () => {
    const { c, luau } = ctx();
    await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    await call({ action: 'try', asset_id: '11', id: 'obby' }, c);
    await call({ action: 'adopt', id: 'obby', to: 'StarterGui', unpack: true }, c);
    await call({ action: 'search', need: 'obby', kind: 'map' }, c);
    await call({ action: 'try', asset_id: '12', id: 'obby2' }, c);
    await call({ action: 'discard', id: 'obby2' }, c);
    const d = mkdtempSync(join(tmpdir(), 'blox-scout-luau-'));
    const files = luau.map((code, i) => {
      const f = join(d, `p${i}.luau`);
      writeFileSync(f, code);
      return f;
    });
    expect(files.length).toBeGreaterThan(4);
    expect(luneCheck(files)).toEqual([]);
  });
});

describe('scout CLI', () => {
  it('is a tool command, not an agent prompt', () => {
    expect(TOOL_COMMANDS.has('scout')).toBe(true);
  });
  it('maps flags', () => {
    expect(cliArgs('scout', parseFlags(['lava', 'obby', '--kind', 'map', '--max', '5']))).toEqual({ tool: 'scout', args: { action: 'search', need: 'lava obby', kind: 'map', max: 5 } });
    expect(cliArgs('scout', parseFlags(['try', '123', '--id', 'obby']))).toEqual({ tool: 'scout', args: { action: 'try', asset_id: '123', id: 'obby' } });
    expect(cliArgs('scout', parseFlags(['adopt', 'obby', '--to', 'StarterGui', '--unpack']))).toEqual({ tool: 'scout', args: { action: 'adopt', id: 'obby', to: 'StarterGui', unpack: true } });
    expect(cliArgs('scout', parseFlags(['discard', 'obby']))).toEqual({ tool: 'scout', args: { action: 'discard', id: 'obby' } });
    expect(cliArgs('scout', parseFlags(['import', 'https://kenney.nl/ui.zip', '--id', 'ui', '--licence', 'cc0', '--source-url', 'https://kenney.nl', '--pick', 'coin.png']))).toEqual({ tool: 'scout', args: { action: 'import', url: 'https://kenney.nl/ui.zip', id: 'ui', licence: 'cc0', source_url: 'https://kenney.nl', pick: 'coin.png' } });
    expect(cliArgs('scout', parseFlags(['import', 'dl/trees.rbxm', '--id', 't', '--licence', 'cc-by']))).toEqual({ tool: 'scout', args: { action: 'import', file: 'dl/trees.rbxm', id: 't', licence: 'cc-by' } });
    expect(cliArgs('scout', parseFlags(['park', '--kind', 'model', '--sources', 'store']))).toEqual({ tool: 'scout', args: { action: 'search', need: 'park', kind: 'model', sources: ['store'] } });
  });
});

describe('unzipTo', () => {
  it('unpacks deflated entries and skips paths that escape the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-unzip-'));
    const r = unzipTo(makeZip({ 'a/b.png': 'hello', '../evil.txt': 'x' }), join(dir, 'out'));
    expect(r.files).toEqual([join('a', 'b.png')]);
    expect(r.skipped[0]).toMatch(/evil\.txt \(outside/);
    expect(readFileSync(join(dir, 'out', 'a', 'b.png'), 'utf8')).toBe('hello');
    expect(() => unzipTo(Buffer.from('not a zip at all, definitely not'), dir)).toThrow(/not a zip/);
  });
});
