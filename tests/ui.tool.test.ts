import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { readJson, withSyntheticResults } from '../src/state/store.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';

const env = (values: unknown[]) => JSON.stringify({ ok: true, n: values.length, values: Object.fromEntries(values.map((v, i) => [`v${i + 1}`, v])), logs: [] });

function ctx(devices: Record<string, unknown[]>, seen: string[] = []): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-ui-'));
  const f = fakeStudio({
    luau: (code, dm) => {
      seen.push(`${dm}:${code}`);
      if (code.includes('__BloxUiLint')) return env([JSON.stringify({ sources: 1, devices })]);
      if (code.includes('GetPlayers()')) return env([1]);
      if (code.includes('LocalPlayer')) return env([true]);
      return env([]);
    },
  });
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('ui')!, args, c);
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
  it('clean GUI passes', async () => {
    const r = await call({ action: 'lint', seconds: 0 }, ctx({ 'phone-landscape': [btn({})], 'phone-portrait': [btn({})], tablet: [btn({})], desktop: [btn({})] }));
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/6\/6 rules pass/);
  });
  it('no GUI at all is a note, not a pass of nothing', async () => {
    const r = await call({ action: 'lint', seconds: 0 }, ctx({}));
    expect(r.text).toMatch(/no visible GUI elements/);
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
  });
});
