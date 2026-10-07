import { describe, expect, it } from 'vitest';
import jpeg from 'jpeg-js';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioSession } from '../src/studio/session.js';
import { runUiLintEdit, runUiPreview } from '../src/ui/run.js';
import { fakeStudio } from './fakeStudio.js';

const env = (values: unknown[]) => JSON.stringify({ ok: true, n: values.length, values: Object.fromEntries(values.map((v, i) => [`v${i + 1}`, v])), logs: [] });
const fail = (msg: string) => JSON.stringify({ ok: false, error: { message: msg }, logs: [] });
const tiny = Buffer.from(jpeg.encode({ data: Buffer.alloc(64 * 36 * 4, 120), width: 64, height: 36 }, 80).data).toString('base64');

function session(seen: string[], o: { mountFails?: boolean } = {}) {
  const f = fakeStudio({
    luau: (code) => {
      const kind = code.includes('__BloxUiLint') ? 'probe' : code.includes('local function __mount') ? 'mount' : code.includes('local h = game:GetService("CoreGui")') ? 'unstage' : code.includes('__BloxUiPreview') ? 'preview' : 'other';
      seen.push(kind + (kind === 'mount' && code.includes('Shop.Visible') ? ':shop' : ''));
      if (kind === 'mount') return o.mountFails ? fail('attempt to index nil with Shop') : env([1]);
      if (kind === 'probe') {
        const device = /"name":"([^"]+)"/.exec(code)![1];
        return env([JSON.stringify({ sources: 1, device, elements: [{ path: 'HUD.B', cls: 'TextButton', x: 100, y: 100, w: 30, h: 30, button: true }] })]);
      }
      if (kind === 'preview') return env([JSON.stringify({ vw: 64, vh: 36, x: 8, y: 2, w: 48, h: 32 })]);
      return env(['ok']);
    },
    tools: { screen_capture: () => ({ content: [{ type: 'image', data: tiny, mimeType: 'image/jpeg' }] }) },
  });
  return { s: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }), calls: f.calls };
}

describe('edit-mode ui lint', () => {
  it('mounts per state, probes each device in edit, never starts Play, cleans up last', async () => {
    const seen: string[] = [];
    const { s, calls } = session(seen);
    const r = await runUiLintEdit(s, { mount: 'UI.build(host)', states: [{ name: 'hud' }, { name: 'shop', luau: 'host.HUD.Shop.Visible = true' }], devices: ['phone-portrait', 'desktop'] });
    expect(calls.some((c) => c.name === 'start_stop_play')).toBe(false);
    expect(seen.filter((k) => k.startsWith('mount'))).toEqual(['mount', 'mount:shop']);
    expect(seen.filter((k) => k === 'probe')).toHaveLength(4);
    expect(seen.at(-1)).toBe('unstage');
    expect(r.devices).toEqual(['phone-portrait@hud', 'desktop@hud', 'phone-portrait@shop', 'desktop@shop']);
    expect(r.findings.some((f) => f.device === 'phone-portrait@shop' && f.rule === 'touch-target')).toBe(true);
  });
  it('a failing mount names the state and still cleans up', async () => {
    const seen: string[] = [];
    const { s } = session(seen, { mountFails: true });
    await expect(runUiLintEdit(s, { mount: 'x', states: [{ name: 'shop', luau: 'y' }] })).rejects.toThrow(/state "shop".*Shop/);
    expect(seen.at(-1)).toBe('unstage');
  });
  it('rejects duplicate state names before staging', async () => {
    const seen: string[] = [];
    const { s } = session(seen);
    await expect(runUiLintEdit(s, { states: [{ name: 'a' }, { name: 'a' }] })).rejects.toThrow(/duplicate state/);
    expect(seen).toEqual([]);
  });
});

describe('ui preview', () => {
  it('captures each device per state into one sheet per state', async () => {
    const seen: string[] = [];
    const { s, calls } = session(seen);
    const P = mkdtempSync(join(tmpdir(), 'blox-uiprev-'));
    const r = await runUiPreview(s, P, { states: [{ name: 'hud' }, { name: 'shop', luau: 'host.HUD.Shop.Visible = true' }], devices: ['phone-portrait', 'desktop'] });
    expect(r.sheets.map((x) => x.state)).toEqual(['hud', 'shop']);
    expect(calls.filter((c) => c.name === 'screen_capture')).toHaveLength(4);
    expect(existsSync(join(P, '.blox/ui-preview/shop.jpg'))).toBe(true);
    expect(seen.at(-1)).toBe('unstage');
  });
});
