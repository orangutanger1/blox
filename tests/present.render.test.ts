import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioSession } from '../src/studio/session.js';
import { renderShots } from '../src/present/render.js';
import { rigProgram, CLEANUP } from '../src/present/rig.js';
import { defaultShots } from '../src/present/generate.js';
import { validateDesign } from '../src/design/schema.js';
import type { Presentation } from '../src/present/schema.js';
import { luneBin, luneCheck } from './helpers/lune.js';
import { fakeStudio } from './fakeStudio.js';
import { readFileSync } from 'node:fs';

const ok = JSON.stringify({ ok: true, n: 1, values: { v1: 'r15' }, logs: [] });
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000007800000043808020000', 'hex').toString('base64');

function setup(capture: () => unknown, mode: 'Edit' | 'Play' = 'Edit') {
  const log: string[] = [];
  const f = fakeStudio({
    mode,
    luau: (code) => {
      log.push(code.includes('__BloxRenderRig') && code.includes('r:Destroy()') && !code.includes('SHOT') ? 'cleanup' : code.includes('SHOT') ? 'rig' : 'other');
      return ok;
    },
    tools: { screen_capture: () => { log.push('capture'); return capture() as never; } },
  });
  const session = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
  const v = validateDesign(JSON.parse(readFileSync(new URL('../docs/examples/design/incremental.json', import.meta.url), 'utf8')));
  if (!v.ok) throw new Error('x');
  const doc: Presentation = { version: 1, title: 'T', description: 'D', shots: defaultShots(v.doc) };
  return { session, log, doc, p: mkdtempSync(join(tmpdir(), 'blox-render-')) };
}

describe('renderShots', () => {
  it('stages, captures and records every shot, cleaning up each time', async () => {
    const s = setup(() => ({ content: [{ type: 'image', data: PNG, mimeType: 'image/png' }] }));
    const r = await renderShots(s.session, s.p, s.doc, ['action', 'icon']);
    expect(r.failed).toEqual([]);
    expect(r.rendered.map((x) => x.id)).toEqual(['action', 'icon']);
    expect(s.log).toEqual(['rig', 'capture', 'cleanup', 'rig', 'capture', 'cleanup']);
    expect(existsSync(join(s.p, '.blox/artifacts/present/action.png'))).toBe(true);
    expect(s.doc.shots[0]).toMatchObject({ file: '.blox/artifacts/present/action.png', provenance: 'render' });
  });
  it('a failed capture is reported and the rig is still removed', async () => {
    const s = setup(() => 'no image');
    const r = await renderShots(s.session, s.p, s.doc, ['hero']);
    expect(r.failed).toEqual([{ id: 'hero', error: 'screen_capture returned no image' }]);
    expect(s.log.at(-1)).toBe('cleanup');
  });
  it('refuses during a playtest and on unknown ids', async () => {
    await expect(renderShots(setup(() => '', 'Play').session, '/tmp', setup(() => '').doc)).rejects.toThrow(/stop the playtest/);
    const s = setup(() => '');
    await expect(renderShots(s.session, s.p, s.doc, ['nope'])).rejects.toThrow(/unknown shot id/);
  });
  it.skipIf(!luneBin())('rig + cleanup programs compile', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-rig-'));
    const s = setup(() => '');
    const shot = { ...s.doc.shots[3], hero: { path: 'Workspace.Pets.Dragon', at: [1, 2, 3] as [number, number, number], scale: 2 } };
    writeFileSync(join(d, 'rig.luau'), rigProgram(shot));
    writeFileSync(join(d, 'clean.luau'), CLEANUP);
    expect(luneCheck([join(d, 'rig.luau'), join(d, 'clean.luau')])).toEqual([]);
  });
});

describe('rigProgram (live Studio findings, Oct 2026)', () => {
  const shot = { id: 's', kind: 'thumbnail', theme: 'action', camera: { position: [0, 5, 0], lookAt: [0, 3, -10] }, subject: { at: [0, 3, -10], pose: 'cheer' }, overlay: { text: 'GO', color: '#FFD23F' } } as unknown as Parameters<typeof rigProgram>[0];
  const code = rigProgram(shot);
  it('poses AnimationConstraint joints (current R15) as well as Motor6Ds', () => {
    expect(code).toContain('IsA("AnimationConstraint")');
    expect(code).toContain('IsA("Motor6D")');
  });
  it('gives the default avatar real body colors', () => {
    expect(code).toMatch(/hd\.HeadColor/);
  });
  it('strips scripts from the rig (the MCP thread may not parent them)', () => {
    expect(code).toContain('IsA("LuaSourceContainer") then d:Destroy()');
  });
  it('draws the overlay as a non-AlwaysOnTop SurfaceGui (captures skip BillboardGuis and AlwaysOnTop)', () => {
    expect(code).toContain('Instance.new("SurfaceGui")');
    expect(code).not.toContain('BillboardGui');
    expect(code).not.toContain('AlwaysOnTop = true');
  });
});
