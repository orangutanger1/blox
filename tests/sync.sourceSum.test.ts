import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { luneBin, runLune } from './helpers/lune.js';
import { SOURCE_SUM_LUAU, sourceSum as fnv1a } from '../src/sync/push.js';

describe.skipIf(!luneBin())('sync source checksum (Luau)', () => {
  it('is 32-bit FNV-1a', () => {
    const big = 'x'.repeat(10_000) + 'y';
    const f = join(mkdtempSync(join(tmpdir(), 'blox-sum-')), 'sum.luau');
    writeFileSync(f, `${SOURCE_SUM_LUAU}\nprint(__bloxSum(""), __bloxSum("a"), __bloxSum("foobar"), __bloxSum("héllo ✓"), __bloxSum(string.rep("x", 10000) .. "y"), __bloxSum(string.rep("x", 10000) .. "z"))\n`);
    const [empty, a, foobar, utf, b1, b2] = runLune(f, []).trim().split(/\s+/);
    expect([empty, a, foobar]).toEqual(['811c9dc5', 'e40c292c', 'bf9cf968']);
    expect(utf).toBe(fnv1a('héllo ✓'));
    expect(b1).toBe(fnv1a(big));
    expect(b2).not.toBe(b1);
  });
});

