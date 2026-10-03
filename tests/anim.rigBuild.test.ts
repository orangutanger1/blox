import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRig, buildRigProgram, readPieces, readPiecesProgram, stampRig, stampRigProgram } from '../src/anim/rigBuild.js';
import { planRigBuild } from '../src/anim/rig-build.js';
import { rigRevision } from '../src/anim/modelRig.js';
import type { StudioSession } from '../src/studio/session.js';
import { dogJoints, dogPieces } from './fixtures/anim/dog-pieces.js';
import { luneBin, luneCheck } from './helpers/lune.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
const session = (reply: (code: string) => unknown, codes: string[] = []) =>
  ({ call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply(String(a.code))); } }) as unknown as StudioSession;

function rawDog() {
  const { revision: _r, ...rest } = dogPieces();
  return { ...rest, path: 'Workspace.Dog' };
}
function planned() {
  const r = planRigBuild({ ...dogPieces(), path: 'Workspace.Dog' }, { joints: dogJoints(), controller: 'Humanoid', plan: 'quadruped', replaceImporter: false });
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
}

describe('rig programs compile', () => {
  const d = mkdtempSync(join(tmpdir(), 'blox-rigbuild-'));
  it.skipIf(!luneBin())('read pieces', () => {
    writeFileSync(join(d, 'read.luau'), readPiecesProgram('Workspace.Dog'));
    expect(luneCheck([join(d, 'read.luau')])).toEqual([]);
  });
  it.skipIf(!luneBin())('build rig', () => {
    writeFileSync(join(d, 'build.luau'), buildRigProgram('Workspace.Dog', planned().plan, 'fp'));
    expect(luneCheck([join(d, 'build.luau')])).toEqual([]);
  });
  it.skipIf(!luneBin())('stamp', () => {
    writeFileSync(join(d, 'stamp.luau'), stampRigProgram('Workspace.Dog', 'rr1:abc', 'fp'));
    expect(luneCheck([join(d, 'stamp.luau')])).toEqual([]);
  });
});

describe('program payloads', () => {
  it('carry data only as a decoded payload, with their marker first', () => {
    const read = readPiecesProgram('game.Workspace.Dog');
    expect(read.split('\n')[0]).toBe('-- BloxReadPieces');
    expect(read).toMatch(/"path":"Workspace\.Dog"/);
    const build = buildRigProgram('Workspace.Dog', planned().plan, 'fp1');
    expect(build.split('\n')[0]).toBe('-- BloxRigBuild');
    expect(build).toMatch(/"expect":"fp1"/);
    expect(build).toMatch(/FrontLeftKnee/);
    for (const p of [read, build, stampRigProgram('Workspace.Dog', 'rr1:x', 'f')]) {
      expect(p).not.toMatch(/HttpService:(GetAsync|PostAsync|RequestAsync)|loadstring|require\(/);
    }
  });
});

describe('readPieces', () => {
  it('turns the reply into a PiecesReading with an rp1 revision', async () => {
    const r = await readPieces(session(() => ({ ok: true, reading: rawDog(), fingerprint: '0123abcd4567ef89' })), 'Workspace.Dog');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.revision).toBe('rp1:0123abcd4567ef89');
    expect(r.reading.parts).toHaveLength(dogPieces().parts.length);
    expect(r.reading.rig).toBeUndefined();
  });
  it('a jointed model gets its rig revision and the stamp it was built with', async () => {
    const exp = planned().expected;
    const { revision: _r, ...rigReading } = exp;
    const raw = { ...rawDog(), joints: [{ name: 'Neck', part0: 0, part1: 1 }], rigReading, builtRevision: 'rr1:old' };
    const r = await readPieces(session(() => ({ ok: true, reading: raw, fingerprint: 'f' })), 'Workspace.Dog');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.rig).toEqual({ revision: rigRevision(rigReading), builtRevision: 'rr1:old' });
    expect('rigReading' in r.reading).toBe(false);
  });
  it('a jointed model whose rig does not read is "unreadable"', async () => {
    const raw = { ...rawDog(), joints: [{ name: 'Neck', part0: 0, part1: 1 }] };
    const r = await readPieces(session(() => ({ ok: true, reading: raw, fingerprint: 'f' })), 'Workspace.Dog');
    expect(r.ok && r.reading.rig?.revision).toBe('unreadable');
  });
  it('passes refusals and garbage through as named errors', async () => {
    const no = await readPieces(session(() => ({ ok: false, code: 'skinned', error: 'Workspace.Wolf is a skinned mesh' })), 'Workspace.Wolf');
    expect(no).toEqual({ ok: false, code: 'skinned', error: 'Workspace.Wolf is a skinned mesh' });
    const junk = await readPieces({ call: async () => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: 'oops' }, logs: [] }) }] }) } as unknown as StudioSession, 'Workspace.Dog');
    expect(junk.ok).toBe(false);
    if (!junk.ok) expect(junk.error).toMatch(/non-JSON/);
  });
});

describe('buildRig and stampRig', () => {
  it('returns the read-back with its rr1 revision', async () => {
    const { revision: _r, ...raw } = planned().expected;
    const codes: string[] = [];
    const r = await buildRig(session(() => ({ ok: true, reading: raw, fingerprint: 'rigfp', recorded: true, removed: [] }), codes), 'Workspace.Dog', planned().plan, 'fp');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.reading.revision).toBe(rigRevision(raw));
    expect(r.recorded).toBe(true);
    expect(codes[0]).toMatch(/^-- BloxRigBuild$/m);
  });
  it('a model_changed refusal comes back named', async () => {
    const r = await buildRig(session(() => ({ ok: false, code: 'model_changed', error: 'Workspace.Dog has changed since its pieces were read. Nothing was changed; call rig again.' })), 'Workspace.Dog', planned().plan, 'fp');
    expect(r).toMatchObject({ ok: false, code: 'model_changed' });
  });
  it('stamp passes ok and refusals', async () => {
    expect(await stampRig(session(() => ({ ok: true })), 'Workspace.Dog', 'rr1:x', 'f')).toEqual({ ok: true });
    expect(await stampRig(session(() => ({ ok: false, error: 'changed' })), 'Workspace.Dog', 'rr1:x', 'f')).toEqual({ ok: false, error: 'changed' });
  });
});
