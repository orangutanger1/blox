import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverMpSpecs, specsModule, installProgram, HARNESS_SOURCE, CLIENT_SOURCE, CLEANUP } from '../src/multiplayer/program.js';
import { luneBin, luneCheck } from './helpers/lune.js';

function project(files: Record<string, string>): string {
  const p = mkdtempSync(join(tmpdir(), 'blox-mp-'));
  for (const [f, s] of Object.entries(files)) {
    mkdirSync(join(p, f, '..'), { recursive: true });
    writeFileSync(join(p, f), s);
  }
  return p;
}
const SPEC = '-- @context multiplayer\ntest("two players", function() expect(#mp.players).toBe(2) end)\n';

describe('discoverMpSpecs', () => {
  it('finds *.mp.luau only, applies filter and the max @clients header (capped at 8)', () => {
    const p = project({ 'tests/a.mp.luau': SPEC, 'tests/sub/b.mp.luau': '-- @context multiplayer\n-- @clients 4\n', 'tests/c.spec.luau': '-- @context server\n' });
    expect(discoverMpSpecs(p)).toMatchObject({ clients: 4, specs: [{ file: 'tests/a.mp.luau' }, { file: 'tests/sub/b.mp.luau' }] });
    expect(discoverMpSpecs(p, 'a.mp').clients).toBe(2);
    expect(discoverMpSpecs(project({ 'tests/x.mp.luau': '-- @clients 20\n' })).clients).toBe(8);
    expect(discoverMpSpecs(project({})).specs).toEqual([]);
  });
});

describe('generated Luau', () => {
  it('spec module passes mp to every spec', () => {
    const p = project({ 'tests/a.mp.luau': SPEC });
    const m = specsModule(discoverMpSpecs(p).specs, 30);
    expect(m.source.startsWith('return function(mp)\n')).toBe(true);
    expect(m.source).toContain('function(test, it, describe, expect, waitFor, mp)');
    expect(m.source).toContain('pcall(specFn, test, test, describe, expect, waitFor, mp)');
    expect(m.source.split('\n')[m.specLines[0] - 1]).toBe('-- @context multiplayer');
  });
  it.skipIf(!luneBin())('every injected source compiles', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-mpsrc-'));
    const p = project({ 'tests/a.mp.luau': SPEC });
    const files = {
      'specs.luau': specsModule(discoverMpSpecs(p).specs, 30).source,
      'harness.luau': HARNESS_SOURCE,
      'client.luau': CLIENT_SOURCE,
      'cleanup.luau': CLEANUP,
      'install.luau': installProgram({ clients: 2, joinTimeout: 60, token: 't' }),
    };
    for (const [f, s] of Object.entries(files)) writeFileSync(join(d, f), s);
    expect(luneCheck(Object.keys(files).map((f) => join(d, f)))).toEqual([]);
  });
});

describe.skipIf(!luneBin())('plugin + kit mp spec', () => {
  it('compile under Luau', () => {
    const files = ['plugin/src/init.server.luau', 'kits/incremental/files/tests/kit_multiplayer.mp.luau', 'kits/steal/files/tests/kit_steal.mp.luau'].map((f) => join(process.cwd(), f));
    expect(luneCheck(files)).toEqual([]);
  });
});
