import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadChecked } from '../src/anim/store.js';
import { buildTracks, sampleTrack } from '../src/anim/motion.js';
import { previewSampleTimes } from '../src/anim/animation-tool.js';
import { rigForSequence } from '../src/anim/modelRig.js';
import { kneeDeclarations, partsDog } from './fixtures/anim/parts-dog.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply(String(a.code))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-mbuild-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const dog = (tweak = 0) => { const { revision: _r, ...rest } = partsDog({ knees: true, declarations: kneeDeclarations() }); const d = { ...rest, path: 'Workspace.Dog' }; if (tweak) d.joints[1].c0[1] += tweak; return d; };
const WAG = { name: 'TailWag', rig: 'game.Workspace.Dog', loop: true, priority: 'Idle', duration: 1, waves: [{ joints: ['Tail'], axis: 'Y', amplitude: 20, cycles: 2 }] };

function faithful(c: ToolCtx, name: string) {
  const seq = loadChecked(c.projectPath, name)!.sequence;
  const rig = rigForSequence(c.projectPath, seq);
  const tracks = buildTracks(seq);
  return previewSampleTimes(seq).map((time) => ({ time, transforms: Object.fromEntries(rig.joints.map((j) => { const f = sampleTrack(tracks.get(j.childPart), time); return [j.childPart, [...f.p, ...f.r]]; })) }));
}

describe('check on a model rig', () => {
  it('reads the rig, compiles against it under its own path, saves rig.json', async () => {
    const codes: string[] = [];
    const c = ctx(() => ({ ok: true, reading: dog() }), codes);
    const r = await call({ action: 'check', animation: WAG }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(codes.length).toBe(1);
    expect(loadChecked(c.projectPath, 'TailWag')!.sequence.rig).toBe('Workspace.Dog');
    expect(existsSync(join(c.projectPath, '.blox/anims/TailWag/rig.json'))).toBe(true);
    expect(r.images?.length).toBe(1);
  });
  it('a stock-rig check touches no Studio and clears a stale rig.json', async () => {
    const codes: string[] = [];
    const c = ctx(() => ({ ok: true, reading: dog() }), codes);
    await call({ action: 'check', animation: WAG }, c);
    await call({ action: 'check', animation: { ...WAG, rig: 'R15', waves: [{ joints: ['Waist'], axis: 'Y', amplitude: 5, cycles: 1 }] } }, c);
    expect(codes.length).toBe(1);
    expect(existsSync(join(c.projectPath, '.blox/anims/TailWag/rig.json'))).toBe(false);
  });
});

describe('build on a model rig', () => {
  it('refuses when the rig changed since check', async () => {
    let tweak = 0;
    const codes: string[] = [];
    const c = ctx(() => ({ ok: true, reading: dog(tweak) }), codes);
    await call({ action: 'check', animation: WAG }, c);
    tweak = 0.25;
    const r = await call({ action: 'build', name: 'TailWag' }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rig changed since check/);
  });
  it('plays on a copy of the model and compares on its joints', async () => {
    let c!: ToolCtx;
    const codes: string[] = [];
    c = ctx((code) => (code.includes('readModelRig(P.path') ? { ok: true, reading: dog() } : code.includes('local WRITE = true') ? { ok: true, written: true } : { ok: true, length: 1, samples: faithful(c, 'TailWag') }), codes);
    await call({ action: 'check', animation: WAG }, c);
    const r = await call({ action: 'build', name: 'TailWag' }, c);
    expect(r.isError, r.text).toBeFalsy();
    const play = codes.find((x) => x.includes('local WRITE = false'))!;
    expect(play).toMatch(/"model":\{"path":"Workspace.Dog","rootPart":"HumanoidRootPart"\}/);
    expect(r.text).toMatch(/a copy of Workspace.Dog/);
  });
});
