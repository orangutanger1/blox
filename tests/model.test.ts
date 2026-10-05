import { describe, it, expect } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefText, checkImages, formatStats, modelDir, previewLuau, runModelPy, writeBrief } from '../src/model/run.js';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { StudioSession } from '../src/studio/session.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { luneBin, luneCheck } from './helpers/lune.js';
import { writeFileSync } from 'node:fs';

const project = () => mkdtempSync(join(tmpdir(), 'blox-model-'));

describe('model helpers', () => {
  it('rejects unsafe ids', () => {
    expect(() => modelDir('/p', '../x')).toThrow(/bad model id/);
    expect(modelDir('/p', 'dog_1')).toBe(join('/p', '.blox', 'models', 'dog_1'));
  });
  it('brief records the spec and returns the build loop', () => {
    const p = project();
    const b = writeBrief(p, { id: 'dog', prompt: 'blocky dog', tris: 2000, rig: true, animations: ['Walk'], refs: [] });
    expect(JSON.parse(readFileSync(join(p, '.blox/models/dog/brief.json'), 'utf8')).prompt).toBe('blocky dog');
    const t = briefText(b);
    expect(t).toContain('budget 2000 triangles');
    expect(t).toContain('bind_rigid');
    expect(t).toContain('model {action:"check", id:"dog"}');
  });
  it('stats list issues and views', () => {
    const t = formatStats({ triangles: 30000, meshes: { a: 30000 }, materials: 1, bones: 0, maxInfluences: 0, actions: [], textures: [], size: [1, 2, 3], issues: ['triangles 30000 > budget 5000'], views: ['/p/.blox/models/a/views/front.png'] }, '/p');
    expect(t).toContain('✗ triangles 30000 > budget 5000');
    expect(t).toContain('.blox/models/a/views/front.png');
  });
  it('stats show the budget block and colour survival', () => {
    const t = formatStats({ triangles: 4210, meshes: { a: 4000, b: 210 }, materials: 3, bones: 12, maxInfluences: 1, actions: [], textures: [{ name: 'skin', size: [1024, 1024] }], size: [1, 2, 3], issues: [], colours: { A: 'flat', B: 'flat', C: 'vertex', D: 'texture' }, uploadParts: 3 }, '/p', 5000);
    expect(t).toContain('budget: 4210 / 5000 triangles (84%) · upload ≈ 3 MeshParts · 12 bones · textures: skin 1024×1024');
    expect(t).toContain('colours: 2 flat (baked into vertex colours on export), 1 vertex, 1 texture');
    const noBudget = formatStats({ triangles: 10, meshes: {}, materials: 0, bones: 0, maxInfluences: 0, actions: [], textures: [], size: [1, 1, 1], issues: [] }, '/p');
    expect(noBudget).not.toContain('budget:');
  });
  it('checkImages attaches views then refs (PNG/JPEG, size-capped, at most 4 refs)', () => {
    const p = project();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    for (const f of ['front.png', 'r1.png', 'r3.png', 'r4.png', 'r5.png']) writeFileSync(join(p, f), png);
    writeFileSync(join(p, 'r2.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    writeFileSync(join(p, 'big.png'), Buffer.alloc(3 * 1024 * 1024));
    writeFileSync(join(p, 'sheet.webp'), png);
    const r = checkImages([join(p, 'front.png'), join(p, 'gone.png')], ['big.png', 'sheet.webp', 'r1.png', 'r2.jpg', 'r3.png', 'r4.png', 'r5.png'], p);
    expect(r.images.map((i) => i.mimeType)).toEqual(['image/png', 'image/png', 'image/jpeg', 'image/png', 'image/png']);
    expect(r.images[0].data).toBe(png.toString('base64'));
    expect(r.labels).toEqual(['view front', 'reference r1.png', 'reference r2.jpg', 'reference r3.png', 'reference r4.png']);
    expect(r.notes.join('\n')).toMatch(/big\.png.*over 2 MB/);
    expect(r.notes.join('\n')).toMatch(/sheet\.webp.*PNG or JPEG/);
    expect(r.notes.join('\n')).toMatch(/r5\.png.*4 references/);
    expect(r.notes.join('\n')).toMatch(/gone\.png.*missing/);
  });
  it('checkImages sniffs the bytes and keeps refs inside the project', () => {
    const p = project();
    const outside = project();
    writeFileSync(join(p, 'fake.png'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    writeFileSync(join(p, 'real.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
    writeFileSync(join(outside, 'x.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = checkImages([], ['fake.png', 'real.jpg', join(outside, 'x.png'), '../escape.png'], p);
    expect(r.images.map((i) => i.mimeType)).toEqual(['image/jpeg']);
    expect(r.notes.join('\n')).toMatch(/fake\.png.*not a PNG/);
    expect(r.notes.join('\n')).toMatch(/x\.png.*outside the project/);
    expect(r.notes.join('\n')).toMatch(/escape\.png.*outside the project/);
  });
  it('runModelPy passes software-GL env on linux and parses the result line', async () => {
    const p = project();
    let env: Record<string, string> | undefined;
    const r = await runModelPy('check', { blend: 'x' }, join(p, 'd'), async (_c, args, e) => {
      env = e;
      expect(args).toContain('check');
      return { code: 0, stdout: 'noise\nBLOX_MODEL {"triangles": 3}\n', stderr: '' };
    });
    expect(r).toEqual({ triangles: 3 });
    if (process.platform === 'linux') expect(env).toEqual({ LIBGL_ALWAYS_SOFTWARE: '1', WAYLAND_DISPLAY: 'nonexistent' });
    await expect(runModelPy('run', {}, join(p, 'd'), async () => ({ code: 1, stdout: 'BLOX_ERROR your code raised: boom', stderr: '' }))).rejects.toThrow(/boom/);
  });
  it.skipIf(!luneBin())('preview Luau compiles', () => {
    const f = join(project(), 'preview.luau');
    writeFileSync(f, previewLuau('dog', { triangles: [{ v: [[0, 0, 0], [1, 0, 0], [0, 1, 0]], c: 'ff0000' }] }, [0, 0, 20]));
    expect(luneCheck([f])).toEqual([]);
  });
});

describe('model tool', () => {
  const ctx = (p: string): ToolCtx => ({ session: new StudioSession({}), projectPath: p, config: BloxConfigSchema.parse({ projectPath: p }), agent: 'test' });
  const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('model')!, args, c);
  it('brief, list, and refuses work before a model exists', async () => {
    const p = project();
    expect((await call({ action: 'brief', id: 'dog', prompt: 'blocky dog', rig: true, animations: ['Walk'] }, ctx(p))).isError).toBeFalsy();
    expect(existsSync(join(p, '.blox/models/dog/brief.json'))).toBe(true);
    expect((await call({ action: 'list' }, ctx(p))).text).toContain('dog  blocky dog');
    const r = await call({ action: 'check', id: 'dog' }, ctx(p));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no model "dog" yet/);
    expect((await call({ action: 'brief', id: 'cat', prompt: 'x', refs: ['nope.png'] }, ctx(p))).text).toMatch(/not found: nope.png/);
  });
  it('brief copies a reference from outside the project into the model and stores project paths', async () => {
    const p = project();
    const outside = mkdtempSync(join(tmpdir(), 'blox-ref-'));
    writeFileSync(join(outside, 'side.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(p, 'front.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const r = await call({ action: 'brief', id: 'dog', prompt: 'dog', refs: [join(outside, 'side.png'), 'front.png', join(p, 'front.png')] }, ctx(p));
    expect(r.isError, r.text).toBeFalsy();
    const brief = JSON.parse(readFileSync(join(p, '.blox/models/dog/brief.json'), 'utf8')) as { refs: string[] };
    expect(brief.refs).toEqual(['.blox/models/dog/refs/side.png', 'front.png', 'front.png']);
    expect(existsSync(join(p, '.blox/models/dog/refs/side.png'))).toBe(true);
  });
  it('check returns the views and references as images (images:false opts out)', async () => {
    const p = project();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    writeFileSync(join(p, 'ref.png'), png);
    await call({ action: 'brief', id: 'dog', prompt: 'blocky dog', tris: 1000, refs: ['ref.png'] }, ctx(p));
    const dir = join(p, '.blox/models/dog');
    writeFileSync(join(dir, 'model.blend'), '');
    mkdirSync(join(dir, 'views'), { recursive: true });
    writeFileSync(join(dir, 'views', 'front.png'), png);
    const stats = { triangles: 900, meshes: { a: 900 }, materials: 1, bones: 0, maxInfluences: 0, actions: [], textures: [], size: [1, 1, 1], issues: [], views: [join(dir, 'views', 'front.png')], colours: { A: 'flat' }, uploadParts: 1 };
    const fake = join(p, 'fake-blender.sh');
    writeFileSync(fake, `#!/bin/sh\necho 'BLOX_MODEL ${JSON.stringify(stats)}'\n`);
    chmodSync(fake, 0o755);
    const old = process.env.BLOX_BLENDER;
    process.env.BLOX_BLENDER = fake;
    try {
      const r = await call({ action: 'check', id: 'dog' }, ctx(p));
      expect(r.isError).toBeFalsy();
      expect(r.images?.length).toBe(2);
      expect(r.text).toContain('budget: 900 / 1000 triangles (90%)');
      expect(r.text).toContain('images: view front, reference ref.png');
      const off = await call({ action: 'check', id: 'dog', images: false }, ctx(p));
      expect(off.images ?? []).toEqual([]);
      // Later checks send the views only; with_refs resends the references.
      const later = await call({ action: 'check', id: 'dog' }, ctx(p));
      expect(later.images?.length).toBe(1);
      expect(later.text).toMatch(/references not resent \(1; sent on the first check\)/);
      expect((await call({ action: 'check', id: 'dog', with_refs: true }, ctx(p))).images?.length).toBe(2);
    } finally {
      if (old === undefined) delete process.env.BLOX_BLENDER;
      else process.env.BLOX_BLENDER = old;
    }
  });
});

describe('model cli', () => {
  it('maps brief flags and run files', () => {
    expect(cliArgs('model', parseFlags(['brief', 'dog', '--prompt', 'blocky dog', '--tris', '2000', '--rig', '--anims', 'Walk,Sleep']))).toEqual({
      tool: 'model', args: { action: 'brief', id: 'dog', prompt: 'blocky dog', tris: 2000, rig: true, animations: ['Walk', 'Sleep'] },
    });
    const f = join(project(), 'b.py');
    writeFileSync(f, 'reset()');
    expect(cliArgs('model', parseFlags(['run', 'dog', f]))).toEqual({ tool: 'model', args: { action: 'run', id: 'dog', code: 'reset()' } });
    expect(cliArgs('model', parseFlags(['preview', 'dog', '--at', '0,1,20']))).toEqual({ tool: 'model', args: { action: 'preview', id: 'dog', at: [0, 1, 20] } });
    expect(cliArgs('model', parseFlags(['icon', 'coin', '--out', 'assets/ui/icons/coin.png', '--yaw', '-90', '--outline', '6', '--outline-color', '#000000']))).toEqual({
      tool: 'model',
      args: { action: 'icon', id: 'coin', out: 'assets/ui/icons/coin.png', yaw: -90, outline: 6, outline_color: '#000000' },
    });
  });
});
