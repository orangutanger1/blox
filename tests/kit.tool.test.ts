import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { applyKit, listKits } from '../src/kits.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';

function ctx(): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-kittool-'));
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => { throw new Error('studio must not be touched'); }, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
const call = (name: string, args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool(name)!, args, c);

describe('kits', () => {
  it('lists the incremental kit', () => {
    expect(listKits().map((k) => k.name)).toContain('incremental');
  });
  it('apply scaffolds, copies files, writes design + Tunables; second apply keeps everything', () => {
    const c = ctx();
    const r = applyKit(c.projectPath, 'incremental');
    expect(r.created).toContain('src/ReplicatedStorage/Kit/Economy.luau');
    expect(r.created).toContain('default.project.json');
    expect(r.designWritten).toBe(true);
    expect(existsSync(join(c.projectPath, '.blox/design.json'))).toBe(true);
    expect(readFileSync(join(c.projectPath, 'src/ReplicatedStorage/Design/Tunables.luau'), 'utf8')).toMatch(/^-- GENERATED/);
    const again = applyKit(c.projectPath, 'incremental');
    expect(again.created).toEqual([]);
    expect(again.kept).toContain('src/ReplicatedStorage/Kit/Economy.luau');
    expect(again.designWritten).toBe(false);
  });
  it('keeps edited files and an existing design (Tunables follow the project design)', () => {
    const c = ctx();
    applyKit(c.projectPath, 'incremental');
    const econ = join(c.projectPath, 'src/ReplicatedStorage/Kit/Economy.luau');
    writeFileSync(econ, '-- mine\n');
    const d = JSON.parse(readFileSync(join(c.projectPath, '.blox/design.json'), 'utf8'));
    d.meta.title = 'My Speed Game';
    writeFileSync(join(c.projectPath, '.blox/design.json'), JSON.stringify(d));
    applyKit(c.projectPath, 'incremental');
    expect(readFileSync(econ, 'utf8')).toBe('-- mine\n');
    expect(readFileSync(join(c.projectPath, 'src/ReplicatedStorage/Design/Tunables.luau'), 'utf8')).toMatch(/My Speed Game/);
  });
  it('unknown kit is an error naming the available kits', async () => {
    const r = await call('kit', { action: 'apply', name: 'nope' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown kit "nope".*incremental/);
  });
  it('tool list + apply', async () => {
    const c = ctx();
    expect((await call('kit', { action: 'list' }, c)).text).toMatch(/incremental/);
    const r = await call('kit', { action: 'apply', name: 'incremental' }, c);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/Next:/);
    expect(r.text).toMatch(/design \{action:"simulate"\}/);
  });
  it('cli mapping', () => {
    expect(cliArgs('kit', parseFlags([]))).toEqual({ tool: 'kit', args: { action: 'list' } });
    expect(cliArgs('kit', parseFlags(['apply', 'incremental']))).toEqual({ tool: 'kit', args: { action: 'apply', name: 'incremental' } });
  });
});
