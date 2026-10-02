import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { substitute, parseAgentStats, collectAgentStats, formatBenchMarkdown, loadTasks, pickRunTasks, prepareWorkdir, type BenchReport } from '../src/bench/harness.js';
import { agentSpec } from '../src/bench/cli.js';

describe('bench helpers', () => {
  it('substitutes placeholders per argv element (no shell quoting issues)', () => {
    expect(substitute(['x', '{prompt}', '--p', '{project}/a'], { prompt: 'say "hi"; rm -rf /', project: '/w' }))
      .toEqual(['x', 'say "hi"; rm -rf /', '--p', '/w/a']);
  });
  it('parses blox runner and claude -p stats', () => {
    expect(parseAgentStats('blox run — success\nturns: 12  cost: $0.4567\n')).toEqual({ turns: 12, costUsd: 0.4567 });
    expect(parseAgentStats('{"type":"result","total_cost_usd":1.5,"num_turns":9}')).toEqual({ costUsd: 1.5, turns: 9 });
    expect(parseAgentStats('nothing')).toEqual({});
  });
  it('builds agent profiles', () => {
    expect(agentSpec('blox', {}).argv).toContain('{prompt}');
    expect(() => agentSpec('legacy', {})).toThrow(/--legacy-cli/);
    expect(agentSpec('claude-code', { model: 'm' }).argv).toEqual(expect.arrayContaining(['claude', '-p', '--model', 'm']));
  });
  it('formats a markdown report with totals and failures', () => {
    const r: BenchReport = {
      label: 'x', agent: 'a', startedAt: 's', finishedAt: 'f', environment: {},
      runs: [
        { task: 't1', level: '1', attempt: 1, agentExit: 0, timedOut: false, durationSec: 10, pass: true, workdir: '/w', notes: [], live: { passed: 2, total: 2, failures: [] }, synced: { passed: 2, total: 2, failures: [] } },
        { task: 't2', level: '2', attempt: 1, agentExit: 1, timedOut: false, durationSec: 20, pass: false, workdir: '/w', notes: ['n'], live: { passed: 0, total: 1, failures: ['c: fail'] } },
      ],
    };
    const md = formatBenchMarkdown(r);
    expect(md).toContain('**1/2 tasks fully passing (live)** · live checks 2/3 · synced checks 2/2');
    expect(md).toContain('c: fail');
  });
});

describe('task loading + workdir prep', () => {
  it('layers seed/solution over a neutral scaffold in its own git repo', () => {
    const root = mkdtempSync(join(tmpdir(), 'blox-bench-'));
    const t = join(root, 'tasks', 'tA');
    mkdirSync(join(t, 'seed', 'src', 'ServerScriptService'), { recursive: true });
    mkdirSync(join(t, 'solution', 'src', 'ServerScriptService'), { recursive: true });
    mkdirSync(join(t, 'checks'));
    writeFileSync(join(t, 'task.json'), JSON.stringify({ id: 'tA', level: '1', title: 'x', prompt: 'p' }));
    writeFileSync(join(t, 'seed', 'src', 'ServerScriptService', 'A.server.luau'), 'seed');
    writeFileSync(join(t, 'solution', 'src', 'ServerScriptService', 'B.server.luau'), 'sol');
    const [task] = loadTasks(root);
    expect(task.id).toBe('tA');
    const wd = join(root, 'wd');
    prepareWorkdir(task, wd, 'seed');
    expect(existsSync(join(wd, 'src', 'ServerScriptService', 'A.server.luau'))).toBe(true);
    expect(existsSync(join(wd, 'src', 'ServerScriptService', 'B.server.luau'))).toBe(false);
    expect(existsSync(join(wd, 'AGENTS.md'))).toBe(false);
    const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: wd, encoding: 'utf8' }).stdout.trim();
    expect(top.endsWith('wd')).toBe(true);
    prepareWorkdir(task, wd, 'solution');
    expect(existsSync(join(wd, 'src', 'ServerScriptService', 'B.server.luau'))).toBe(true);
  });
  it('agent runs default to the core suite; "all" or ids widen it', () => {
    const root = mkdtempSync(join(tmpdir(), 'blox-bench-pick-'));
    for (const [id, core] of [['tA', true], ['tB', false], ['tC', true]] as const) {
      mkdirSync(join(root, 'tasks', id), { recursive: true });
      writeFileSync(join(root, 'tasks', id, 'task.json'), JSON.stringify({ id, level: '1', title: id, prompt: 'p', core }));
    }
    expect(pickRunTasks(root).map((t) => t.id)).toEqual(['tA', 'tC']);
    expect(pickRunTasks(root, ['all']).map((t) => t.id)).toEqual(['tA', 'tB', 'tC']);
    expect(pickRunTasks(root, ['tB']).map((t) => t.id)).toEqual(['tB']);
  });
});

describe('agent stats (agent-agnostic)', () => {
  it('parses the blox runner report incl. model and tokens', () => {
    const s = parseAgentStats('turns: 12  cost: $0.4567\nmodel: claude-opus-5-5\ntokens: input=100 cache_read=2000 cache_write=300 output=40\n');
    expect(s).toEqual({ turns: 12, costUsd: 0.4567, model: 'claude-opus-5-5', tokens: { input: 100, cacheRead: 2000, cacheWrite: 300, output: 40 } });
  });
  it('parses claude -p json usage + modelUsage', () => {
    const s = parseAgentStats(JSON.stringify({ total_cost_usd: 1.2, num_turns: 9, usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 }, modelUsage: { 'm-1': {} } }));
    expect(s).toEqual({ costUsd: 1.2, turns: 9, model: 'm-1', tokens: { input: 5, cacheRead: 7, cacheWrite: 8, output: 6 } });
  });
  it('stats file wins and derives cost from tokens when the agent reports none', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-stats-')), 's.json');
    writeFileSync(f, JSON.stringify({ turns: 3, model: 'x-model', tokens: { input: 1_000_000, output: 1_000_000 } }));
    const s = collectAgentStats('unparseable output', f, { 'x-model': { in: 1, out: 2 } });
    expect(s).toEqual({ turns: 3, model: 'x-model', tokens: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }, costUsd: 3 });
  });
  it('unknown model with tokens leaves cost unset (no guessing)', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-stats-')), 's.json');
    writeFileSync(f, JSON.stringify({ model: 'gpt-x', tokens: { input: 10, output: 10 } }));
    expect(collectAgentStats('', f, {}).costUsd).toBeUndefined();
  });
});
