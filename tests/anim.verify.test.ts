import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { loadChecked } from '../src/anim/store.js';
import { buildTracks, sampleTrack } from '../src/anim/motion.js';
import { rigFor } from '../src/anim/rigs.js';
import { applyWire } from '../src/anim/wire.js';
import type { StudioSession } from '../src/studio/session.js';

const play = vi.hoisted(() => ({ stopped: 0 }));
vi.mock('../src/studio/play.js', async (orig) => ({
  ...(await orig<typeof import('../src/studio/play.js')>()),
  withPlay: async <T,>(_s: unknown, fn: (i: unknown) => Promise<T>) => { try { return await fn({ alreadyRunning: false }); } finally { play.stopped++; } },
}));

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-animv-'));
  const session = { evalBridge: false, call: async (_n: string, args: Record<string, unknown>) => { const r = reply(String(args.code)); if (r instanceof Error) throw r; return envelope(r); } } as unknown as StudioSession;
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
function live(c: ToolCtx) {
  const seq = loadChecked(c.projectPath, 'Wave')!.sequence;
  const tracks = buildTracks(seq);
  return [0.1, 0.3, 0.5].map((time) => ({ time, transforms: Object.fromEntries(rigFor('R15').joints.map((j) => { const f = sampleTrack(tracks.get(j.childPart), time); return [j.childPart, [...f.p, ...f.r]]; })) }));
}

describe('animate verify', () => {
  it('needs a prior check', async () => {
    const r = await call({ action: 'verify', name: 'Wave' }, ctx(() => ({})));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/animate check first/);
  });

  it('plays on the character, compares, confirms the slot and writes verify.json', async () => {
    let c!: ToolCtx;
    c = ctx(() => ({ ok: true, rigType: 'R15', length: 1, samples: live(c), wiredIds: ['rbxassetid://55'] }));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    applyWire(c.projectPath, { idle: 'rbxassetid://55' }, true);
    const r = await call({ action: 'verify', name: 'Wave', slot: 'idle' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/slot idle holds rbxassetid:\/\/55/);
  });

  it('flags a character on the other rig and a slot that does not hold the id', async () => {
    let c!: ToolCtx;
    c = ctx(() => ({ ok: true, rigType: 'R6', length: 1, samples: live(c), wiredIds: ['rbxassetid://1'] }));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    applyWire(c.projectPath, { idle: 'rbxassetid://55' }, true);
    const r = await call({ action: 'verify', name: 'Wave', slot: 'idle' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/R6/);
  });

  it('stops play and reports the error when the probe throws', async () => {
    const before = play.stopped;
    const c = ctx((code) => (code.includes('LocalPlayer') ? new Error('probe exploded') : {}));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    const r = await call({ action: 'verify', name: 'Wave' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/probe exploded/);
    expect(play.stopped).toBe(before + 1);
  });
});
