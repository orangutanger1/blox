import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { partsDog } from './fixtures/anim/parts-dog.js';
import type { StudioSession } from '../src/studio/session.js';

const envelope = (v: unknown) => ({ content: [{ type: 'text', text: JSON.stringify({ ok: true, n: 1, values: { v1: JSON.stringify(v) }, logs: [] }) }] });
function ctx(reply: (code: string) => unknown, codes: string[] = []): ToolCtx {
  const session = { call: async (_n: string, a: Record<string, unknown>) => { codes.push(String(a.code)); return envelope(reply(String(a.code))); } } as unknown as StudioSession;
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-rigtool-'));
  return { session, projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('animate')!, args, c);
const bareDog = (declarations?: string) => { const { revision: _r, ...rest } = partsDog({ knees: true }); return { ...rest, path: 'Workspace.Dog', ...(declarations ? { declarations } : {}) }; };

describe('animate rig', () => {
  it('summarizes the rig and names the checks a missing declaration disables', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Dog' }, ctx(() => ({ ok: true, reading: bareDog() })));
    expect(r.isError, r.text).toBeFalsy();
    expect(r.text).toMatch(/FrontLeftKnee/);
    expect(r.text).toMatch(/groundContact, footSliding and gaitSymmetry are not checked/);
    expect(r.text).toMatch(/plan:"quadruped"/);
  });
  it('passes a Studio refusal through', async () => {
    const r = await call({ action: 'rig', model: 'Workspace.Box' }, ctx(() => ({ ok: false, code: 'not_rigged', error: 'Workspace.Box has no Motor6D ... rig building is not supported yet' })));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not supported yet/);
  });
});

describe('animate declare', () => {
  it('reads bare, merges the plan, validates, then writes BloxRig once', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (code.includes('BloxRigWrite') ? { ok: true, written: true } : { ok: true, reading: bareDog() }), codes);
    const r = await call({ action: 'declare', model: 'Workspace.Dog', plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
    expect(codes[0]).toMatch(/"bare":true/);
    const writes = codes.filter((x) => x.includes('BloxRigWrite'));
    expect(writes.length).toBe(1);
    expect(writes[0]).toMatch(/FrontLeftLower/);
    expect(r.text).toMatch(/feet/);
  });
  it('a malformed existing BloxRig does not block declare (bare read)', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (code.includes('BloxRigWrite') ? { ok: true, written: true } : code.includes('"bare":true') ? { ok: true, reading: bareDog() } : { ok: true, reading: bareDog('{not json') }), codes);
    const r = await call({ action: 'declare', model: 'Workspace.Dog', plan: 'quadruped' }, c);
    expect(r.isError, r.text).toBeFalsy();
  });
  it('invalid declarations write nothing and list every problem', async () => {
    const codes: string[] = [];
    const c = ctx((code) => (code.includes('BloxRigWrite') ? { ok: true } : { ok: true, reading: bareDog() }), codes);
    const r = await call({ action: 'declare', model: 'Workspace.Dog', declarations: { version: 1, feet: ['NoSuchPart'] } }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/NoSuchPart/);
    expect(codes.some((x) => x.includes('BloxRigWrite'))).toBe(false);
  });
  it('needs plan or declarations', async () => {
    const r = await call({ action: 'declare', model: 'Workspace.Dog' }, ctx(() => ({})));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/plan.*declarations/);
  });
});
