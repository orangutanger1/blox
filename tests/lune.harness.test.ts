import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { luneBin, luneCheck, runLuneSpecs } from './helpers/lune.js';

describe.skipIf(!luneBin())('lune spec harness', () => {
  it('runs edit specs against src/ modules and reports pass, fail and file errors', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-lune-'));
    mkdirSync(join(d, 'src/ReplicatedStorage/Lib'), { recursive: true });
    mkdirSync(join(d, 'tests'));
    writeFileSync(join(d, 'src/ReplicatedStorage/Lib/Add.luau'), 'return function(a, b) return a + b end\n');
    writeFileSync(
      join(d, 'tests/a.spec.luau'),
      `-- @context edit
local Add = require(game:GetService("ReplicatedStorage").Lib.Add)
describe("add", function()
	test("works", function() expect(Add(1, 2)).toBe(3) end)
	test("fails", function() expect(Add(1, 2)).toBe(4) end)
end)
test("missing module", function()
	expect(function() return require(game:GetService("ReplicatedStorage").Lib.Nope) end).toThrow("no module at")
end)
`,
    );
    writeFileSync(join(d, 'tests/b.spec.luau'), '-- @context edit\nlocal x = \n');
    const r = runLuneSpecs(d, ['tests/a.spec.luau', 'tests/b.spec.luau']);
    expect(r.results.map((t) => [t.name, t.status])).toEqual([
      ['add > works', 'pass'],
      ['add > fails', 'fail'],
      ['missing module', 'pass'],
    ]);
    expect(r.results[1].message).toMatch(/expected 4, got 3/);
    expect(r.fileErrors.map((e) => e.file)).toEqual(['tests/b.spec.luau']);
    expect(luneCheck([join(d, 'tests/a.spec.luau'), join(d, 'tests/b.spec.luau')])).toHaveLength(1);
  });
});

describe.skipIf(!luneBin())('lune spec harness matchers', () => {
  it('has inclusive comparison matchers', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-lune-'));
    mkdirSync(join(d, 'tests'));
    writeFileSync(
      join(d, 'tests/c.spec.luau'),
      `-- @context edit
test("le", function() expect(2).toBeLessThanOrEqual(2) end)
test("le fails", function() expect(3).toBeLessThanOrEqual(2) end)
test("ge", function() expect(2).toBeGreaterThanOrEqual(2) end)
`,
    );
    const r = runLuneSpecs(d, ['tests/c.spec.luau']);
    expect(r.results.map((t) => t.status)).toEqual(['pass', 'fail', 'pass']);
    expect(r.results[1].message).toMatch(/expected <= 2, got 3/);
  });
});
