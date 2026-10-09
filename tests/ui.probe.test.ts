import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiProbeProgram, parseProbePage } from '../src/ui/probe.js';
import { DEVICES } from '../src/ui/lint.js';
import { luneBin, luneCheck } from './helpers/lune.js';

describe('ui probe', () => {
  it('embeds one device, the resume index and the budget, and returns JSON', () => {
    const code = uiProbeProgram(DEVICES[0], 40, 5000);
    expect(code).toContain('phone-landscape');
    expect(code).not.toContain('desktop');
    expect(code).toMatch(/local SKIP = 40\n/);
    expect(code).toMatch(/local BUDGET = 5000\n/);
    expect(code).toContain('return HttpService:JSONEncode');
  });
  it('a non-interactable GuiButton (art inside a hit area) is not a touch target', () => {
    expect(uiProbeProgram(DEVICES[0])).toContain('button = o:IsA("GuiButton") and o.Interactable');
  });
  it('reports which elements draw something and the DisplayOrder layer of their ScreenGui', () => {
    const src = uiProbeProgram(DEVICES[0]);
    expect(src).toMatch(/e\.surface = /);
    expect(src).toMatch(/BackgroundTransparency < 0\.9/);
    expect(src).toMatch(/ViewportFrame/);
    expect(src).toMatch(/e\.layer = /);
    expect(src).toMatch(/e\.z = widget\.ZIndex/);
  });
  it('re-applies BloxUI.fit scales per device (scripts are stripped from the clones)', () => {
    const code = uiProbeProgram(DEVICES[0]);
    expect(code).toContain('s:GetAttribute("BloxFitHeight")');
    expect(code).toContain('s.Parent.Size = UDim2.fromScale(1 / k, 1 / k)');
  });
  it('skips Roblox-injected GUIs (legacy chat etc.)', () => {
    expect(uiProbeProgram(DEVICES[0])).toMatch(/ENGINE_GUIS = \{ Chat = true/);
  });
  it.skipIf(!luneBin())('generated program compiles', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-probe-')), 'probe.luau');
    writeFileSync(f, uiProbeProgram(DEVICES[3], 10));
    expect(luneCheck([f])).toEqual([]);
  });
  it('parseProbePage: empty encodes as {}, missing next is the last page', () => {
    expect(parseProbePage(JSON.stringify({ sources: 2, device: 'desktop', elements: {} }))).toEqual({ sources: 2, device: 'desktop', elements: [], next: null });
    expect(parseProbePage(JSON.stringify({ sources: 1, device: 'tablet', elements: [{ path: 'A' }], next: 1 })).next).toBe(1);
    expect(() => parseProbePage(undefined)).toThrow(/no data/);
  });
});
