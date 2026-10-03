import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import type { StudioSession } from '../src/studio/session.js';
import { planRigBuild } from '../src/anim/rig-build.js';
import { rigDir } from '../src/anim/rigTool.js';
import { AXIS_ROTATIONS } from '../src/anim/rigBlender.js';
import { dogJoints, dogPieces } from './fixtures/anim/dog-pieces.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply(String(a.code))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-rigbuild-tool-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
/** The program's `-- Blox…` marker line (runLuau wraps the program in a prelude). */
const marker = (code: string) => /^-- Blox\w+$/m.exec(code)?.[0];
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const rawDog = () => { const { revision: _r, ...rest } = dogPieces(); return { ...rest, path: 'Workspace.Dog' }; };
const expectedRig = () => {
  const r = planRigBuild({ ...dogPieces(), path: 'Workspace.Dog' }, { joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped', replaceImporter: false });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  const { revision: _r, ...raw } = r.expected;
  return raw;
};
/** Studio as it would answer when the build goes as planned. */
const studio = (overrides: { read?: unknown; build?: unknown } = {}) => (code: string) => {
  if (/^-- BloxReadPieces$/m.test(code)) return overrides.read ?? { ok: true, reading: rawDog(), fingerprint: 'fp1' };
  if (/^-- BloxRigBuild$/m.test(code)) return overrides.build ?? { ok: true, reading: expectedRig(), fingerprint: 'rigfp', recorded: true, removed: [] };
  if (/^-- BloxRigStamp$/m.test(code)) return { ok: true };
  return { ok: false, error: `unexpected program: ${code.slice(0, 40)}` };
};

describe('animate rig suggest', () => {
  it('proposes joints, saves suggest.json stamped with the pieces revision, writes nothing', async () => {
    const codes: string[] = [];
    const c = ctx(studio(), codes);
    const r = await call({ action: 'rig', model: 'Workspace.Dog', suggest: true, plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/Neck: Head ← Body/);
    expect(r.text).toMatch(/joints:"suggested"/);
    expect(codes.every((x) => marker(x) === '-- BloxReadPieces')).toBe(true);
    const saved = JSON.parse(readFileSync(join(rigDir(c.projectPath, 'Workspace.Dog'), 'suggest.json'), 'utf8'));
    expect(saved.revision).toBe('rp1:fp1');
    expect(saved.joints.some((j: Record<string, unknown>) => 'why' in j)).toBe(false);
  });
  it('refuses a model that already has joints', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', suggest: true }, ctx(studio({ read: { ok: true, reading: { ...rawDog(), joints: [{ name: 'Neck', part0: 0, part1: 1 }] }, fingerprint: 'f' } })));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/already has 1 joint/);
  });
});

describe('animate rig build', () => {
  it('builds from given joints, reads back, stamps, and draws the range sheet', async () => {
    const codes: string[] = [];
    const c = ctx(studio(), codes);
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(codes.map(marker)).toEqual(['-- BloxReadPieces', '-- BloxRigBuild', '-- BloxRigStamp']);
    expect(codes[1]).toMatch(/"expect":"fp1"/);
    expect(r.text).toMatch(/read back as planned/);
    expect(r.text).toMatch(/expected_revision/);
    expect(r.images?.[0].mimeType).toBe('image/png');
    expect(existsSync(join(rigDir(c.projectPath, 'Workspace.Dog'), 'range.png'))).toBe(true);
  });
  it('strips why and loose from echoed suggestion joints', async () => {
    const echoed = dogJoints().map((j) => ({ ...j, why: 'touches Body', loose: undefined }));
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: echoed, controller: 'Humanoid', plan: 'quadruped' }, ctx(studio()));
    expect(r.isError, r.text).toBeFalsy();
  });
  it('joints:"suggested" uses the saved suggestion, refused when stale', async () => {
    const c = ctx(studio());
    await call({ action: 'rig', model: 'Workspace.Dog', suggest: true, plan: 'quadruped' }, c);
    const codes: string[] = [];
    const c2 = { ...c, session: ctx(studio(), codes).session };
    const ok = await call({ action: 'rig', model: 'Workspace.Dog', joints: 'suggested', controller: 'Humanoid', plan: 'quadruped' }, c2);
    // The fake Studio answers with the hand rig, so the read-back may differ by the suggested Neck pivot; what matters is that it built.
    expect(codes.some((x) => marker(x) === '-- BloxRigBuild'), ok.text).toBe(true);
    expect(ok.text).toMatch(/rigged Workspace\.Dog/);
    const stale = ctx(studio({ read: { ok: true, reading: rawDog(), fingerprint: 'fp2' } }));
    mkdirSync(rigDir(stale.projectPath, 'Workspace.Dog'), { recursive: true });
    writeFileSync(join(rigDir(stale.projectPath, 'Workspace.Dog'), 'suggest.json'), JSON.stringify({ model: 'Workspace.Dog', revision: 'rp1:fp1', joints: dogJoints() }));
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: 'suggested', controller: 'Humanoid' }, stale);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/rp1:fp1 → rp1:fp2/);
  });
  it('joints:"suggested" without a saved suggestion says to suggest first', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: 'suggested', controller: 'Humanoid' }, ctx(studio()));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/suggest:true/);
  });
  it('joints:"blender" fits pivots.json from the model export', async () => {
    const c = ctx(studio());
    const m = AXIS_ROTATIONS[7];
    const tr = [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    const back = (q: readonly number[]) => [tr[0] * q[0] + tr[1] * q[1] + tr[2] * q[2], tr[3] * q[0] + tr[4] * q[1] + tr[5] * q[2], tr[6] * q[0] + tr[7] * q[1] + tr[8] * q[2]];
    const absT = tr.map(Math.abs);
    const pieces = dogPieces().parts.map((p) => ({ name: p.name, bone: p.name, center: back(p.cframe.slice(0, 3)), size: back(p.size).map((_, i) => absT[i * 3] * p.size[0] + absT[i * 3 + 1] * p.size[1] + absT[i * 3 + 2] * p.size[2]) }));
    const joints = dogJoints().map((j) => ({ name: j.name ?? j.part, part: j.part, parent: j.parent, pivot: back(j.pivot) }));
    const dir = join(c.projectPath, '.blox', 'models', 'dog', 'export');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pivots.json'), JSON.stringify({ pieces, joints, riders: { Head: ['LeftEar', 'RightEar', 'Nose'] } }));
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: 'blender', blender_id: 'dog', controller: 'Humanoid', plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/matched by name/);
  });
  it('planner refusals list every problem and touch nothing', async () => {
    const codes: string[] = [];
    const bad = [{ part: 'Head', parent: 'Nope', pivot: [0, 0, 0] }];
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: bad, controller: 'Humanoid' }, ctx(studio(), codes));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/nothing was changed/);
    expect(codes.some((x) => marker(x) === '-- BloxRigBuild')).toBe(false);
  });
  it('model_changed from Studio comes back as the refusal', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped' }, ctx(studio({ build: { ok: false, code: 'model_changed', error: 'Workspace.Dog has changed since its pieces were read. Nothing was changed; call rig again.' } })));
    expect(r.isError).toBe(true);
    expect(r.summary).toBe('model_changed');
  });
  it('a read-back that differs is reported, not stamped', async () => {
    const moved = expectedRig();
    moved.joints = moved.joints.map((j) => (j.name === 'Tail' ? { ...j, c0: [j.c0[0] + 0.5, ...j.c0.slice(1)] } : j));
    const codes: string[] = [];
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped' }, ctx(studio({ build: { ok: true, reading: moved, fingerprint: 'x', recorded: true, removed: [] } }), codes));
    expect(r.text).toMatch(/Tail's C0 or C1/);
    expect(codes.some((x) => marker(x) === '-- BloxRigStamp')).toBe(false);
  });
  it('a clone backup is named when Studio gave no undo step', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped' }, ctx(studio({ build: { ok: true, reading: expectedRig(), fingerprint: 'x', recorded: false, backup: 'ServerStorage.__BloxRigBackup.Dog', removed: [] } })));
    expect(r.text).toMatch(/ServerStorage\.__BloxRigBackup\.Dog/);
  });
  it('refuses unsupported forms by name, before Studio is asked', async () => {
    const codes: string[] = [];
    for (const extra of [{ replace: 'importer' }, { pivot_space: 'import' }]) {
      const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints(), controller: 'Humanoid', ...extra }, ctx(studio(), codes));
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/not supported in blox/);
    }
    expect(codes).toEqual([]);
  });
  it('needs a controller with joints', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog', joints: dogJoints() }, ctx(studio()));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/controller/);
  });
});
