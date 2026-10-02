import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatCheck, runCheck } from '../src/check.js';
import type { SpawnFn, SpawnResult } from '../src/sync/rojo.js';

type Call = { cmd: string; args: string[] };

function fakeSpawn(answers: (c: Call) => SpawnResult | undefined) {
  const calls: Call[] = [];
  const spawn: SpawnFn = async (cmd, args) => {
    const c = { cmd, args };
    calls.push(c);
    if (args[0] === '--version') return answers(c) ?? { code: 0, stdout: `${cmd} 1.0`, stderr: '' };
    return answers(c) ?? { code: 0, stdout: '', stderr: '' };
  };
  return { spawn, calls };
}

function project(stylua = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'blox-check-'));
  writeFileSync(join(dir, 'default.project.json'), '{}');
  mkdirSync(join(dir, 'src'));
  if (stylua) writeFileSync(join(dir, '.stylua.toml'), 'indent_type = "Tabs"\n');
  return dir;
}

const types = async () => '/cache/globalTypes.d.luau';

describe('runCheck', () => {
  it('runs format, sourcemap, analyze, build in order and passes', async () => {
    const { spawn, calls } = fakeSpawn(() => undefined);
    const r = await runCheck(project(), { spawn, types });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => [s.name, s.status])).toEqual([
      ['format', 'pass'],
      ['sourcemap', 'pass'],
      ['analyze', 'pass'],
      ['build', 'pass'],
    ]);
    const work = calls.filter((c) => c.args[0] !== '--version');
    expect(work[0]).toMatchObject({ cmd: 'stylua', args: expect.arrayContaining(['--check', 'src']) });
    expect(work[1].args.slice(0, 2)).toEqual(['sourcemap', 'default.project.json']);
    const analyze = work[2];
    expect(analyze.cmd).toBe('luau-lsp');
    expect(analyze.args).toContain('--definitions=/cache/globalTypes.d.luau');
    expect(analyze.args).toContain('--ignore=**/_Index/**');
    expect(analyze.args.at(-1)).toBe('src');
    expect(work[3].args[0]).toBe('build');
  });

  it('fix formats instead of checking', async () => {
    const { spawn, calls } = fakeSpawn(() => undefined);
    await runCheck(project(), { spawn, types, fix: true });
    const fmt = calls.find((c) => c.cmd === 'stylua' && c.args[0] !== '--version')!;
    expect(fmt.args).not.toContain('--check');
  });

  it('skips format without a stylua config and skips missing tools, still ok', async () => {
    const { spawn } = fakeSpawn((c) => (c.cmd === 'luau-lsp' && c.args[0] === '--version' ? { code: 127, stdout: '', stderr: 'not found' } : undefined));
    const r = await runCheck(project(false), { spawn, types });
    expect(r.steps.find((s) => s.name === 'format')!.status).toBe('skip');
    const an = r.steps.find((s) => s.name === 'analyze')!;
    expect(an.status).toBe('skip');
    expect(an.detail).toMatch(/luau-lsp/);
    expect(r.ok).toBe(true);
  });

  it('analyze errors fail the check with the diagnostics, counted', async () => {
    const out = 'src/ServerScriptService/A.luau(3,5): TypeError: Unknown global \'foo\'\nsrc/B.luau(1,1): SyntaxError: Expected identifier\n';
    const { spawn } = fakeSpawn((c) => (c.cmd === 'luau-lsp' && c.args[0] === 'analyze' ? { code: 1, stdout: '', stderr: out } : undefined));
    const r = await runCheck(project(), { spawn, types });
    expect(r.ok).toBe(false);
    const an = r.steps.find((s) => s.name === 'analyze')!;
    expect(an.status).toBe('fail');
    expect(an.detail).toMatch(/2 error/);
    expect(an.detail).toMatch(/Unknown global 'foo'/);
    expect(formatCheck(r)).toMatch(/FAIL analyze/);
  });

  it('a failed sourcemap skips analyze (it needs the sourcemap)', async () => {
    const { spawn } = fakeSpawn((c) => (c.cmd === 'rojo' && c.args[0] === 'sourcemap' ? { code: 1, stdout: '', stderr: 'bad project' } : undefined));
    const r = await runCheck(project(), { spawn, types });
    expect(r.steps.find((s) => s.name === 'sourcemap')!.status).toBe('fail');
    expect(r.steps.find((s) => s.name === 'analyze')!.status).toBe('skip');
    expect(r.ok).toBe(false);
  });

  it('no type definitions → analyze skipped with the reason', async () => {
    const { spawn } = fakeSpawn(() => undefined);
    const r = await runCheck(project(), { spawn, types: async () => { throw new Error('offline'); } });
    const an = r.steps.find((s) => s.name === 'analyze')!;
    expect(an.status).toBe('skip');
    expect(an.detail).toMatch(/offline/);
  });
});
