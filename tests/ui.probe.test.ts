import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uiProbeProgram, parseProbe } from '../src/ui/probe.js';
import { DEVICES } from '../src/ui/lint.js';
import { luneBin, luneCheck } from './helpers/lune.js';

describe('ui probe', () => {
  it('embeds the device table and returns JSON', () => {
    const code = uiProbeProgram(DEVICES.slice(0, 1));
    expect(code).toContain('phone-landscape');
    expect(code).toContain('return HttpService:JSONEncode');
  });
  it('skips Roblox-injected GUIs (legacy chat etc.)', () => {
    expect(uiProbeProgram(DEVICES.slice(0, 1))).toMatch(/ENGINE_GUIS = \{ Chat = true/);
  });
  it.skipIf(!luneBin())('generated program compiles', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-probe-')), 'probe.luau');
    writeFileSync(f, uiProbeProgram(DEVICES));
    expect(luneCheck([f])).toEqual([]);
  });
  it('parseProbe normalises empty device lists', () => {
    expect(parseProbe(JSON.stringify({ sources: 1, devices: { desktop: {}, tablet: [{ path: 'A' }] } }))).toEqual({ sources: 1, devices: { desktop: [], tablet: [{ path: 'A' }] } });
    expect(() => parseProbe(undefined)).toThrow(/no data/);
  });
});
