import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { readJson, writeJson } from '../src/state/store.js';
import { cliArgs, parseFlags, runToolCommand } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';

function ctx(): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-reltool-'));
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => fakeStudio().client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
const call = (tool: string, args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool(tool)!, args, c);
const design = () => JSON.parse(readFileSync(new URL('../docs/examples/design/steal-tycoon.json', import.meta.url), 'utf8'));

describe('release tool', () => {
  it('check reports gates and human gates; publish refuses when not ready; approve is CLI-only', async () => {
    const c = ctx();
    const r = await call('release', { action: 'check' }, c);
    expect(r.text).toMatch(/NOT READY/);
    expect(r.text).toMatch(/human gates/);
    expect(readJson(c.projectPath, 'release-report.json')).toBeTruthy();
    const p = await call('release', { action: 'publish', confirm: true }, c);
    expect(p.isError).toBe(true);
    expect(p.text).toMatch(/not ready to publish/);
    expect((await call('release', { action: 'approve' }, c)).isError).toBe(true);
  });
  it('cli', async () => {
    expect(cliArgs('release', parseFlags(['publish', '--confirm']))).toEqual({ tool: 'release', args: { action: 'publish', confirm: true } });
    expect(cliArgs('release', parseFlags([]))).toEqual({ tool: 'release', args: { action: 'check' } });
    const c = ctx();
    const errs: string[] = [];
    const orig = console.error;
    console.error = (s: string) => errs.push(s);
    try {
      await runToolCommand(['release', 'approve', '--project', c.projectPath]);
    } finally {
      console.error = orig;
      process.exitCode = 0;
    }
    expect(errs.join()).toMatch(/no build to approve/);
  });
});

describe('liveops tool', () => {
  it('report from an export → propose → apply updates design + Tunables', async () => {
    const c = ctx();
    writeJson(c.projectPath, 'design.json', design());
    writeFileSync(join(c.projectPath, 'analytics.json'), JSON.stringify({ retention: { d1: 0.06 }, funnel: [{ step: 1, name: 'core-verb', users: 1000 }, { step: 2, name: 'first-egg', users: 300 }] }));
    const rep = await call('liveops', { action: 'report', from: 'analytics.json' }, c);
    expect(rep.text).toMatch(/70% of players drop before onboarding step "first-egg"/);
    const pr = await call('liveops', { action: 'propose' }, c);
    expect(pr.text, pr.text).toMatch(/^\s+\S+-\d+:/m);
    const id = /^\s+(\S+-\d+):/m.exec(pr.text)![1];
    const ap = await call('liveops', { action: 'apply', proposal: id }, c);
    expect(ap.isError).toBeFalsy();
    expect(readFileSync(join(c.projectPath, 'src/ReplicatedStorage/Design/Tunables.luau'), 'utf8')).toMatch(/^-- GENERATED/);
    expect(readJson<{ applied?: string }>(c.projectPath, `proposals/${id}.json`)!.applied).toBeTruthy();
    expect((await call('liveops', { action: 'apply', proposal: id }, c)).text).toMatch(/already applied/);
  });
  it('report without export or key explains both routes', async () => {
    const old = process.env.ROBLOX_OPEN_CLOUD_KEY;
    delete process.env.ROBLOX_OPEN_CLOUD_KEY;
    const r = await call('liveops', { action: 'report' }, ctx());
    if (old) process.env.ROBLOX_OPEN_CLOUD_KEY = old;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/from/);
  });
  it('push config is a dry run without confirm and refuses monetization keys', async () => {
    const c = ctx();
    const d = design();
    d.tunables = { ...d.tunables, eggPriceRobux: 49 };
    writeJson(c.projectPath, 'design.json', d);
    const r = await call('liveops', { action: 'push', kind: 'config' }, c);
    expect(r.text).toMatch(/DRY RUN/);
    expect(r.text).toMatch(/shieldSec/);
    expect(r.text).toMatch(/skipped \(monetization, human\): eggPriceRobux/);
  });
  it('cli', () => {
    expect(cliArgs('liveops', parseFlags(['report', '--from', 'a.json']))).toEqual({ tool: 'liveops', args: { action: 'report', from: 'a.json' } });
    expect(cliArgs('liveops', parseFlags(['apply', 'p-1']))).toEqual({ tool: 'liveops', args: { action: 'apply', proposal: 'p-1' } });
    expect(cliArgs('liveops', parseFlags(['push', 'config', '--confirm']))).toEqual({ tool: 'liveops', args: { action: 'push', kind: 'config', confirm: true } });
  });
});
