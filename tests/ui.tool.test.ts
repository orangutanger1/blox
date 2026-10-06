import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { readJson, withSyntheticResults } from '../src/state/store.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';

const env = (values: unknown[]) => JSON.stringify({ ok: true, n: values.length, values: Object.fromEntries(values.map((v, i) => [`v${i + 1}`, v])), logs: [] });

// The probe asks for one device page at a time: answer with up to `pageSize`
// elements from SKIP and the next index while more remain.
export function probePage(code: string, devices: Record<string, unknown[]>, pageSize = Infinity): string {
  const device = /"name":"([^"]+)"/.exec(code)![1];
  const skip = Number(/local SKIP = (\d+)/.exec(code)![1]);
  const all = devices[device] ?? [];
  const elements = all.slice(skip, skip + pageSize);
  return JSON.stringify({ sources: 1, device, elements, ...(skip + elements.length < all.length ? { next: skip + elements.length } : {}) });
}

function ctx(devices: Record<string, unknown[]>, seen: string[] = [], pageSize = Infinity): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-ui-'));
  const f = fakeStudio({
    luau: (code, dm) => {
      seen.push(`${dm}:${code}`);
      if (code.includes('__BloxUiLint')) return env([probePage(code, devices, pageSize)]);
      if (code.includes('GetLogHistory') && code.includes('probe-client')) return '1/1:{"ok":true,"values":[]}';
      if (code.includes('GetPlayers()')) return env([1]);
      if (code.includes('LocalPlayer')) return env([true]);
      return env([]);
    },
    tools: {
      multi_edit: (a) => {
        seen.push(`Edit:${JSON.stringify(a)}`);
        return 'ok';
      },
    },
  });
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
// Sync needs rojo + a project file; only the sync tests exercise it.
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('ui')!, { sync: false, ...args }, c);
const hasRojo = (() => { try { execFileSync(process.env.BLOX_ROJO_BIN ?? 'rojo', ['--version']); return true; } catch { return false; } })();
const btn = (o: Record<string, unknown>) => ({ path: 'HUD.B', cls: 'TextButton', x: 100, y: 100, w: 60, h: 60, button: true, ...o });

describe('ui tool', () => {
  it('lint: runs the probe on the client, lints each device, writes the report, binds ui:<rule>', async () => {
    const seen: string[] = [];
    const c = ctx({ 'phone-landscape': [btn({ w: 30 })], desktop: [btn({})] }, seen);
    const r = await call({ action: 'lint', seconds: 0, devices: ['phone-landscape', 'desktop'], prepare: 'game.Players.LocalPlayer.PlayerGui.HUD.Shop.Visible = true' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/✗ ui:touch-target/);
    expect(seen.findIndex((s) => s.includes('Shop.Visible'))).toBeLessThan(seen.findIndex((s) => s.includes('__BloxUiLint')));
    expect(seen.find((s) => s.includes('__BloxUiLint'))!.startsWith('Client:')).toBe(true);
    expect(readJson<{ findings: unknown[] }>(c.projectPath, 'ui-report.json')!.findings).toHaveLength(1);
    expect(withSyntheticResults(c.projectPath, null)!.tests.find((t) => t.name === 'ui:touch-target')!.status).toBe('fail');
  });
  it('lint: prepare runs as an injected client probe, so it sees the game (require, shared)', async () => {
    const seen: string[] = [];
    const c = ctx({ desktop: [btn({})] }, seen);
    const r = await call({ action: 'lint', seconds: 0, devices: ['desktop'], prepare: 'shared.BloxControllers.UIController:Open("Menu")' }, c);
    expect(r.text).not.toMatch(/prepare failed/);
    const install = seen.findIndex((s) => s.startsWith('Edit:') && s.includes('BloxProbeHost') && s.includes('UIController:Open'));
    const go = seen.findIndex((s) => s.startsWith('Client:') && s.includes('BloxGo'));
    const probe = seen.findIndex((s) => s.includes('__BloxUiLint'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(go).toBeGreaterThan(install);
    expect(probe).toBeGreaterThan(go);
    expect(seen.some((s) => s.startsWith('Client:') && s.includes('UIController:Open') && !s.includes('BloxProbeHost'))).toBe(false);
  });
  it('clean GUI passes', async () => {
    const r = await call({ action: 'lint', seconds: 0 }, ctx({ 'phone-landscape': [btn({})], 'phone-portrait': [btn({})], tablet: [btn({})], desktop: [btn({})] }));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/6\/6 rules pass/);
  });
  it('no GUI at all is a note, not a pass of nothing', async () => {
    const r = await call({ action: 'lint', seconds: 0 }, ctx({}));
    expect(r.text).toMatch(/no visible GUI elements/);
  });
  it('pages large GUIs: one device per call, resuming at next', async () => {
    const seen: string[] = [];
    const many = Array.from({ length: 7 }, (_, i) => btn({ path: `HUD.B${i}`, y: 10 + i * 50 }));
    const c = ctx({ desktop: many }, seen, 3);
    await call({ action: 'lint', seconds: 0, devices: ['desktop'] }, c);
    const probes = seen.filter((s) => s.includes('__BloxUiLint'));
    expect(probes.map((p) => Number(/local SKIP = (\d+)/.exec(p)![1]))).toEqual([0, 3, 6]);
    expect(readJson<{ elements: Record<string, number> }>(c.projectPath, 'ui-report.json')!.elements).toEqual({ desktop: 7 });
  });
  it.skipIf(!hasRojo)('syncs before linting (Edit mode)', async () => {
    const c = ctx({ desktop: [btn({})] });
    writeFileSync(join(c.projectPath, 'default.project.json'), JSON.stringify({ name: 't', tree: { $className: 'DataModel' } }));
    const r = await call({ action: 'lint', seconds: 0, devices: ['desktop'], sync: true }, c);
    expect(r.text.split('\n')[0]).toMatch(/sync/i);
    expect(readJson(c.projectPath, 'last-sync.json')).not.toBeNull();
  });
  it('sync:false skips the push', async () => {
    const c = ctx({ desktop: [btn({})] });
    const r = await call({ action: 'lint', seconds: 0, devices: ['desktop'], sync: false }, c);
    expect(r.isError).toBeFalsy();
    expect(readJson(c.projectPath, 'last-sync.json')).toBeNull();
  });
  it('unknown device is rejected', async () => {
    const r = await call({ action: 'lint', devices: ['fridge'] }, ctx({}));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown device "fridge"/);
  });
  it('install writes BloxUI', async () => {
    const c = ctx({});
    const r = await call({ action: 'install' }, c);
    expect(r.text).toMatch(/BloxUI/);
    expect(existsSync(join(c.projectPath, 'src/ReplicatedStorage/BloxUI/init.luau'))).toBe(true);
  });
  it('cli mapping', () => {
    expect(cliArgs('ui', parseFlags(['lint', '--devices', 'tablet,desktop', '--seconds', '5']))).toEqual({ tool: 'ui', args: { action: 'lint', devices: ['tablet', 'desktop'], seconds: 5 } });
    expect(cliArgs('ui', parseFlags([]))).toEqual({ tool: 'ui', args: { action: 'lint' } });
    expect(cliArgs('ui', parseFlags(['lint', '--no-sync']))).toEqual({ tool: 'ui', args: { action: 'lint', sync: false } });
  });
});
