import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { declareProgram, modelPath, parseReply, readRig, readRigProgram, rigForSequence, rigRevision } from '../src/anim/modelRig.js';
import { saveRigReading } from '../src/anim/store.js';
import { compilePoseAnimation } from '../src/anim/pose-compiler.js';
import { kneeDeclarations, partsDog } from './fixtures/anim/parts-dog.js';
import { luneBin, luneCheck } from './helpers/lune.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
const session = (reply: unknown, codes: string[] = []) => ({ call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply); } }) as unknown as StudioSession;
const dog = () => { const { revision: _r, ...rest } = partsDog({ knees: true, declarations: kneeDeclarations() }); return { ...rest, path: 'Workspace.Dog' }; };

describe('rig revision', () => {
  it('ignores the path (clones match) and joint order, and sees a moved pivot', () => {
    const a = dog();
    expect(rigRevision({ ...a, path: 'Workspace.Dog2' })).toBe(rigRevision(a));
    expect(rigRevision({ ...a, joints: [...a.joints].reverse() })).toBe(rigRevision(a));
    const moved = structuredClone(a);
    moved.joints[1].c0[1] += 0.1;
    expect(rigRevision(moved)).not.toBe(rigRevision(a));
    expect(rigRevision(a)).toMatch(/^rr1:[0-9a-f]{16}$/);
  });
});

describe('readRig', () => {
  it('turns a reading into a rig and adds the revision', async () => {
    const codes: string[] = [];
    const r = await readRig(session({ ok: true, reading: dog(), rigType: 'R15', walkSpeed: 16 }, codes), 'game.Workspace.Dog');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rig.name).toBe('Workspace.Dog');
    expect(r.reading.revision).toBe(rigRevision(dog()));
    expect(r.rig.feet.length).toBe(4);
    expect(codes[0]).toContain('local PAYLOAD = ');
    expect(codes[0]).not.toMatch(/resolve\("Workspace/); // the path reaches Luau only inside the payload
  });
  it('passes a Studio refusal through with its code', async () => {
    const r = await readRig(session({ ok: false, code: 'not_rigged', error: 'Workspace.Box has no Motor6D ... rig building is not supported yet' }), 'Workspace.Box');
    expect(r).toMatchObject({ ok: false, code: 'not_rigged' });
  });
  it('refuses a reading rigFromModel rejects, naming the problems', async () => {
    const bad = dog();
    bad.joints = bad.joints.filter((j) => j.name !== 'Root');
    const r = await readRig(session({ ok: true, reading: bad }), 'Workspace.Dog');
    expect(r.ok).toBe(false);
  });
  it('an empty or non-JSON reply is a named error', () => {
    expect(parseReply([], 'rig read')).toEqual({ ok: false, error: 'rig read: Studio returned no reply' });
    expect(parseReply(['<html>'], 'rig read')).toMatchObject({ ok: false, error: expect.stringMatching(/^rig read: Studio returned non-JSON/) });
    expect(parseReply([{ ok: true }], 'x')).toEqual({ ok: true, value: { ok: true } });
  });
  it('modelPath strips game.', () => {
    expect(modelPath('game.Workspace.Dog')).toBe('Workspace.Dog');
    expect(modelPath('Workspace.Dog')).toBe('Workspace.Dog');
  });
});

describe('rigForSequence', () => {
  it('stock names map to stock rigs; a model path to the saved reading', () => {
    const P = mkdtempSync(join(tmpdir(), 'blox-mrig-'));
    const reading = { ...dog(), revision: rigRevision(dog()) };
    saveRigReading(P, 'DogWalk', reading);
    const c = compilePoseAnimation({ name: 'DogWalk', rig: 'R15', loop: true, keyframes: [{ time: 0, joints: { Neck: {} } }, { time: 1, joints: { Neck: {} } }] });
    if (!c.ok) throw new Error(c.errors.join());
    expect(rigForSequence(P, c.sequence).name).toBe('R15');
    expect(rigForSequence(P, { ...c.sequence, name: 'DogWalk', rig: 'Workspace.Dog' }).name).toBe('Workspace.Dog');
    expect(() => rigForSequence(P, { ...c.sequence, name: 'Other', rig: 'Workspace.Dog' })).toThrow(/check it again/);
    writeFileSync(join(P, 'x'), '');
  });
});

describe('final review fixes', () => {
  it('a bare read (declare) ignores a non-string BloxRig so declare can repair it', () => {
    expect(readRigProgram('Workspace.Dog', true)).toMatch(/if declared ~= nil and typeof\(declared\) ~= "string" and not bare then/);
  });
});

describe('rig read Luau compiles', () => {
  it.skipIf(!luneBin())('read program', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-mrigluau-'));
    writeFileSync(join(d, 'read.luau'), readRigProgram('Workspace.Dog', false));
    expect(luneCheck([join(d, 'read.luau')])).toEqual([]);
  });
  it.skipIf(!luneBin())('declare program', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-mrigluau-'));
    writeFileSync(join(d, 'declare.luau'), declareProgram('Workspace.Dog', '{"version":1}', 'fp'));
    expect(luneCheck([join(d, 'declare.luau')])).toEqual([]);
  });
});
