import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BloxConfigSchema } from '../src/config.js';
import type { ToolCtx } from '../src/tools/registry.js';
import type { StudioSession } from '../src/studio/session.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { buildProgram } from '../src/anim/studio.js';
import { MODEL_LOADER_SOURCE } from '../src/anim/npc.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { kneeDeclarations, partsDog } from './fixtures/anim/parts-dog.js';

// Follow-ups to the spec-B review's deferred minors.

let probe: (code: string) => unknown = () => ({});
const probes: string[] = [];
vi.mock('../src/studio/play.js', async (orig) => ({ ...(await orig<typeof import('../src/studio/play.js')>()), withPlay: async (_s: unknown, fn: () => Promise<unknown>) => fn() }));
vi.mock('../src/studio/luau.js', async (orig) => {
  const real = await orig<typeof import('../src/studio/luau.js')>();
  return { ...real, runLuau: async (s: StudioSession, code: string, context: string, o: unknown) => (context === 'server' ? (probes.push(code), { ok: true, values: [probe(code)], logs: [], durationMs: 1 }) : real.runLuau(s, code, context as 'edit', o as object)) };
});
vi.mock('../src/sync/push.js', async (orig) => ({
  ...(await orig<typeof import('../src/sync/push.js')>()),
  pushProject: async () => ({ ok: true, created: [], updated: [], deleted: [], unchanged: 0, builders: [], skipped: [], errors: [], conflicts: [], studioEdits: [], durationMs: 0 }),
}));
const { findTool, invokeTool } = await import('../src/tools/registry.js');

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code ?? '')); return envelope(reply(String(a.code ?? ''))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-minors-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const dog = (path = 'Workspace.Dog', tweak = 0) => { const { revision: _r, ...rest } = partsDog({ knees: true, declarations: kneeDeclarations() }); const d = { ...rest, path }; if (tweak) d.joints[1].c0[1] += tweak; return d; };
const WAG = { name: 'TailWag', rig: 'Workspace.Dog', loop: true, priority: 'Idle', duration: 1, waves: [{ joints: ['Tail'], axis: 'Y', amplitude: 20, cycles: 2 }] };
const isWire = (code: string) => code.includes('BloxAnimWire');

describe('wire: a copy of a wired model', () => {
  it('passes any id blox wired for that state, so a duplicate needs no force', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (isWire(code) ? (!code.includes('Dog2') ? { ok: true, path: 'Workspace.Dog' } : code.includes('"allowed":["rbxassetid://5"]') ? { ok: true, path: 'Workspace.Dog2' } : { ok: false, code: 'held', held: 'rbxassetid://5', error: 'held' }) : { ok: true, reading: dog() }), codes);
    await call({ action: 'check', animation: WAG }, c);
    await call({ action: 'wire', model: 'Workspace.Dog', state: 'idle', name: 'TailWag', asset: 5 }, c);
    const r = await call({ action: 'wire', model: 'Workspace.Dog2', state: 'idle', name: 'TailWag', asset: 6 }, c);
    expect(r.isError, r.text).toBeFalsy();
  });
});

describe('verify a model: guards', () => {
  it('a missing rig.json is a named error before any playtest', async () => {
    probes.length = 0;
    const c = ctx(() => ({ ok: true, reading: dog() }));
    await call({ action: 'check', animation: WAG }, c);
    rmSync(join(c.projectPath, '.blox/anims/TailWag/rig.json'));
    const r = await call({ action: 'verify', model: 'Workspace.Dog', name: 'TailWag' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/check it again/);
    expect(r.text).not.toMatch(/tool_error/);
    expect(probes).toEqual([]);
  });
  it('a model-rig animation on a different rig is refused before any playtest', async () => {
    probes.length = 0;
    let tweak = 0;
    const c = ctx(() => ({ ok: true, reading: dog('Workspace.Dog', tweak) }));
    await call({ action: 'check', animation: WAG }, c);
    tweak = 0.3;
    const r = await call({ action: 'verify', model: 'Workspace.Dog', name: 'TailWag' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not the rig TailWag was checked on/);
    expect(probes).toEqual([]);
  });
  it('a stock animation on a model of the other rig type is named', async () => {
    const c = ctx(() => ({}));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Idle')!) }, c);
    probe = () => ({ ok: true, rigType: 'R6', loader: { ids: {}, speeds: {} }, length: 1, samples: [] , skipped: 'nothing wired' });
    const r = await call({ action: 'verify', model: 'Workspace.Guard', name: 'Idle' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Workspace.Guard is R6; Idle is an R15 animation/);
  });
  it('asset plays the uploaded id instead of a temporary clip', async () => {
    probes.length = 0;
    const c = ctx(() => ({}));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Idle')!) }, c);
    probe = () => ({ ok: false, error: 'stop here' });
    await call({ action: 'verify', model: 'Workspace.Guard', name: 'Idle', asset: 107530817330770 }, c);
    expect(probes[0]).toMatch(/\["animationId"\] = "rbxassetid:\/\/107530817330770"/);
    expect(probes[0]).not.toMatch(/\["keyframes"\]/);
  });
  it('slot with model is refused', async () => {
    const r = await call({ action: 'verify', model: 'Workspace.Guard', slot: 'walk' }, ctx(() => ({})));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/slot is for the player's character/);
  });
});

describe('check: rig names', () => {
  it('a rig that is neither R15/R6 nor a model path is refused without Studio', async () => {
    const codes: string[] = [];
    const r = await call({ action: 'check', animation: { ...WAG, rig: 'r15' } }, ctx(() => ({}), codes));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/R15, R6, or a model path/);
    expect(codes).toEqual([]);
  });
});

describe('Luau details', () => {
  it('build finds the copy\'s root among the rig\'s jointed parts, not any same-named part', () => {
    const seq = { name: 'X', rig: 'Workspace.Dog', loop: true, duration: 1, priority: 'Idle', keyframes: [] } as never;
    expect(buildProgram(seq, [0], { path: 'Workspace.Dog', rootPart: 'HumanoidRootPart' })).not.toMatch(/FindFirstChild\(P\.model\.rootPart, true\)/);
  });
  it('the loader destroys a detached model\'s tracks', () => {
    const detach = MODEL_LOADER_SOURCE.slice(MODEL_LOADER_SOURCE.indexOf('local function detach'), MODEL_LOADER_SOURCE.indexOf('local function choose'));
    expect(detach).toMatch(/track:Destroy\(\)/);
  });
});

describe('CLI declare', () => {
  it('a declarations file that is not JSON is a named error', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-decl-')), 'd.json');
    writeFileSync(f, '{nope');
    expect(() => cliArgs('animate', parseFlags(['declare', 'Workspace.Dog', '--declarations', f]))).toThrow(/--declarations .*d\.json is not valid JSON/);
  });
});
