import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decalImageLuau, parseImageId, resolveDecalImage } from '../src/assets/decal.js';
import { addAsset, approveAsset, loadManifest, saveManifest } from '../src/assets/manifest.js';
import { recordImageId } from '../src/assets/upload.js';
import { StudioSession } from '../src/studio/session.js';
import { findTool, invokeTool, type ToolCtx } from '../src/tools/registry.js';
import { BloxConfigSchema } from '../src/config.js';
import { cliArgs, parseFlags } from '../src/cliTools.js';
import { fakeStudio } from './fakeStudio.js';

const env = (values: unknown[]) => JSON.stringify({ ok: true, n: values.length, values: Object.fromEntries(values.map((v, i) => [`v${i + 1}`, v])), logs: [] });
const fail = (message: string) => JSON.stringify({ ok: false, error: { message }, logs: [] });

function session(answers: string[], seen: string[] = []) {
  const f = fakeStudio({
    luau: (code) => {
      seen.push(code);
      if (code.includes('LoadAsset')) return answers.shift() ?? env(['']);
      return env([]);
    },
  });
  return new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
}

describe('decal → image id', () => {
  it('parses rbxassetid and legacy asset urls', () => {
    expect(parseImageId('rbxassetid://123456')).toBe(123456);
    expect(parseImageId('http://www.roblox.com/asset/?id=987')).toBe(987);
    expect(parseImageId('')).toBeNull();
    expect(parseImageId(undefined)).toBeNull();
  });
  it('the Luau loads the decal and reads its Texture', () => {
    const code = decalImageLuau(555);
    expect(code).toContain('local id = 555');
    expect(code).toContain('LoadAsset(id)');
    expect(code).toContain('d.Texture');
  });
  it('retries while the fresh upload is not loadable yet', async () => {
    const seen: string[] = [];
    const id = await resolveDecalImage(session([fail('HTTP 403 (Forbidden)'), env(['rbxassetid://4242'])], seen), 555, { sleep: async () => {} });
    expect(id).toBe(4242);
    expect(seen.filter((c) => c.includes('LoadAsset'))).toHaveLength(2);
  });
  it('gives up with the last reason', async () => {
    await expect(resolveDecalImage(session([]), 555, { attempts: 2, sleep: async () => {} })).rejects.toThrow(/decal 555 has no image texture/);
  });
  it('recordImageId points ref.assetId at the image, keeps the decal on uploaded', () => {
    const p = mkdtempSync(join(tmpdir(), 'blox-decal-'));
    addAsset(p, { id: 'icon', kind: 'image', source: 'generated', licence: 'owned', ref: { file: 'icon.png' }, provenance: { tool: 'x', createdAt: 'x' } });
    const m = loadManifest(p);
    m.assets[0].uploaded = { assetId: 555, operation: 'op', at: 'now' };
    m.assets[0].ref.assetId = 555;
    saveManifest(p, m);
    recordImageId(p, 'icon', 4242);
    expect(loadManifest(p).assets[0]).toMatchObject({ ref: { assetId: 4242 }, uploaded: { assetId: 555, imageId: 4242 } });
  });
});

describe('asset tool: resolve', () => {
  function ctx(answers: string[]): ToolCtx {
    const projectPath = mkdtempSync(join(tmpdir(), 'blox-decal-'));
    writeFileSync(join(projectPath, 'icon.png'), 'x');
    addAsset(projectPath, { id: 'icon', kind: 'image', source: 'generated', licence: 'owned', ref: { file: 'icon.png' }, provenance: { tool: 'x', createdAt: 'x' } });
    approveAsset(projectPath, 'icon');
    const m = loadManifest(projectPath);
    m.assets[0].uploaded = { assetId: 555, operation: 'op', at: 'now' };
    saveManifest(projectPath, m);
    return { session: session(answers), projectPath, config: BloxConfigSchema.parse({ projectPath }), agent: 'test' };
  }
  it('resolves an uploaded image by id and records it', async () => {
    const c = ctx([env(['rbxassetid://4242'])]);
    const r = await invokeTool(findTool('asset')!, { action: 'resolve', id: 'icon' }, c);
    expect(r.text).toMatch(/decal 555 → image 4242/);
    expect(loadManifest(c.projectPath).assets[0].ref.assetId).toBe(4242);
  });
  it('cli: numeric arg is a decal id, otherwise a manifest id', () => {
    expect(cliArgs('asset', parseFlags(['resolve', '555']))).toEqual({ tool: 'asset', args: { action: 'resolve', asset_id: 555 } });
    expect(cliArgs('asset', parseFlags(['resolve', 'icon']))).toEqual({ tool: 'asset', args: { action: 'resolve', id: 'icon' } });
  });
});
