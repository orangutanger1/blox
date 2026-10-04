import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatPreview, showPanelLuau, stagePanelsLuau } from '../src/assets/preview.js';
import { addAsset } from '../src/assets/manifest.js';
import { StudioSession } from '../src/studio/session.js';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';
import { luneBin, luneCheck } from './helpers/lune.js';

const env = (values: unknown[]) => JSON.stringify({ ok: true, n: values.length, values: Object.fromEntries(values.map((v, i) => [`v${i + 1}`, v])), logs: [] });
const PNG = Buffer.from('fake-png').toString('base64');

const panels = [
  { i: 1, name: 'ShopFrame', path: 'ServerStorage.BloxScout.pack.UI.ShopFrame', cls: 'ImageLabel', size: '{0, 0}, {0, 0}', visible: false, descendants: 30, hidden: 4 },
  { i: 2, name: 'Settings', path: 'ServerStorage.BloxScout.pack.UI.Settings', cls: 'Frame', size: '{0.5, 0}, {0.5, 0}', visible: true, descendants: 12, hidden: 0 },
];

function ctx(seen: { dm: string; code: string }[], shots = true): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-preview-'));
  addAsset(projectPath, { id: 'pack', kind: 'model', source: 'creator-store', licence: 'roblox-creator-store', ref: { assetId: 1, path: 'ServerStorage.BloxScout.pack' }, provenance: { tool: 'scout', createdAt: 'x' } });
  const f = fakeStudio({
    luau: (code, dm) => {
      if (code.includes('BLOX_LOCATE')) return env([JSON.stringify({ result: [] })]);
      seen.push({ dm, code });
      if (code.includes('GetPlayers()')) return env([1]);
      if (code.includes('local WANT')) return env([JSON.stringify({ panels, total: 3 })]);
      if (code.includes('__BloxUiLint')) {
        // panel 2's close button is 28px on phones; panel 1 fits
        const small = seen.filter((s) => s.code.includes('local sized')).length === 2;
        const els = [{ path: '__BloxPreviewGui.Frame.P1', cls: 'Frame', x: 20, y: 60, w: 300, h: 200, button: false }, ...(small ? [{ path: '__BloxPreviewGui.Frame.P2.Close', cls: 'ImageButton', x: 280, y: 70, w: 28, h: 28, button: true }] : [])];
        return env([JSON.stringify({ sources: 1, device: 'x', elements: els, next: null })]);
      }
      if (code.includes('__BloxPreviewGui')) return env([JSON.stringify({ sized: code.includes('"P1"'), scaled: 1 })]);
      if (code.includes('LocalPlayer')) return env([true]);
      return env([]);
    },
    tools: { screen_capture: () => (shots ? { content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] } : { content: [{ type: 'text', text: 'no' }] }) },
  });
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}

describe('scout preview', () => {
  it('stage Luau: resolves the path, strips scripts, honours the panel filter and cap', () => {
    const code = stagePanelsLuau('ServerStorage.BloxScout.pack', ['Shop'], 4);
    expect(code).toContain('ServerStorage.BloxScout.pack');
    expect(code).toContain('"Shop"');
    expect(code).toContain('local MAX = 4');
    expect(code).toContain('LuaSourceContainer');
    expect(code).not.toContain('table.unpack'); // big packs overflow unpack
  });
  it('stage Luau: descends into invisible full-screen / zero-size wrapper Frames, names panels by path', () => {
    const code = stagePanelsLuau('ReplicatedStorage.cartoonGui');
    expect(code).toMatch(/local function isWrapper\(d\)/);
    expect(code).toContain('BackgroundTransparency < 0.95');
    expect(code).toContain('sz.X.Scale >= 0.9 and sz.Y.Scale >= 0.9');
    expect(code).toMatch(/want\[d\.Name\] or want\[rn\]/); // filter by name or path
  });
  it('show Luau: hides the game GUI, centres the clone, sizes zero-size panels', () => {
    const code = showPanelLuau(3, false);
    expect(code).toContain('WaitForChild("P3"');
    expect(code).toContain('g.Enabled = false');
    expect(code).toContain('UDim2.fromScale(0.6, 0.6)');
    expect(code).not.toContain('d.Visible = true');
    expect(showPanelLuau(1, true)).toContain('d.Visible = true');
  });
  it.skipIf(!luneBin())('generated programs compile', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-preview-luau-'));
    writeFileSync(join(dir, 'a.luau'), stagePanelsLuau('StarterGui.Pack', ['A']));
    writeFileSync(join(dir, 'b.luau'), showPanelLuau(1, true));
    expect(luneCheck([join(dir, 'a.luau'), join(dir, 'b.luau')])).toEqual([]);
  });
  it('tool: stages on the server, shows each panel on the client, returns a screenshot per panel, stops play', async () => {
    const seen: { dm: string; code: string }[] = [];
    const c = ctx(seen);
    const r = await invokeTool(findTool('scout')!, { action: 'preview', id: 'pack' }, c);
    expect(r.isError).toBeFalsy();
    expect(seen.find((s) => s.code.includes('local WANT'))!.dm).toBe('Server');
    expect(seen.filter((s) => s.code.includes('local sized')).map((s) => s.dm)).toEqual(['Client', 'Client']);
    expect(seen.filter((s) => s.code.includes('__BloxUiLint')).map((s) => s.dm)).toEqual(['Client', 'Client', 'Client', 'Client']);
    expect(r.text).toMatch(/\[1\] ShopFrame[^\n]*\n\s+phone: fits/);
    expect(r.text).toMatch(/phone-landscape: touch-target ×1 \(Close: button 28×28px, needs >= 44px\)/);
    expect(r.text).toMatch(/budget the fixes/);
    expect(r.images).toHaveLength(2);
    expect(r.artifacts!.every((p) => existsSync(join(c.projectPath, p)))).toBe(true);
    expect(r.text).toMatch(/3 panel\(s\) under ServerStorage\.BloxScout\.pack, showing 2/);
    expect(r.text).toMatch(/ShopFrame .*was hidden; had no size/);
    expect(r.text).toMatch(/4\/30 inner element\(s\) hidden/);
    expect(seen.some((s) => s.code.includes('__BloxPreview") if f then f:Destroy()'))).toBe(true);
  });
  it('tool: no screenshots at all is an error', async () => {
    const r = await invokeTool(findTool('scout')!, { action: 'preview', id: 'pack' }, ctx([], false));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/screen_capture returned no image/);
  });
  it('tool: unknown id without a path is refused', async () => {
    const r = await invokeTool(findTool('scout')!, { action: 'preview', id: 'nope' }, ctx([]));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no asset "nope"/);
  });
  it('format: no panels explains what a panel is', () => {
    expect(formatPreview('x', 'StarterGui.X', { total: 0, shots: [] })).toMatch(/no GUI panels under StarterGui\.X/);
  });
  it('cli', () => {
    expect(cliArgs('scout', parseFlags(['preview', 'pack', '--panels', 'Shop,Settings', '--show-all']))).toEqual({ tool: 'scout', args: { action: 'preview', id: 'pack', panels: ['Shop', 'Settings'], show_all: true } });
    expect(cliArgs('scout', parseFlags(['preview', 'StarterGui.Pack', '--max', '3']))).toEqual({ tool: 'scout', args: { action: 'preview', path: 'StarterGui.Pack', max: 3 } });
    expect(cliArgs('scout', parseFlags(['preview', 'pack', '--no-phone']))).toEqual({ tool: 'scout', args: { action: 'preview', id: 'pack', phone: false } });
  });
});
