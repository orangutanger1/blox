import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeAssetRefs } from '../src/assets/codeRefs.js';

function project(files: Record<string, string>): string {
  const p = mkdtempSync(join(tmpdir(), 'blox-coderefs-'));
  for (const [f, src] of Object.entries(files)) {
    mkdirSync(join(p, f, '..'), { recursive: true });
    writeFileSync(join(p, f), src);
  }
  return p;
}

describe('codeAssetRefs', () => {
  it('finds explicit asset urls and bare ids, with the files that use them', () => {
    const p = project({
      'src/client/Hud.client.luau': 'img.Image = "rbxassetid://87029758011762"\nlocal SFX = { coin = 113730061669739 }\n',
      'src/server/Main.server.lua': 's.SoundId = "http://www.roblox.com/asset/?id=8807960350"\nt.Image = "rbxthumb://type=Asset&id=555666777&w=150&h=150"\n',
      'world/Park.luau': 'local n = 12 local big = 1234\n',
    });
    const r = codeAssetRefs(p);
    expect([...r.explicit.keys()].sort((a, b) => a - b)).toEqual([555666777, 8807960350, 87029758011762]);
    expect(r.explicit.get(87029758011762)).toEqual(['src/client/Hud.client.luau']);
    expect(r.numbers.has(113730061669739)).toBe(true);
    expect(r.numbers.has(87029758011762)).toBe(true);
    expect(r.numbers.has(12)).toBe(false);
    expect(r.numbers.has(1234)).toBe(false);
    expect(r.files.get(113730061669739)).toEqual(['src/client/Hud.client.luau']);
  });
  it('skips comments, dot dirs, node_modules and non-luau files', () => {
    const p = project({
      'src/a.luau': '-- old: rbxassetid://111111111\n--[[ rbxassetid://222222222 ]]\nlocal x = 1\n',
      '.blox/x.luau': 'rbxassetid://333333333',
      'node_modules/m/x.luau': 'rbxassetid://444444444',
      'src/notes.md': 'rbxassetid://555555555',
    });
    const r = codeAssetRefs(p);
    expect(r.explicit.size).toBe(0);
    expect(r.numbers.size).toBe(0);
  });
  it('keeps ids inside strings that contain -- and long strings', () => {
    const p = project({ 'src/a.luau': 'local s = "a--b rbxassetid://123456789"\nlocal t = [==[ rbxassetid://987654321 ]==] -- 111111111\n' });
    const r = codeAssetRefs(p);
    expect([...r.explicit.keys()].sort((a, b) => a - b)).toEqual([123456789, 987654321]);
    expect(r.numbers.has(111111111)).toBe(false);
  });
  it('ignores specs under tests/', () => {
    expect(codeAssetRefs(project({ 'tests/a.spec.luau': 'rbxassetid://123456789' })).explicit.size).toBe(0);
  });
});
