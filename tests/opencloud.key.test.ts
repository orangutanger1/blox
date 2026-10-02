import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCloudKey } from '../src/opencloud/client.js';

function cfg(content?: string): NodeJS.ProcessEnv {
  const xdg = mkdtempSync(join(tmpdir(), 'blox-ockey-'));
  if (content !== undefined) {
    mkdirSync(join(xdg, 'blox'));
    writeFileSync(join(xdg, 'blox', 'opencloud.env'), content);
  }
  return { XDG_CONFIG_HOME: xdg };
}

describe('openCloudKey', () => {
  it('env var wins', () => {
    expect(openCloudKey({ ...cfg('export ROBLOX_OPEN_CLOUD_KEY=fromfile\n'), ROBLOX_OPEN_CLOUD_KEY: 'fromenv' })).toBe('fromenv');
  });
  it('falls back to ~/.config/blox/opencloud.env (export form, quotes ok)', () => {
    expect(openCloudKey(cfg('export ROBLOX_OPEN_CLOUD_KEY=abc123=\n'))).toBe('abc123=');
    expect(openCloudKey(cfg('# key\nROBLOX_OPEN_CLOUD_KEY="q-key"\n'))).toBe('q-key');
  });
  it('no env and no file → undefined', () => {
    expect(openCloudKey(cfg())).toBeUndefined();
    expect(openCloudKey(cfg('OTHER=1\n'))).toBeUndefined();
  });
});
