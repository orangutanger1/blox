import { describe, expect, it, vi } from 'vitest';

// A temp project has no Rojo tree to sync: the loader push is stubbed ok.
vi.mock('../src/sync/push.js', async (orig) => ({
  ...(await orig<typeof import('../src/sync/push.js')>()),
  pushProject: async () => ({ ok: true, created: [], updated: [], deleted: [], unchanged: 0, builders: [], skipped: [], errors: [], conflicts: [], studioEdits: [], durationMs: 0 }),
}));
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { MODEL_LOADER_PATH, readWired } from '../src/anim/npc.js';
import { kneeDeclarations, partsDog } from './fixtures/anim/parts-dog.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code ?? '')); return envelope(reply(String(a.code ?? ''))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-wiremodel-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const dog = (path = 'Workspace.Dog') => { const { revision: _r, ...rest } = partsDog({ knees: true, declarations: kneeDeclarations() }); return { ...rest, path }; };
const DOGWALK = { name: 'DogWalk', rig: 'Workspace.Dog', loop: true, priority: 'Movement', duration: 1, gait: { pattern: 'walk', stride: 1.2 } };
const isWrite = (code: string) => code.includes('BloxAnimWire');

describe('wire a model state', () => {
  it('stock NPC: sets the attributes, records wired.json, writes the loader', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (isWrite(code) ? { ok: true, path: 'Workspace.Guard', walkSpeed: 16 } : {}), codes);
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Walk')!), locomotion: true }, c);
    const r = await call({ action: 'wire', model: 'Workspace.Guard', state: 'walk', name: 'Walk', asset: 123 }, c);
    expect(r.isError, r.text).toBeFalsy();
    const w = codes.find(isWrite)!;
    expect(w).toMatch(/"rigType":"R15"/);
    expect(w).toMatch(/"id":"rbxassetid:\/\/123"/);
    expect(w).toMatch(/"speed":\d/);
    expect(readWired(c.projectPath)['Workspace.Guard'].walk).toBe('rbxassetid://123');
    expect(existsSync(join(c.projectPath, MODEL_LOADER_PATH))).toBe(true);
  });
  it('model rig: a clone with the same rig passes; a different rig is refused', async () => {
    const codes: string[] = [];
    let readPath = 'Workspace.Dog';
    let tweak = false;
    const c = ctx((code) => (isWrite(code) ? { ok: true, path: readPath } : (() => { const d = dog(readPath); if (tweak) d.joints[1].c0[1] += 0.3; return { ok: true, reading: d }; })()), codes);
    await call({ action: 'check', animation: DOGWALK, locomotion: true }, c);
    readPath = 'Workspace.Dog2';
    expect((await call({ action: 'wire', model: 'Workspace.Dog2', state: 'walk', name: 'DogWalk', asset: 5 }, c)).isError).toBeFalsy();
    tweak = true;
    const bad = await call({ action: 'wire', model: 'Workspace.Dog2', state: 'walk', name: 'DogWalk', asset: 5 }, c);
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/not the rig DogWalk was checked on/);
  });
  it('walk/run need a looping, locomotion-checked animation', async () => {
    const c = ctx(() => ({ ok: true }));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Walk')!) }, c); // no locomotion
    const r = await call({ action: 'wire', model: 'Workspace.Guard', state: 'walk', name: 'Walk', asset: 1 }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/locomotion:true/);
    await call({ action: 'check', animation: { ...structuredClone(loadRecipes().get('Wave')!), loop: false } }, c);
    const r2 = await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Wave', asset: 1 }, c);
    expect(r2.isError).toBe(true);
    expect(r2.text).toMatch(/loop/);
  });
  it('the attribute guard passes the ids blox wired, and force through', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (isWrite(code) ? (code.includes('"force":true') ? { ok: true, path: 'Workspace.Guard' } : { ok: false, code: 'held', held: 'rbxassetid://999', error: 'Workspace.Guard BloxAnim_idle holds rbxassetid://999' }) : {}), codes);
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Idle')!) }, c);
    const r = await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Idle', asset: 7 }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/holds rbxassetid:\/\/999.*force:true/s);
    const f = await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Idle', asset: 7, force: true }, c);
    expect(f.isError, f.text).toBeFalsy();
    await call({ action: 'wire', model: 'Workspace.Guard', state: 'idle', name: 'Idle', asset: 8, force: true }, c);
    expect(codes.filter(isWrite).at(-1)).toMatch(/"allowed":\["rbxassetid:\/\/7"\]/);
  });
  it('warns when WalkSpeed is outside the pace range', async () => {
    const c = ctx((code) => (isWrite(code) ? { ok: true, path: 'Workspace.Guard', walkSpeed: 100 } : {}));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Walk')!), locomotion: true }, c);
    const r = await call({ action: 'wire', model: 'Workspace.Guard', state: 'walk', name: 'Walk', asset: 1 }, c);
    expect(r.text).toMatch(/WalkSpeed 100 is outside 0\.5–2×/);
  });
  it('slot and model are exclusive', async () => {
    const r = await call({ action: 'wire', model: 'Workspace.Guard', slot: 'walk', state: 'walk', name: 'Walk', asset: 1 }, ctx(() => ({})));
    expect(r.isError).toBe(true);
  });
  it('a model rig with no feet is told to declare them, not to use locomotion:true', async () => {
    const { revision: _r, ...bare } = partsDog({ knees: true });
    const c = ctx(() => ({ ok: true, reading: { ...bare, path: 'Workspace.Dog' } }));
    await call({ action: 'check', animation: { name: 'Sway', rig: 'Workspace.Dog', loop: true, priority: 'Movement', duration: 1, waves: [{ joints: ['Tail'], axis: 'Y', amplitude: 20, cycles: 1 }] }, locomotion: true }, c);
    const r = await call({ action: 'wire', model: 'Workspace.Dog', state: 'walk', name: 'Sway', asset: 1 }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no feet declared/);
    expect(r.text).toMatch(/plan:"quadruped"/);
  });
});
