import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSheet, setSheetImage, sheetModule, writeSheet } from '../src/assets/sheet.js';
import { decodePngRgba } from '../src/present/pixels.js';
import { encodePng } from '../src/present/square.js';
import { loadManifest } from '../src/assets/manifest.js';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { StudioSession } from '../src/studio/session.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';
import { luneBin, luneCheck } from './helpers/lune.js';

function solid(w: number, h: number, rgba: [number, number, number, number]): Buffer {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set(rgba, i * 4);
  return encodePng(w, h, px);
}
function project(): string {
  const P = mkdtempSync(join(tmpdir(), 'blox-sheet-'));
  mkdirSync(join(P, 'icons'));
  writeFileSync(join(P, 'icons', 'coin.png'), solid(64, 64, [255, 200, 0, 255]));
  writeFileSync(join(P, 'icons', 'star.png'), solid(256, 128, [255, 255, 255, 128]));
  writeFileSync(join(P, 'icons', 'notes.txt'), 'x');
  writeFileSync(join(P, 'default.project.json'), JSON.stringify({ name: 'g', tree: { $className: 'DataModel', ReplicatedStorage: { $path: 'src/shared' } } }));
  return P;
}
const px = (img: { w: number; rgba: Uint8Array }, x: number, y: number) => Array.from(img.rgba.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4));

describe('icon sheet', () => {
  it('packs icons into a grid, keeps alpha, scales big icons into the cell', () => {
    const P = project();
    const s = buildSheet(P, ['icons/coin.png', 'icons/star.png'], 128, 2);
    expect([s.w, s.h]).toEqual([256, 128]);
    expect(s.icons).toEqual({ coin: [0, 0], star: [128, 0] });
    const img = decodePngRgba(s.png)!;
    expect(px(img, 64, 64)).toEqual([255, 200, 0, 255]); // coin centred, native size
    expect(px(img, 1, 1)[3]).toBe(0); // padding stays transparent
    expect(px(img, 192, 64)).toEqual([255, 255, 255, 128]); // star scaled to 124×62, alpha kept
    expect(px(img, 192, 20)[3]).toBe(0); // letterboxed above the wide star
  });
  it('refuses duplicate names and sheets past 1024px', () => {
    const P = project();
    mkdirSync(join(P, 'more'));
    writeFileSync(join(P, 'more', 'coin.png'), solid(8, 8, [0, 0, 0, 255]));
    expect(() => buildSheet(P, ['icons/coin.png', 'more/coin.png'])).toThrow(/two icons are named "coin"/);
    expect(() => buildSheet(P, ['a', 'b', 'c', 'd', 'e'].map((n) => `icons/${n}.png`), 512)).toThrow(/do not fit in 1024×1024/);
  });
  it('writes PNG, sidecar and module under the ReplicatedStorage dir; upload sets the id', () => {
    const P = project();
    const r = writeSheet(P, { id: 'hudIcons', files: ['icons'] });
    expect(r.files).toEqual(['icons/coin.png', 'icons/star.png']);
    expect(r.map.module).toBe('src/shared/Sheets/hudIcons.luau');
    const mod = readFileSync(join(P, r.map.module), 'utf8');
    expect(mod).toContain('Sheet.image = "rbxassetid://0" -- not uploaded yet');
    expect(mod).toContain('["star"] = Vector2.new(128, 0),');
    expect(setSheetImage(P, 'hudIcons', 'assets/ui/hudIcons.png', 87029758011762)).toBe('src/shared/Sheets/hudIcons.luau');
    expect(readFileSync(join(P, r.map.module), 'utf8')).toContain('Sheet.image = "rbxassetid://87029758011762"\n');
    expect(setSheetImage(P, 'other', 'assets/ui/other.png', 1)).toBeNull();
  });
  it('tool records a candidate image entry and re-running resets it', async () => {
    const P = project();
    const f = fakeStudio({});
    const c: ToolCtx = { session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }), projectPath: P, config: BloxConfigSchema.parse({ projectPath: P }), agent: 'test' };
    const call = (args: Record<string, unknown>) => invokeTool(findTool('asset')!, args, c);
    expect((await call({ action: 'sheet', id: 'hud', files: ['icons'] })).isError).toBe(true);
    const r = await call({ action: 'sheet', id: 'hud', files: ['icons'], licence: 'cc0', attribution: 'Kenney', source_url: 'https://kenney.nl' });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/Sheet\.apply\(imageLabel, "coin"\)/);
    expect(loadManifest(P).assets[0]).toMatchObject({ id: 'hud', kind: 'image', source: 'external', licence: 'cc0', status: 'candidate', ref: { file: 'assets/ui/hud.png' }, provenance: { tool: 'sheet' } });
    const m = JSON.parse(readFileSync(join(P, '.blox/assets.json'), 'utf8'));
    Object.assign(m.assets[0], { status: 'approved', uploaded: { assetId: 5, imageId: 6, operation: 'o', at: 'x' } });
    writeFileSync(join(P, '.blox/assets.json'), JSON.stringify(m));
    await call({ action: 'sheet', id: 'hud', files: ['icons/coin.png'], licence: 'cc0' });
    const e = loadManifest(P).assets[0];
    expect(e.status).toBe('candidate');
    expect(e.uploaded).toBeUndefined();
    expect((await call({ action: 'sheet', id: 'hud', files: ['../x.png'], licence: 'cc0' })).text).toMatch(/outside the project/);
  });
  it('re-running with identical icons keeps the approval, upload and module image id', async () => {
    const P = project();
    const f = fakeStudio({});
    const c: ToolCtx = { session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }), projectPath: P, config: BloxConfigSchema.parse({ projectPath: P }), agent: 'test' };
    const call = (args: Record<string, unknown>) => invokeTool(findTool('asset')!, args, c);
    await call({ action: 'sheet', id: 'hud', files: ['icons'], licence: 'owned' });
    const m = JSON.parse(readFileSync(join(P, '.blox/assets.json'), 'utf8'));
    Object.assign(m.assets[0], { status: 'approved', ref: { file: 'assets/ui/hud.png', assetId: 6 }, uploaded: { assetId: 5, imageId: 6, operation: 'o', at: 'x' } });
    writeFileSync(join(P, '.blox/assets.json'), JSON.stringify(m));
    setSheetImage(P, 'hud', 'assets/ui/hud.png', 6);
    const r = await call({ action: 'sheet', id: 'hud', files: ['icons'], licence: 'owned' });
    expect(r.text).toMatch(/unchanged/);
    const e = loadManifest(P).assets[0];
    expect(e.status).toBe('approved');
    expect(e.uploaded?.imageId).toBe(6);
    expect(readFileSync(join(P, 'src/shared/Sheets/hud.luau'), 'utf8')).toContain('Sheet.image = "rbxassetid://6"\n');
    expect(cliArgs('asset', parseFlags(['sheet', 'hud', 'icons', 'more/a.png', '--licence', 'cc0', '--cell', '64']))).toEqual({ tool: 'asset', args: { action: 'sheet', id: 'hud', files: ['icons', 'more/a.png'], licence: 'cc0', cell: 64 } });
  });
  it.skipIf(!luneBin())('module compiles', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-sheet-luau-'));
    writeFileSync(join(d, 'm.luau'), sheetModule('x', { image: 'a.png', module: 'm.luau', cell: 64, icons: { 'coin-gold': [0, 0], b: [64, 0] } }, 5));
    expect(luneCheck([join(d, 'm.luau')])).toEqual([]);
  });
});
