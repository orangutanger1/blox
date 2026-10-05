import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson } from '../src/state/store.js';
import { releaseCheck, formatRelease } from '../src/release/check.js';

const ok = (ids: string[]) => ({ ranAt: '2030-01-01T00:00:00Z', results: ids.map((id) => ({ id, ok: true })) });
function ready(): string {
  const p = mkdtempSync(join(tmpdir(), 'blox-rel-'));
  writeJson(p, 'last-tests.json', { ranAt: 'x', tests: [{ file: 'tests/a.spec.luau', name: 'a', status: 'pass' }], fileErrors: [] });
  writeJson(p, 'metrics-report.json', ok(['ftue:first-step', 'soak:errors']));
  writeJson(p, 'ui-report.json', ok(['ui:offscreen']));
  writeJson(p, 'present-report.json', ok(['present:title-length']));
  return p;
}
const status = (p: string) => Object.fromEntries(releaseCheck(p).gates.map((g) => [g.id, g.status]));

describe('releaseCheck', () => {
  it('ready when every required gate passed', () => {
    const r = releaseCheck(ready());
    expect(r.ready).toBe(true);
    expect(status(ready())).toMatchObject({ tests: 'pass', ftue: 'pass', soak: 'pass', ui: 'pass', present: 'pass', design: 'n/a', multiplayer: 'n/a', assets: 'n/a' });
    expect(formatRelease(r)).toMatch(/^release check: READY/);
    expect(formatRelease(r)).toMatch(/human gates/i);
  });
  it('missing and failing gates block', () => {
    const p = ready();
    writeJson(p, 'last-tests.json', { ranAt: 'x', tests: [{ file: 'a', name: 'b', status: 'fail' }], fileErrors: [] });
    writeJson(p, 'ui-report.json', { ranAt: 'x', results: [{ id: 'ui:overlap', ok: false }] });
    const r = releaseCheck(p);
    expect(r.ready).toBe(false);
    expect(status(p)).toMatchObject({ tests: 'fail', ui: 'fail' });
    expect(r.gates.find((g) => g.id === 'ui')!.detail).toMatch(/ui:overlap/);
  });
  it('design required once design.json exists; stale sim blocks', () => {
    const p = ready();
    writeJson(p, 'design.json', { version: 1 });
    expect(status(p).design).toBe('missing');
    writeJson(p, 'sim-report.json', { ranAt: new Date(Date.now() + 60_000).toISOString(), assertions: [{ id: 'a', ok: true }] });
    expect(status(p).design).toBe('pass');
    writeJson(p, 'sim-report.json', { ranAt: '2000-01-01T00:00:00Z', assertions: [{ id: 'a', ok: true }] });
    expect(status(p).design).toBe('stale');
  });
  it('multiplayer required when mp specs exist; assets when a manifest exists', () => {
    const p = ready();
    mkdirSync(join(p, 'tests'));
    writeFileSync(join(p, 'tests/x.mp.luau'), '-- @context multiplayer\n');
    writeJson(p, 'assets.json', { version: 1, assets: [] });
    expect(status(p)).toMatchObject({ multiplayer: 'missing', assets: 'missing' });
    writeJson(p, 'mp-report.json', { ranAt: 'x', clients: 2, results: [{ file: 'tests/x.mp.luau', name: 'n', status: 'pass' }], fileErrors: [] });
    writeJson(p, 'asset-report.json', ok(['asset:licence']));
    expect(releaseCheck(p).ready).toBe(true);
  });
  it('assets in use must be approved with a known licence; quarantined tries do not count; place-only packs are flagged', () => {
    const p = ready();
    writeJson(p, 'asset-report.json', ok(['asset:licence']));
    const e = (id: string, extra: Record<string, unknown>) => ({ id, kind: 'model', source: 'creator-store', licence: 'roblox-creator-store', ref: {}, provenance: { tool: 'scout', createdAt: 'x' }, status: 'candidate', ...extra });
    writeJson(p, 'assets.json', { version: 1, assets: [e('tried', { ref: { assetId: 1, path: 'ServerStorage.BloxScout.tried' } })] });
    expect(status(p).provenance).toBe('n/a');
    expect(releaseCheck(p).ready).toBe(true);
    writeJson(p, 'assets.json', { version: 1, assets: [
      e('trees', { ref: { assetId: 2, path: 'Workspace.trees' } }),
      e('icon', { kind: 'image', source: 'external', licence: 'unknown', status: 'approved', ref: { file: 'a.png' }, uploaded: { assetId: 9, operation: 'o', at: 'x' } }),
    ] });
    const r = releaseCheck(p);
    expect(r.ready).toBe(false);
    const g = r.gates.find((x) => x.id === 'provenance')!;
    expect(g.detail).toMatch(/1 in use but not approved: trees/);
    expect(g.detail).toMatch(/1 with unknown licence: icon/);
    expect(r.gates.find((x) => x.id === 'place-only')).toMatchObject({ required: false, status: 'fail' });
    expect(r.gates.find((x) => x.id === 'place-only')!.detail).toMatch(/Workspace\.trees/);
    writeJson(p, 'assets.json', { version: 1, assets: [e('trees', { status: 'approved', ref: { assetId: 2, path: 'Workspace.trees' } })] });
    expect(status(p).provenance).toBe('pass');
    expect(releaseCheck(p).ready).toBe(true);
  });
  // Volcano 2026-10-05: a rejected (and removed) music track still failed provenance and place-only.
  it('rejected assets are not in use unless code still plays them by id; long lists are not cut silently', () => {
    const p = ready();
    writeJson(p, 'asset-report.json', ok(['asset:licence']));
    const e = (id: string, extra: Record<string, unknown>) => ({ id, kind: 'audio', source: 'creator-store', licence: 'roblox-creator-store', ref: {}, provenance: { tool: 'scout', createdAt: 'x' }, status: 'candidate', ...extra });
    writeJson(p, 'assets.json', { version: 1, assets: [e('musicMain', { status: 'rejected', ref: { assetId: 9045295141, path: 'ReplicatedStorage.Sounds.musicMain' } })] });
    let r = releaseCheck(p);
    expect(r.gates.find((x) => x.id === 'provenance')!.status).toBe('n/a');
    expect(r.gates.find((x) => x.id === 'place-only')).toBeUndefined();
    mkdirSync(join(p, 'src'));
    writeFileSync(join(p, 'src/Music.client.luau'), 'local ID = "rbxassetid://9045295141"\n');
    r = releaseCheck(p);
    expect(r.ready).toBe(false);
    expect(r.gates.find((x) => x.id === 'provenance')!.detail).toMatch(/rejected but still used in code: musicMain/);
    writeFileSync(join(p, 'src/Music.client.luau'), '\n');
    writeJson(p, 'assets.json', { version: 1, assets: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => e(id, { ref: { assetId: 100 + i, path: `Workspace.${id}` } })) });
    expect(releaseCheck(p).gates.find((x) => x.id === 'provenance')!.detail).toMatch(/7 in use but not approved: a, b, c, d, e, f, g/);
  });
  // Dog Walk 2026-10-03: sounds stayed quarantined candidates while Menus.client
  // played them by id, so the gate saw "no assets in use" and passed.
  it('assets used by id in code count as in use, even when still quarantined', () => {
    const p = ready();
    writeJson(p, 'asset-report.json', ok(['asset:licence']));
    const e = (id: string, extra: Record<string, unknown>) => ({ id, kind: 'audio', source: 'creator-store', licence: 'roblox-creator-store', ref: {}, provenance: { tool: 'scout', createdAt: 'x' }, status: 'candidate', ...extra });
    writeJson(p, 'assets.json', { version: 1, assets: [
      e('sfxCoin', { ref: { assetId: 113730061669739, path: 'ServerStorage.BloxScout.sfxCoin' } }),
      e('icons', { kind: 'image', source: 'external', licence: 'cc0', status: 'approved', ref: { assetId: 87029758011762, file: 'i.png' }, uploaded: { assetId: 76179550581703, imageId: 87029758011762, operation: 'o', at: 'x' } }),
    ] });
    mkdirSync(join(p, 'src'));
    writeFileSync(join(p, 'src/Menus.client.luau'), 'local SFX = { coin = "rbxassetid://113730061669739" }\nlocal ICONS = "rbxassetid://87029758011762"\n');
    const r = releaseCheck(p);
    expect(r.ready).toBe(false);
    const g = r.gates.find((x) => x.id === 'provenance')!;
    expect(g.status).toBe('fail');
    expect(g.detail).toMatch(/1 in use but not approved: sfxCoin/);
    expect(r.gates.find((x) => x.id === 'code-ids')).toMatchObject({ status: 'pass' });
    // played by id, so the quarantined Sound instance is not needed in the place
    expect(r.gates.find((x) => x.id === 'place-only')).toBeUndefined();
    // a quarantined try that is not used anywhere still does not count
    writeFileSync(join(p, 'src/Menus.client.luau'), 'local ICONS = "rbxassetid://87029758011762"\n');
    expect(status(p).provenance).toBe('pass');
  });
  it('asset ids in code with no manifest entry block the release', () => {
    const p = ready();
    mkdirSync(join(p, 'src'));
    writeFileSync(join(p, 'src/Hud.client.luau'), 'trophy.Image = "rbxassetid://9345770739"\nlocal PRODUCT = 1234567890\n');
    const r = releaseCheck(p);
    expect(r.ready).toBe(false);
    const g = r.gates.find((x) => x.id === 'code-ids')!;
    expect(g).toMatchObject({ required: true, status: 'fail' });
    expect(g.detail).toMatch(/rbxassetid:\/\/9345770739 \(src\/Hud\.client\.luau\)/);
    expect(g.detail).not.toMatch(/1234567890/);
    // a texture inside a tracked pack (found there by asset scan) is covered by the pack
    writeJson(p, 'asset-scan.json', { at: 'x', untracked: [], covered: [9345770739] });
    expect(status(p)['code-ids']).toBe('pass');
    writeFileSync(join(p, 'src/Hud.client.luau'), 'local PRODUCT = 1234567890\n');
    expect(status(p)['code-ids']).toBe('n/a');
    expect(releaseCheck(p).ready).toBe(true);
  });
  it('soak is advisory', () => {
    const p = ready();
    writeJson(p, 'metrics-report.json', ok(['ftue:first-step']));
    expect(status(p).soak).toBe('missing');
    expect(releaseCheck(p).ready).toBe(true);
  });
});
