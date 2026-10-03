import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadRecipes } from '../src/anim/recipes.js';
import { loadChecked } from '../src/anim/store.js';
import { buildTracks, sampleTrack } from '../src/anim/motion.js';
import { previewSampleTimes } from '../src/anim/animation-tool.js';
import { rigFor } from '../src/anim/rigs.js';
import { loadManifest } from '../src/assets/manifest.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });

function fakeSession(reply: (code: string) => unknown, codes: string[] = []) {
  return { call: async (_n: string, args: Record<string, unknown>) => { codes.push(String(args.code)); return envelope(reply(String(args.code))); } } as unknown as StudioSession;
}
function ctx(session: StudioSession): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-animb-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);

// Exact samples of the checked motion: what a faithful Studio playback returns.
function faithful(c: ToolCtx, name: string, skew = 0) {
  const seq = loadChecked(c.projectPath, name)!.sequence;
  const tracks = buildTracks(seq);
  return previewSampleTimes(seq).map((time) => ({
    time,
    transforms: Object.fromEntries(rigFor(seq.rig).joints.map((j) => {
      const f = sampleTrack(tracks.get(j.childPart), time);
      const r = f.r.slice() as number[];
      if (skew) { r[0] = Math.cos(skew); r[1] = -Math.sin(skew); r[3] = Math.sin(skew); r[4] = Math.cos(skew); }
      return [j.childPart, [...f.p, ...r]];
    })),
  }));
}

describe('animate build', () => {
  it('refuses without a prior check, without calling Studio', async () => {
    const codes: string[] = [];
    const r = await call({ action: 'build', name: 'Walk' }, ctx(fakeSession(() => ({}), codes)));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/animate check first/);
    expect(codes).toEqual([]);
  });

  it('refuses while a check fails unwaived', async () => {
    const c = ctx(fakeSession(() => ({})));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Jump')!), grounded: true }, c);
    const r = await call({ action: 'build', name: 'Jump' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/groundContact/);
  });

  it('plays, compares, commits, writes the rbxm and records a candidate', async () => {
    let c!: ToolCtx;
    const codes: string[] = [];
    c = ctx(fakeSession((code) => (code.includes('local WRITE = true') ? { ok: true, written: true } : { ok: true, length: 1, samples: faithful(c, 'Wave') }), codes));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    const r = await call({ action: 'build', name: 'Wave' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(codes.filter((x) => x.includes('local WRITE = true')).length).toBe(1);
    expect(codes.every((x) => !x.includes('"name":"Wave"') || x.includes('local PAYLOAD = '))).toBe(true); // agent data only inside the payload
    expect(existsSync(join(c.projectPath, '.blox/anims/Wave/anim_Wave.rbxm'))).toBe(true);
    const m = loadManifest(c.projectPath).assets.find((x) => x.id === 'Wave');
    expect(m).toMatchObject({ kind: 'animation', status: 'candidate', ref: { file: '.blox/anims/Wave/anim_Wave.rbxm' } });
  });

  it('a playback mismatch writes nothing and names the worst joint', async () => {
    let c!: ToolCtx;
    const codes: string[] = [];
    c = ctx(fakeSession(() => ({ ok: true, length: 1, samples: faithful(c, 'Wave', 0.2) }), codes));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    const r = await call({ action: 'build', name: 'Wave' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/°/);
    expect(codes.some((x) => x.includes('local WRITE = true'))).toBe(false);
  });

  it('reports the rebuild guard refusals', async () => {
    let c!: ToolCtx;
    c = ctx(fakeSession((code) => (code.includes('local WRITE = true') ? { ok: false, code: 'edited', error: 'edited in Studio' } : { ok: true, length: 1, samples: faithful(c, 'Wave') })));
    await call({ action: 'check', animation: structuredClone(loadRecipes().get('Wave')!) }, c);
    const r = await call({ action: 'build', name: 'Wave' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/edited in Studio.*force:true/s);
  });
});
