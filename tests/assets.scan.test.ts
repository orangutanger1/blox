import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { riskFindings, runSanitize, sanitizeProgram, gradeSanitize, scanProgram, untrackedFromScan, coveredFromScan } from '../src/assets/scan.js';
import { StudioSession } from '../src/studio/session.js';
import { fakeStudio } from './fakeStudio.js';
import { luneBin, luneCheck, runLune } from './helpers/lune.js';

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
  it('a script cut at the budget is a finding (its tail was never scanned)', async () => {
    const env = (v: unknown) => JSON.stringify({ ok: true, n: 1, values: { v1: v }, logs: [] });
    const f = fakeStudio({ luau: () => env(JSON.stringify({ path: 'W.T', parts: 1, removed: 0, scripts: [{ path: 'W.T.Big', class: 'Script', source: 'print(1)', cut: true }], next: null })) });
    const session = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
    const r = await runSanitize(session, 'W.T', true);
    expect(r.scripts[0].findings).toEqual([expect.stringMatching(/longer than 20000 characters: only the start was scanned/)]);
    expect(sanitizeProgram('W.T', true)).toMatch(/cut = cost > BUDGET/);
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
  // Dog Walk: Park.luau clones a pack's mesas into Workspace, so an id's first
  // location is outside the pack; the scan flags ids seen anywhere inside one.
  it('an id seen anywhere inside a tracked model is covered by it', () => {
    const scan = JSON.stringify([{ id: 7, where: 'Workspace.Mesa.MeshPart.TextureID', count: 4, tracked: true }, { id: 8, where: 'Workspace.Other.MeshId', count: 1 }]);
    const m = { version: 1 as const, assets: [{ id: 'c', kind: 'model' as const, source: 'creator-store' as const, licence: 'roblox-creator-store' as const, ref: { assetId: 5, path: 'ServerStorage.Pack' }, provenance: { tool: 'x', createdAt: 'y' }, status: 'approved' as const }] };
    expect(untrackedFromScan(scan, m).map((u) => u.id)).toEqual(['rbxassetid://8']);
    expect(coveredFromScan(scan, m)).toEqual([7]);
    expect(scanProgram(['ServerStorage.Pack', 'Workspace."q"'])).toContain('local TRACKED = { "ServerStorage.Pack.", "Workspace.\\"q\\"." }');
  });
  it.skipIf(!luneBin())('sanitize chunks by JSON-escaped size in a real DataModel (Lune)', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-san-run-'));
    const budget = 100;
    const programs = [0, 1, 2, 3].map((skip) => sanitizeProgram('Workspace.Tree', false, skip, budget).replace('local HttpService = game:GetService("HttpService")', 'local HttpService = __HS'));
    programs.forEach((p, i) => writeFileSync(join(d, `p${i}.luau`), p));
    writeFileSync(join(d, 'run.luau'), `
local roblox = require("@lune/roblox")
local luau = require("@lune/luau")
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local process = require("@lune/process")
local game = roblox.Instance.new("DataModel")
local m = roblox.Instance.new("Model") m.Name = "Tree" m.Parent = game:GetService("Workspace")
local function script(name, src) local s = roblox.Instance.new("Script") s.Name = name s.Source = src s.Parent = m end
script("Ctl", string.rep("\\1", 15)) -- 15 bytes, 90 once escaped
script("Plain", string.rep("a", 30))
script("Long", string.rep("b", 150))
local HS = { JSONEncode = function(_, v) return serde.encode("json", v) end }
local skip = tonumber(process.args[1])
local fn = luau.load(fs.readFile(process.args[2]), { environment = setmetatable({ game = game, __HS = HS }, { __index = getfenv() }) })
print(fn())
`);
    let skip = 0;
    const chunks: { scripts: { path: string; source: string; cut: boolean }[]; next: number | null; removed: number }[] = [];
    for (let i = 0; i < 4; i++) {
      const out = runLune(join(d, 'run.luau'), [String(skip), join(d, `p${skip}.luau`)]).trim();
      const c = JSON.parse(out);
      chunks.push(c);
      const escaped = (Array.isArray(c.scripts) ? c.scripts : []).reduce((n: number, x: { source: string }) => n + JSON.stringify(x.source).length - 2, 0);
      expect(escaped).toBeLessThanOrEqual(budget);
      if (c.next === null || c.next === undefined) break;
      skip = c.next;
    }
    const names = chunks.flatMap((c) => (Array.isArray(c.scripts) ? c.scripts : []).map((x) => x.path.split('.').pop()));
    expect(names).toEqual(['Ctl', 'Plain', 'Long']);
    const long = chunks.flatMap((c) => (Array.isArray(c.scripts) ? c.scripts : [])).find((x) => x.path.endsWith('Long'))!;
    expect(long.cut).toBe(true);
    expect(chunks[chunks.length - 1].removed).toBe(3);
  });
  it.skipIf(!luneBin())('Luau programs compile', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-scan-'));
    writeFileSync(join(d, 'scan.luau'), scanProgram(['Workspace.Crate']));
    writeFileSync(join(d, 'san.luau'), sanitizeProgram('Workspace.Tree', false));
    expect(luneCheck([join(d, 'scan.luau'), join(d, 'san.luau')])).toEqual([]);
  });
});
