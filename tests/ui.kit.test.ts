import { describe, it, expect } from 'vitest';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { luneBin, runLuneSpecs } from './helpers/lune.js';

const COMMON = fileURLToPath(new URL('../kits/_common/files/', import.meta.url));

describe.skipIf(!luneBin())('BloxUI (offline, @lune/roblox instances)', () => {
  it('blox_ui.spec passes', () => {
    const d = mkdtempSync(join(tmpdir(), 'blox-ui-kit-'));
    cpSync(COMMON, d, { recursive: true });
    const r = runLuneSpecs(d, ['tests/blox_ui.spec.luau']);
    expect(r.fileErrors).toEqual([]);
    expect(r.results.filter((t) => t.status !== 'pass')).toEqual([]);
    expect(r.results.length).toBe(6);
  });
});
