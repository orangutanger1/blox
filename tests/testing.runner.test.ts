import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { specContext, discoverSpecs, testProgram, mapSpecPositions, type SpecFile } from '../src/testing/runner.js';
import { foldLogs, summarizeLogs, isNoise } from '../src/studio/play.js';

describe('specContext', () => {
  it('reads the @context directive (default edit)', () => {
    expect(specContext('-- @context server\ntest()')).toBe('server');
    expect(specContext('--@context client')).toBe('client');
    expect(specContext('test()')).toBe('edit');
  });
});

describe('discoverSpecs', () => {
  it('finds nested *.spec.luau and applies filter', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-specs-'));
    mkdirSync(join(dir, 'tests', 'ui'), { recursive: true });
    writeFileSync(join(dir, 'tests', 'a.spec.luau'), 'x');
    writeFileSync(join(dir, 'tests', 'ui', 'hud.spec.luau'), '-- @context client');
    writeFileSync(join(dir, 'tests', 'helper.luau'), 'x');
    expect(discoverSpecs(dir).map((s) => [s.file, s.context])).toEqual([['tests/a.spec.luau', 'edit'], ['tests/ui/hud.spec.luau', 'client']]);
    expect(discoverSpecs(dir, 'tests', 'hud')).toHaveLength(1);
  });
});

describe('testProgram + mapSpecPositions', () => {
  const specs: SpecFile[] = [
    { file: 'tests/a.spec.luau', context: 'edit', source: 'test("a", function()\n\texpect(1).toBe(2)\nend)\n' },
    { file: 'tests/b.spec.luau', context: 'edit', source: 'local x = 1\ntest("b", function()\n\terror("nope")\nend)' },
  ];
  const { code, specLines } = testProgram(specs, 5);
  const lines = code.split('\n');
  it('inlines each spec at the recorded user line', () => {
    expect(lines[specLines[0] - 1]).toBe('test("a", function()');
    expect(lines[specLines[1] - 1]).toBe('local x = 1');
  });
  it('maps absolute and chunk-relative positions back to spec files', () => {
    const off = 50;
    const absA = specLines[0] + 1 + off;
    expect(mapSpecPositions(`AssistantCommand:${absA}: expected 2, got 1`, specs, specLines, off, '<t>')).toBe('tests/a.spec.luau:2: expected 2, got 1');
    expect(mapSpecPositions(`<t>:${specLines[1] + 2}: nope`, specs, specLines, off, '<t>')).toBe('tests/b.spec.luau:3: nope');
  });
});

describe('log folding', () => {
  it('folds stack lines into the error and counts duplicates', () => {
    const f = foldLogs([
      { level: 'error', message: 'boom' },
      { level: 'info', message: 'Stack Begin' },
      { level: 'info', message: "Script 'X', Line 3" },
      { level: 'info', message: 'Stack End' },
      { level: 'warning', message: 'w' },
      { level: 'warning', message: 'w' },
    ], 'server');
    expect(f).toHaveLength(2);
    expect(f[0].message).toBe("boom\n  Script 'X', Line 3");
    expect(f[1].count).toBe(2);
  });
  it('flags environment noise and keeps it out of summaries', () => {
    expect(isNoise("The experience doesn't have access permission to use asset id 1")).toBe(true);
    const s = summarizeLogs(foldLogs([
      { level: 'error', message: "The experience doesn't have access permission to use asset id 1" },
      { level: 'error', message: 'real' },
    ], 'client'));
    expect(s.errors.map((e) => e.message)).toEqual(['real']);
    expect(s.noise).toBe(1);
  });
});
