import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addAsset, loadManifest } from '../src/assets/manifest.js';
import { packEntries, restorePacks, saveAllPacks, savePack } from '../src/assets/packs.js';
import { StudioSession } from '../src/studio/session.js';
import { fakeStudio } from './fakeStudio.js';
import { luneBin, luneCheck } from './helpers/lune.js';

const env = (v: unknown) => JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] });
const entry = (id: string, ref: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id, kind: 'model', source: 'creator-store', licence: 'roblox-creator-store', ref, provenance: { tool: 'scout', createdAt: 'x' }, ...extra });

// A Studio that "serializes" to fixed bytes and records what restore sends back.
function studio(opts: { bytes?: Buffer; present?: boolean } = {}) {
  const bytes = opts.bytes ?? Buffer.from('rbxm-bytes-'.repeat(9000));
  const b64 = bytes.toString('base64');
  const codes: string[] = [];
  let incoming = '';
  const f = fakeStudio({
    luau: (code) => {
      codes.push(code);
      if (code.includes('BLOX_LOCATE')) return env(JSON.stringify({ result: [] }));
      if (code.includes('BLOX_PACK_SAVE')) return env(JSON.stringify({ len: b64.length, n: 1 }));
      const sub = /string\.sub\(_G\.__bloxPackOut\[TAG\], (\d+), (\d+)\)/.exec(code);
      if (sub) return env(b64.slice(Number(sub[1]) - 1, Number(sub[2])));
      if (code.includes('#CS:GetTagged(t) > 0')) return env(JSON.stringify(JSON.parse(/JSONDecode\(\[=*\[(.*?)\]=*\]\)/.exec(code)![1]).map(() => opts.present ?? false)));
      const w = /_G\.__bloxPackIn \.\.= \[=*\[([A-Za-z0-9+/=]*)\]=*\]/.exec(code);
      if (w) incoming += w[1];
      if (code.includes('BLOX_PACK_RESTORE')) return env('ServerStorage.trees');
      return env('ok');
    },
  });
  const session = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
  return { session, codes, bytes, incoming: () => incoming };
}

function project(): string {
  const p = mkdtempSync(join(tmpdir(), 'blox-packs-'));
  addAsset(p, entry('trees', { assetId: 1, path: 'ServerStorage.trees', tag: 'BloxAsset_trees' }));
  return p;
}

describe('packs', () => {
  it('save reads the serialized pack in chunks and records the file', async () => {
    const P = project();
    const s = studio();
    const r = await savePack(s.session, P, 'trees');
    expect(r.file).toBe('assets/packs/trees.rbxm');
    expect(readFileSync(join(P, r.file)).equals(s.bytes)).toBe(true);
    expect(s.codes.filter((c) => c.includes('string.sub(_G.__bloxPackOut')).length).toBeGreaterThan(2);
    expect(s.codes[s.codes.length - 1]).toContain('_G.__bloxPackOut[TAG] = nil');
    expect(loadManifest(P).assets[0].ref.file).toBe('assets/packs/trees.rbxm');
  });
  it('save refuses an entry with no tagged instance', async () => {
    const P = mkdtempSync(join(tmpdir(), 'blox-packs-'));
    addAsset(P, entry('gone', { assetId: 1 }));
    await expect(savePack(studio().session, P, 'gone')).rejects.toThrow(/not in the place/);
  });
  it('save-all covers placed models only', async () => {
    const P = project();
    addAsset(P, entry('icon', { file: 'assets/ui/i.png' }, { kind: 'image' }));
    addAsset(P, entry('tried', { assetId: 3, path: 'ServerStorage.BloxScout.tried', tag: 'BloxAsset_tried' }));
    expect(packEntries(loadManifest(P).assets).map((a) => a.id)).toEqual(['trees', 'tried']);
    const r = await saveAllPacks(studio().session, P);
    expect(r.saved).toHaveLength(2);
    expect(r.errors).toEqual([]);
  });
  it('restore sends back a saved pack whose tag is gone, and leaves present ones alone', async () => {
    const P = project();
    const bytes = Buffer.from('saved-pack-'.repeat(8000));
    mkdirSync(join(P, 'assets/packs'), { recursive: true });
    writeFileSync(join(P, 'assets/packs/trees.rbxm'), bytes);
    const m = JSON.parse(readFileSync(join(P, '.blox/assets.json'), 'utf8'));
    m.assets[0].ref.file = 'assets/packs/trees.rbxm';
    writeFileSync(join(P, '.blox/assets.json'), JSON.stringify(m));
    const s = studio();
    const r = await restorePacks(s.session, P);
    expect(r).toEqual({ restored: ['trees → ServerStorage.trees'], errors: [] });
    expect(Buffer.from(s.incoming(), 'base64').equals(bytes)).toBe(true);
    expect(s.codes.find((c) => c.includes('BLOX_PACK_RESTORE'))).toContain('#list == 1 and [[ServerStorage]] or [[ServerStorage.trees]]');
    const here = studio({ present: true });
    expect(await restorePacks(here.session, P)).toEqual({ restored: [], errors: [] });
    expect(here.codes.some((c) => c.includes('BLOX_PACK_RESTORE'))).toBe(false);
  });
  it('restore makes no Studio call when nothing is saved', async () => {
    const s = studio();
    expect(await restorePacks(s.session, project())).toEqual({ restored: [], errors: [] });
    expect(s.codes).toEqual([]);
  });
  it.skipIf(!luneBin())('Luau compiles', async () => {
    const P = project();
    const s = studio();
    await savePack(s.session, P, 'trees');
    const m = JSON.parse(readFileSync(join(P, '.blox/assets.json'), 'utf8'));
    writeFileSync(join(P, '.blox/assets.json'), JSON.stringify(m));
    await restorePacks(s.session, P);
    const d = mkdtempSync(join(tmpdir(), 'blox-packs-luau-'));
    const files = [...new Set(s.codes.map((c) => c.replace(/\[=*\[[A-Za-z0-9+/=]{100,}\]=*\]/g, '[[x]]')))].map((c, i) => {
      const f = join(d, `p${i}.luau`);
      writeFileSync(f, c);
      return f;
    });
    expect(luneCheck(files)).toEqual([]);
  });
});
