import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BloxConfigSchema } from '../src/config.js';
import type { ToolCtx } from '../src/tools/registry.js';
import type { StudioSession } from '../src/studio/session.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { verifyModelProgram } from '../src/anim/studio.js';

let probe: (code: string) => unknown = () => ({});
vi.mock('../src/studio/play.js', async (orig) => ({ ...(await orig<typeof import('../src/studio/play.js')>()), withPlay: async (_s: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock('../src/studio/luau.js', async (orig) => {
  const real = await orig<typeof import('../src/studio/luau.js')>();
  return { ...real, runLuau: async (s: StudioSession, code: string, context: string, o: unknown) => (context === 'server' ? { ok: true, values: [probe(code)], logs: [], durationMs: 1 } : real.runLuau(s, code, context as 'edit', o as object)) };
});
const { findTool, invokeTool } = await import('../src/tools/registry.js');

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(): ToolCtx {
  const session = { call: async () => envelope({ ok: true, path: 'Workspace.Guard', walkSpeed: 4 }) } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-vmodel-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const walkSamples = (id: string, pace: number) => [
  ...Array.from({ length: 30 }, (_u, i) => ({ t: i / 10, phase: 'moving', speed: 4, playing: id, pace })),
  ...Array.from({ length: 10 }, (_u, i) => ({ t: 3 + i / 10, phase: 'standing', speed: 0, playing: 'rbxassetid://1' })),
];

describe('verify a model', () => {
  it('passes when the loader walks at the needed pace and idles standing', async () => {
    const c = ctx();
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Walk')!), locomotion: true }, c);
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Idle')!) }, c);
    await call({ action: 'wire', model: 'Workspace.Guard', state: 'walk', name: 'Walk', asset: 2 }, c);
    await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Idle', asset: 1 }, c);
    const { loadReport } = await import('../src/anim/store.js');
    const gs = loadReport(c.projectPath, 'Walk')!.groundSpeed!;
    probe = () => ({ ok: true, rigType: 'R15', loader: { ids: { walk: 'rbxassetid://2', idle: 'rbxassetid://1' }, speeds: { walk: gs } }, observation: { mode: 'walked', reached: true, samples: walkSamples('rbxassetid://2', Math.min(2, Math.max(0.5, 4 / gs))) } });
    const r = await call({ action: 'verify', model: 'Workspace.Guard' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/✓ walk while moving/);
  });
  it('an anchored root is named, not a vague movement failure', async () => {
    const c = ctx();
    probe = () => ({ ok: false, error: 'Workspace.Guard\'s root part is anchored, so it cannot walk' });
    const r = await call({ action: 'verify', model: 'Workspace.Guard' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/anchored/);
  });
  it('the probe payload is a Luau literal with no HttpService', () => {
    const code = verifyModelProgram({ model: 'Workspace.Guard', sequence: null, animationId: null, target: null });
    expect(code).not.toMatch(/HttpService/);
    expect(code).toMatch(/^local P = \{/);
  });
});
