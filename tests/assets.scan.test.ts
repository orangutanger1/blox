import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { riskFindings, runSanitize, sanitizeProgram, gradeSanitize, SCAN_LUAU, untrackedFromScan } from '../src/assets/scan.js';
import { StudioSession } from '../src/studio/session.js';
import { fakeStudio } from './fakeStudio.js';
import { luneBin, luneCheck } from './helpers/lune.js';

describe('riskFindings', () => {
  it('flags classic free-model backdoors', () => {
    expect(riskFindings('require(4513275925)')).toEqual(['require(<asset id>) loads remote code']);
    expect(riskFindings('local f = getfenv(0)')).toContain('getfenv/setfenv environment tampering');
    expect(riskFindings('game:GetService("HttpService"):GetAsync(u)')).toContain('HttpService (network access)');
    expect(riskFindings('player:Kick("bye")')).toEqual(['kicks players']);
    expect(riskFindings('local s = "\\104\\101\\108\\108\\111\\032\\119\\111\\114"')).toEqual(['string.char / escape obfuscation']);
    expect(riskFindings('x'.repeat(1200))).toEqual(['very long line (packed/obfuscated code)']);
  });
  it('leaves ordinary scripts alone', () => {
    expect(riskFindings('local door = script.Parent\ndoor.Touched:Connect(function() door.Transparency = 0.5 end)')).toEqual([]);
    expect(riskFindings('local m = require(script.Parent.Module)')).toEqual([]);
  });
});

describe('runSanitize', () => {
  // Live 2026-10-03: a 64-MeshPart obby template's script sources overflowed
  // execute_luau's reply (~50-100KB) and the JSON came back cut off.
  it('reads sources in chunks and strips only on the last chunk', async () => {
    const env = (v: unknown) => JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] });
    const all = [0, 1, 2, 3, 4].map((i) => ({ path: `W.T.S${i}`, class: 'Script', source: i === 3 ? 'loadstring("x")' : `print(${i})` }));
    const codes: string[] = [];
    const f = fakeStudio({
      luau: (code) => {
        codes.push(code);
        const skip = Number(/local SKIP = (\d+)/.exec(code)![1]);
        const last = skip + 2 >= all.length;
        return env(JSON.stringify({ path: 'W.T', parts: 4, meshParts: 1, textures: 0, guis: 2, screenGuis: 1, sounds: 0, size: [9, 8, 7], removed: last && code.includes('local KEEP = false') ? all.length : 0, scripts: all.slice(skip, skip + 2), next: last ? null : skip + 2 }));
      },
    });
    const session = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
    const r = await runSanitize(session, 'W.T', false);
    expect(codes.length).toBe(3);
    expect(r.scripts.map((s) => s.path)).toEqual(all.map((s) => s.path));
    expect(r.scripts[3].findings).toEqual(['loadstring']);
    expect(r).toMatchObject({ removed: 5, parts: 4, guis: 2, screenGuis: 1, size: [9, 8, 7] });
  });
  it('program removes scripts only when no source is left unread', () => {
    const p = sanitizeProgram('W.T', false, 3);
    expect(p).toContain('local SKIP = 3');
    expect(p).toMatch(/if nextSkip == nil and not KEEP then/);
  });
});

describe('gradeSanitize + untracked', () => {
  it('grades collected sources', () => {
    const r = gradeSanitize(JSON.stringify({ path: 'Workspace.Tree', removed: 2, parts: 10, meshParts: 3, textures: 1, scripts: [{ path: 'Workspace.Tree.S', class: 'Script', source: 'require(123456789)' }, { path: 'Workspace.Tree.T', class: 'Script', source: 'print(1)' }] }));
    expect(r.scripts.map((s) => s.findings.length)).toEqual([1, 0]);
    expect(r.removed).toBe(2);
  });
  it('untracked ids are those not in the manifest', () => {
    const scan = JSON.stringify([{ id: 1, where: 'Workspace.A.MeshId', count: 1 }, { id: 2, where: 'Workspace.B.Image', count: 3 }]);
    const m = { version: 1 as const, assets: [{ id: 'a', kind: 'mesh' as const, source: 'external' as const, licence: 'owned' as const, ref: {}, provenance: { tool: 'x', createdAt: 'y' }, status: 'approved' as const, uploaded: { assetId: 1, operation: 'o', at: 't' } }] };
    expect(untrackedFromScan(scan, m)).toEqual([{ id: 'rbxassetid://2', where: 'Workspace.B.Image (+2 more)' }]);
    expect(untrackedFromScan('{}', m)).toEqual([]);
  });
  it('ids referenced inside a tracked model belong to that entry', () => {
    // Live: a sanitized Creator Store crate's own MeshIds were flagged untracked.
    const scan = JSON.stringify([{ id: 7, where: 'Workspace.Crate.Model.Boards.MeshId', count: 1 }, { id: 8, where: 'Workspace.CrateOther.MeshId', count: 1 }]);
    const m = { version: 1 as const, assets: [{ id: 'c', kind: 'model' as const, source: 'creator-store' as const, licence: 'roblox-creator-store' as const, ref: { assetId: 5, path: 'Workspace.Crate' }, provenance: { tool: 'x', createdAt: 'y' }, status: 'candidate' as const }] };
    expect(untrackedFromScan(scan, m)).toEqual([{ id: 'rbxassetid://8', where: 'Workspace.CrateOther.MeshId' }]);
  });
  it.skipIf(!luneBin())('Luau programs compile', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-scan-'));
    writeFileSync(join(d, 'scan.luau'), SCAN_LUAU);
    writeFileSync(join(d, 'san.luau'), sanitizeProgram('Workspace.Tree', false));
    expect(luneCheck([join(d, 'scan.luau'), join(d, 'san.luau')])).toEqual([]);
  });
});
