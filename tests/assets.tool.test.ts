import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { StudioSession } from '../src/studio/session.js';
import { BloxConfigSchema } from '../src/config.js';
import { loadManifest } from '../src/assets/manifest.js';
import { withSyntheticResults } from '../src/state/store.js';
import { cliArgs, parseFlags, runToolCommand } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';

const env = (v: unknown) => JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] });
function ctx(): ToolCtx {
  const projectPath = mkdtempSync(join(tmpdir(), 'blox-atool-'));
  const f = fakeStudio({
    luau: (code) => {
      if (code.includes('PROPS')) return env(JSON.stringify([{ id: 555, where: 'Workspace.Rock.MeshId', count: 1 }]));
      if (code.includes('LuaSourceContainer')) return env(JSON.stringify({ path: 'Workspace.Tree', removed: 1, parts: 12, meshParts: 2, textures: 1, scripts: [{ path: 'Workspace.Tree.Spread', class: 'Script', source: 'require(1234567890)' }] }));
      return env(null);
    },
  });
  return {
    session: new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 }),
    projectPath,
    config: BloxConfigSchema.parse({ projectPath }),
    agent: 'test',
  };
}
const call = (args: Record<string, unknown>, c: ToolCtx) => invokeTool(findTool('asset')!, args, c);

describe('asset tool', () => {
  it('sanitize records a creator-store entry with findings; lint and scan flow into asset:<rule>', async () => {
    const c = ctx();
    const s = await call({ action: 'sanitize', path: 'Workspace.Tree', id: 'tree', asset_id: 777 }, c);
    expect(s.text).toMatch(/removed 1 script/);
    expect(s.text).toMatch(/require\(<asset id>\)/);
    const e = loadManifest(c.projectPath).assets[0];
    expect(e).toMatchObject({ id: 'tree', source: 'creator-store', licence: 'roblox-creator-store', status: 'candidate', ref: { assetId: 777, path: 'Workspace.Tree' }, budget: { parts: 12 } });
    expect(e.sanitized!.findings[0]).toMatch(/Workspace\.Tree\.Spread: require/);
    const scan = await call({ action: 'scan' }, c);
    expect(scan.text).toMatch(/1 untracked/);
    const l = await call({ action: 'lint' }, c);
    expect(l.isError).toBeFalsy(); // untracked is a warning
    expect(l.text).toMatch(/WARN  untracked \[rbxassetid:\/\/555\]/);
    expect(withSyntheticResults(c.projectPath, null)!.tests.find((t) => t.name === 'asset:sanitized')!.status).toBe('pass');
  });
  it('add validates; upload without approval is refused; approve is not an MCP action', async () => {
    const c = ctx();
    expect((await call({ action: 'add', entry: { id: 'x' } }, c)).isError).toBe(true);
    await call({ action: 'add', entry: { id: 'rock', kind: 'mesh', source: 'external', licence: 'owned', ref: { file: 'r.fbx' }, provenance: { tool: 'meshy', createdAt: 'now' } } }, c);
    const u = await call({ action: 'upload', id: 'rock', confirm: true }, c);
    expect(u.isError).toBe(true);
    expect(u.text).toMatch(/blox asset approve rock/);
    expect((await call({ action: 'approve', id: 'rock' }, c)).isError).toBe(true);
  });
  it('cli: mapping and CLI-only approve', async () => {
    expect(cliArgs('asset', parseFlags(['sanitize', 'Workspace.Tree', '--id', 'tree', '--keep-scripts']))).toEqual({ tool: 'asset', args: { action: 'sanitize', path: 'Workspace.Tree', id: 'tree', keep_scripts: true } });
    expect(cliArgs('asset', parseFlags(['upload', 'rock', '--confirm']))).toEqual({ tool: 'asset', args: { action: 'upload', id: 'rock', confirm: true } });
    expect(cliArgs('asset', parseFlags(['normalize', 'm.glb', '--tris', '8000', '--height', '6']))).toEqual({ tool: 'asset', args: { action: 'normalize', file: 'm.glb', tris: 8000, height: 6 } });
    expect(cliArgs('asset', parseFlags([]))).toEqual({ tool: 'asset', args: { action: 'list' } });
    const c = ctx();
    await call({ action: 'add', entry: { id: 'rock', kind: 'mesh', source: 'external', licence: 'owned', ref: { file: 'r.fbx' }, provenance: { tool: 'meshy', createdAt: 'now' } } }, c);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (s: string) => logs.push(s);
    try {
      await runToolCommand(['asset', 'approve', 'rock', '--project', c.projectPath]);
    } finally {
      console.log = orig;
    }
    expect(logs.join('\n')).toMatch(/approved rock/);
    expect(loadManifest(c.projectPath).assets[0].status).toBe('approved');
  });
});
