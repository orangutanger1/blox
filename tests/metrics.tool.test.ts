import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { readJson, writeJson } from '../src/state/store.js';
import { botProgram } from '../src/metrics/run.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';

const env = (values: unknown[]) => JSON.stringify({ ok: true, n: values.length, values: Object.fromEntries(values.map((v, i) => [`v${i + 1}`, v])), logs: [] });

function ctx(dump: unknown | null, seen: string[] = []): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-metrics-'));
  const f = fakeStudio({
    luau: (code) => {
      seen.push(code);
      if (code.includes('BloxTelemetry') && code.includes('"dump"')) return env(dump === null ? [] : [JSON.stringify(dump)]);
      if (code.includes('GetPlayers()')) return env([1]);
      if (code.includes('LocalPlayer')) return env([true]);
      return env([]);
    },
    // The bot runs as an injected server Script created via multi_edit.
    tools: { multi_edit: (a) => { seen.push(String((a.edits as { new_string: string }[])[0].new_string)); return 'Created'; } },
  });
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('metrics')!, { sync: false, ...args }, c);
const DESIGN = {
  version: 1,
  meta: { title: 'T', format: 'incremental' },
  ftue: [{ id: 'first-step', text: 'a', targetSec: 5 }, { id: 'open-wall1', text: 'b', targetSec: 60 }],
  economy: { resources: [{ id: 'cash' }], actions: [{ id: 'c', yields: { cash: 1 }, perSec: 1 }] },
  archetypes: [{ id: 'a', session: { lengthSec: 900, perDay: 1 }, policy: 'roi' }],
};

describe('metrics tool', () => {
  it('ftue: runs a playtest, evaluates the design steps, writes the report and binds criteria', async () => {
    const seen: string[] = [];
    const c = ctx({ elapsed: 30, players: { '1': { joinedAt: 0, steps: { 'first-step': 1.5, 'auto:first-currency': 2 } } }, events: [], samples: [] }, seen);
    writeJson(c.projectPath, 'design.json', DESIGN);
    writeJson(c.projectPath, 'task.json', { goal: 'g', criteria: [{ id: 'onboard', text: 'x', status: 'pending', tests: ['ftue:first-step'] }] });
    const r = await call({ action: 'ftue', seconds: 0 }, c);
    expect(r.isError).toBe(true); // open-wall1 never reached
    expect(r.text).toMatch(/✓ ftue:first-step/);
    expect(r.text).toMatch(/✗ ftue:open-wall1/);
    expect(seen.some((s) => s.includes('__bot'))).toBe(true); // default walk bot launched
    expect(readJson<{ results: unknown[] }>(c.projectPath, 'metrics-report.json')!.results).toHaveLength(3);
    expect(readJson<{ criteria: { status: string }[] }>(c.projectPath, 'task.json')!.criteria[0].status).toBe('pass');
  });
  it('missing telemetry explains how to install it', async () => {
    const r = await call({ action: 'ftue', seconds: 0, bot: 'idle' }, ctx(null));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/BloxTelemetry not running/);
  });
  it('soak with a clean, flat-memory dump passes', async () => {
    const samples = [0, 5, 10, 15, 20, 25, 30, 35].map((t) => ({ t, memMb: 300, stats: [] }));
    const r = await call({ action: 'soak', seconds: 0, bot: 'idle' }, ctx({ elapsed: 40, players: { '1': { joinedAt: 0, steps: [] } }, events: [], samples }));
    expect(r.text).toMatch(/✓ soak:errors/);
    expect(r.text).toMatch(/✓ soak:memory/);
    expect(r.isError).toBeFalsy();
  });
  it('install writes BloxTelemetry once', async () => {
    const c = ctx(null);
    expect((await call({ action: 'install' }, c)).text).toMatch(/Telemetry\.start\(\)/);
    expect(existsSync(join(c.projectPath, 'src/ReplicatedStorage/BloxTelemetry.luau'))).toBe(true);
    expect((await call({ action: 'install' }, c)).text).toMatch(/already/);
  });
  it('cli mapping', () => {
    expect(cliArgs('metrics', parseFlags(['soak', '--seconds', '120', '--bot', 'bots/active.luau', '--archetype', 'bot']))).toEqual({
      tool: 'metrics',
      args: { action: 'soak', seconds: 120, bot: 'bots/active.luau', archetype: 'bot' },
    });
    expect(cliArgs('metrics', parseFlags([]))).toEqual({ tool: 'metrics', args: { action: 'ftue' } });
  });
});

describe('botProgram', () => {
  it('inlines a project bot file and passes player + deadline', () => {
    const p = mkdtempSync(join(tmpdir(), 'blox-bot-'));
    mkdirSync(join(p, 'bots'));
    writeFileSync(join(p, 'bots/b.luau'), 'return function(player, deadline) print("hi") end\n');
    const code = botProgram(p, 'bots/b.luau', 30);
    expect(code).toContain('print("hi")');
    expect(code).toContain('os.clock() + 30');
    expect(() => botProgram(p, 'bots/missing.luau', 30)).toThrow(/bot file not found/);
    expect(botProgram(p, 'walk', 10)).toContain('MoveTo');
    expect(readFileSync(join(p, 'bots/b.luau'), 'utf8')).toBeTruthy();
  });
});

describe('metrics report keeps the other mode', () => {
  it('soak after ftue keeps the ftue results', async () => {
    const c = ctx({ elapsed: 40, players: { '1': { joinedAt: 0, steps: { 'auto:first-currency': 1 } } }, events: [], samples: [0, 5, 10, 15, 20, 25, 30, 35].map((t) => ({ t, memMb: 300, stats: [] })) });
    await call({ action: 'ftue', seconds: 0, bot: 'idle' }, c);
    await call({ action: 'soak', seconds: 0, bot: 'idle' }, c);
    const ids = readJson<{ results: { id: string }[] }>(c.projectPath, 'metrics-report.json')!.results.map((r) => r.id);
    expect(ids).toContain('ftue:auto:first-currency');
    expect(ids).toContain('soak:errors');
  });
});
