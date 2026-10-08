import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudioSession } from '../src/studio/session.js';
import { runMultiplayer, formatMp } from '../src/multiplayer/run.js';
import { fakeStudio } from './fakeStudio.js';

const port = () => 38000 + Math.floor(Math.random() * 2000);
const ok = JSON.stringify({ ok: true, n: 1, values: { v1: true }, logs: [] });
// The run token the harness install wrote into the place (the real plugin reads it back from ServerStorage).
let placeToken = '';

function setup(mode: 'Edit' | 'Play' = 'Edit') {
  const p = mkdtempSync(join(tmpdir(), 'blox-mprun-'));
  mkdirSync(join(p, 'tests'));
  writeFileSync(join(p, 'tests/a.mp.luau'), '-- @context multiplayer\n-- @clients 3\ntest("x", function()\n\texpect(1).toBe(2)\nend)\n');
  const calls: string[] = [];
  const f = fakeStudio({
    mode,
    luau: (code) => { placeToken = /"token":"([^"]+)"/.exec(code)?.[1] ?? placeToken; calls.push(code.includes('Instance.new("Folder")') && code.includes('BloxMpRun') ? 'install' : code.includes('__BloxMp') ? 'cleanup' : 'other'); return ok; },
    // Scripts are created with multi_edit (Studio capability sandbox).
    tools: { multi_edit: (a) => { calls.push(`script ${String(a.file_path)} ${String(a.className)}`); return 'Created'; } },
  });
  const session = new StudioSession({ launch: { command: 'x', args: [] }, connector: async () => f.client, sleep: async () => {}, attachTimeoutMs: 0 });
  return { p, calls, session };
}

async function plugin(lane: number, result: (clients: number) => unknown) {
  for (let i = 0; i < 300; i++) {
    const j = (await fetch(`http://127.0.0.1:${lane}/lane/job?mp=${placeToken}`).then((r) => r.json(), () => ({}))) as { id?: string; clients: number };
    if (j.id) {
      await fetch(`http://127.0.0.1:${lane}/lane/result`, { method: 'POST', body: JSON.stringify({ id: j.id, ok: true, result: result(j.clients) }) });
      return;
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

const SCRIPTS = [
  'script game.ServerStorage.__BloxMp.Specs ModuleScript',
  'script game.ServerScriptService.__BloxMpHarness Script',
  'script game.StarterPlayer.StarterPlayerScripts.__BloxMpClient LocalScript',
];

describe('runMultiplayer', () => {
  it('installs, hands the job to the plugin, maps failure lines, and cleans up', async () => {
    const s = setup();
    const lane = port();
    let asked = 0;
    const pl = plugin(lane, (n) => {
      asked = n;
      return JSON.stringify({ ok: true, players: n, results: [{ file: 'tests/a.mp.luau', name: 'x', status: 'fail', message: 'ServerStorage.__BloxMp.Specs:7: expected 2, got 1' }], fileErrors: [] });
    });
    const r = await runMultiplayer(s.session, s.p, { lanePort: lane, pickupMs: 3000 });
    await pl;
    expect(asked).toBe(3);
    expect(s.calls).toEqual(['install', ...SCRIPTS, 'cleanup']);
    expect(r.results[0].message).toBe('tests/a.mp.luau:4: expected 2, got 1');
    expect(formatMp(r)).toMatch(/^multiplayer \(3 clients\): 0\/1 passed/);
  });
  it('harness errors and StudioTestService failures are reported', async () => {
    const s = setup();
    const lane = port();
    const pl = plugin(lane, () => JSON.stringify({ ok: false, error: 'only 1/2 clients joined' }));
    const r = await runMultiplayer(s.session, s.p, { lanePort: lane, pickupMs: 3000, clients: 2 });
    await pl;
    expect(r.error).toMatch(/only 1\/2/);
  });
  it('no plugin: readable error and cleanup still runs', async () => {
    const s = setup();
    await expect(runMultiplayer(s.session, s.p, { lanePort: port(), pickupMs: 100 })).rejects.toThrow(/dock plugin did not pick up/);
    expect(s.calls).toEqual(['install', ...SCRIPTS, 'cleanup']);
  });
  it('requires edit mode and specs', async () => {
    await expect(runMultiplayer(setup('Play').session, setup().p)).rejects.toThrow(/stop the playtest/);
    const empty = mkdtempSync(join(tmpdir(), 'blox-mp-empty-'));
    await expect(runMultiplayer(setup().session, empty)).rejects.toThrow(/no multiplayer specs/);
  });
});

import { cliArgs, parseFlags } from '../src/cliTools.js';
describe('cli mapping', () => {
  it('blox multiplayer [filter] --clients N', () => {
    expect(cliArgs('multiplayer', parseFlags(['theft', '--clients', '4']))).toEqual({ tool: 'multiplayer', args: { filter: 'theft', clients: 4 } });
    expect(cliArgs('multiplayer', parseFlags([]))).toEqual({ tool: 'multiplayer', args: {} });
  });
});
