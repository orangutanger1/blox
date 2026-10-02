import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { briefText, formatStats, modelDir, previewLuau, runModelPy, writeBrief } from '../src/model/run.js';
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
  });
});
