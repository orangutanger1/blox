import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { readJson, withSyntheticResults, writeJson } from '../src/state/store.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';

function ctx(): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-design-'));
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => { throw new Error('studio must not be touched'); }, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
const call = (name: string, args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool(name)!, args, c);
const DOC = {
  version: 1,
  meta: { title: 'T', format: 'incremental' },
  economy: { resources: [{ id: 'cash' }], actions: [{ id: 'c', yields: { cash: 1 }, perSec: 1 }], generators: [{ id: 'g', produces: { cash: 1 }, cost: { res: 'cash', base: 10, growth: 1.2 } }] },
  archetypes: [{ id: 'active', session: { lengthSec: 900, perDay: 2 }, policy: 'roi' }],
  assertions: [
    { id: 'first-g', archetype: 'active', metric: 'timeTo', target: 'generator:g', op: '<=', value: 15 },
    { id: 'tenth-g', archetype: 'active', metric: 'timeTo', target: 'generator:g:10', op: '<=', value: 5 },
  ],
};

describe('design tool', () => {
  it('example is a valid doc that simulates with every assertion passing, and a failed set shows it', async () => {
    const c = ctx();
    const ex = await call('design', { action: 'example' }, c);
    const doc = JSON.parse(ex.text.split('\n')[0]);
    expect((await call('design', { action: 'set', doc }, c)).isError).toBeFalsy();
    const sim = await call('design', { action: 'simulate', runs: 5 }, c);
    expect(sim.isError, sim.text).toBeFalsy();
    const bad = await call('design', { action: 'set', doc: { version: 1, meta: { name: 'x' } } }, c);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/A valid doc to copy shapes from:\n\{"version":1/);
    expect((await call('design', { action: 'get' }, ctx())).text).toMatch(/design \{action:"example"\}/);
  });

  it('set → validate → simulate → codegen, without Studio', async () => {
    const c = ctx();
    expect((await call('design', { action: 'set', doc: DOC }, c)).isError).toBeFalsy();
    expect((await call('design', { action: 'validate' }, c)).text).toMatch(/valid/);
    const sim = await call('design', { action: 'simulate', runs: 3 }, c);
    expect(sim.isError).toBe(true); // tenth-g fails
    expect(sim.text).toMatch(/✓ first-g/);
    expect(sim.text).toMatch(/✗ tenth-g/);
    expect(readJson<{ assertions: unknown[] }>(c.projectPath, 'sim-report.json')!.assertions).toHaveLength(2);
    const cg = await call('design', { action: 'codegen' }, c);
    expect(cg.text).toMatch(/Tunables\.luau/);
    expect(readFileSync(join(c.projectPath, 'src/ReplicatedStorage/Design/Tunables.luau'), 'utf8')).toMatch(/^-- GENERATED/);
  });
  it('invalid set writes nothing and lists errors', async () => {
    const c = ctx();
    const r = await call('design', { action: 'set', doc: { ...DOC, version: 2 } }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/version/);
    expect(existsSync(join(c.projectPath, '.blox/design.json'))).toBe(false);
  });
  it('missing design gives a hint', async () => {
    const r = await call('design', { action: 'simulate' }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/design \{action:"set"/);
  });
  it('unknown archetype filter is a readable error', async () => {
    const c = ctx();
    await call('design', { action: 'set', doc: DOC }, c);
    const r = await call('design', { action: 'simulate', archetypes: ['nope'] }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown archetype "nope"/);
  });
  it('task criteria bound to design:<id> follow the last sim', async () => {
    const c = ctx();
    await call('design', { action: 'set', doc: DOC }, c);
    await call('task', { action: 'set', goal: 'g', criteria: [{ id: 'pace', text: 'first g fast', tests: ['design:first-g'] }, { id: 'late', text: 'x', tests: ['design:tenth-g'] }] }, c);
    await call('design', { action: 'simulate', runs: 2 }, c);
    const t = await call('task', { action: 'get' }, c);
    expect(t.text).toMatch(/pace/);
    const saved = readJson<{ criteria: { id: string; status: string }[] }>(c.projectPath, 'task.json')!;
    expect(saved.criteria.map((x) => [x.id, x.status])).toEqual([['pace', 'pass'], ['late', 'fail']]);
  });
});

describe('withSyntheticResults', () => {
  it('appends sim assertions as synthetic tests', () => {
    const c = ctx();
    writeJson(c.projectPath, 'sim-report.json', { ranAt: 'x', assertions: [{ id: 'a', ok: true }, { id: 'b', ok: false }] });
    const r = withSyntheticResults(c.projectPath, { ranAt: 'y', tests: [{ file: 'f', name: 'n', status: 'pass' }] })!;
    expect(r.tests).toEqual([
      { file: 'f', name: 'n', status: 'pass' },
      { file: 'design', name: 'design:a', status: 'pass' },
      { file: 'design', name: 'design:b', status: 'fail' },
    ]);
    expect(withSyntheticResults(ctx().projectPath, null)).toBeNull();
  });
});

describe('cli mapping', () => {
  it('maps design subcommands', () => {
    expect(cliArgs('design', parseFlags([]))).toEqual({ tool: 'design', args: { action: 'get' } });
    expect(cliArgs('design', parseFlags(['set', '{"version":1}']))).toEqual({ tool: 'design', args: { action: 'set', doc: { version: 1 } } });
    expect(cliArgs('design', parseFlags(['simulate', '--runs', '5', '--horizon', '604800', '--archetypes', 'a,b']))).toEqual({
      tool: 'design',
      args: { action: 'simulate', runs: 5, horizon: 604800, archetypes: ['a', 'b'] },
    });
  });
  it('malformed set json throws (cli reports "bad arguments")', () => {
    expect(() => cliArgs('design', parseFlags(['set', '{nope']))).toThrow();
  });
});
