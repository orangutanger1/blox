import { cliArgs, parseFlags } from '../src/cliTools.js';
import { writeFileSync as wf } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadRecipes } from '../src/anim/recipes.js';
import type { StudioSession } from '../src/studio/session.js';

export function ctx(session: Partial<StudioSession> = {}): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-anim-'));
  return { session: session as StudioSession, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const walk = () => structuredClone(loadRecipes().get('Walk')!);

describe('animate recipes/check', () => {
  it('lists recipes and returns one', async () => {
    const c = ctx();
    expect((await call({ action: 'recipes' }, c)).text).toMatch(/Walk.*WaveR6|WaveR6.*Walk/s);
    const one = await call({ action: 'recipes', name: 'Walk' }, c);
    expect(JSON.parse(one.text).name).toBe('Walk');
    expect((await call({ action: 'recipes', name: 'Nope' }, c)).isError).toBe(true);
  });

  it('check compiles, reports checks, writes the files and returns the sheet image', async () => {
    const c = ctx();
    const r = await call({ action: 'check', animation: walk(), locomotion: true, grounded: true }, c);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/footSliding/);
    expect(r.images?.[0].mimeType).toBe('image/png');
    for (const f of ['spec.json', 'sequence.json', 'report.json', 'sheet.png']) expect(existsSync(join(c.projectPath, '.blox/anims/Walk', f))).toBe(true);
  });

  it('check reports every compile error at once', async () => {
    const r = await call({ action: 'check', animation: { name: 'Bad', rig: 'R15', keyframes: [{ time: 0, joints: { NoSuchJoint: {} } }, { time: -1, joints: {} }] } }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text.split('\n').filter((l) => l.startsWith('  ')).length).toBeGreaterThanOrEqual(2);
  });

  it('a failed check is listed with its measurement; waiving it records the waiver', async () => {
    const c = ctx();
    const jump = structuredClone(loadRecipes().get('Jump')!);
    const r = await call({ action: 'check', animation: jump, grounded: true }, c);
    expect(r.text).toMatch(/groundContact.*fail|fail.*groundContact/s);
    const w = await call({ action: 'check', animation: jump, grounded: true, waive: ['groundContact'] }, c);
    expect(w.text).toMatch(/waived: groundContact/);
  });

  it('refuses names that are not plain identifiers before writing anything', async () => {
    for (const name of ['../x', 'a b', 'x"]']) {
      const c = ctx();
      const r = await call({ action: 'check', animation: { ...walk(), name } }, c);
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/name/);
      expect(existsSync(join(c.projectPath, '.blox/anims'))).toBe(false);
    }
  });
});

describe('animate wire (tool)', () => {
  it('refuses an R6 animation for an R15-only place, and syncs after writing', async () => {
    const calls: string[] = [];
    const session = {
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push(name);
        const code = String(args.code ?? '');
        const v = code.includes('GameSettingsAvatar') ? 'R15' : '{}';
        return { content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] }) }] };
      },
    } as unknown as StudioSession;
    const c = ctx(session);
    const bad = await call({ action: 'wire', slot: 'walk', asset: 1, rig: 'R6' }, c);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/R15/);
  });
});

describe('animate cli', () => {
  it('maps subcommands', () => {
    expect(cliArgs('animate', parseFlags(['recipes', 'Walk']))).toEqual({ tool: 'animate', args: { action: 'recipes', name: 'Walk' } });
    expect(cliArgs('animate', parseFlags(['build', 'Walk', '--force']))).toEqual({ tool: 'animate', args: { action: 'build', name: 'Walk', force: true } });
    expect(cliArgs('animate', parseFlags(['wire', 'walk', '123', '--replaces', '9']))).toEqual({ tool: 'animate', args: { action: 'wire', slot: 'walk', asset: '123', replaces: '9' } });
    expect(cliArgs('animate', parseFlags(['verify', 'Walk', '--slot', 'walk']))).toEqual({ tool: 'animate', args: { action: 'verify', name: 'Walk', slot: 'walk' } });
  });
  it('check reads the description from a JSON file', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-animcli-')), 'walk.json');
    wf(f, JSON.stringify({ name: 'Walk', rig: 'R15' }));
    expect(cliArgs('animate', parseFlags(['check', f, '--locomotion', '--waive', 'groundContact,footSliding']))).toEqual({ tool: 'animate', args: { action: 'check', animation: { name: 'Walk', rig: 'R15' }, locomotion: true, waive: ['groundContact', 'footSliding'] } });
  });
});
