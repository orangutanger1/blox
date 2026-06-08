import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { probeExecuteLuau } from '../../src/doctor.js';

// Requires: rojo serve running on the fixture + Rojo plugin connected + live Studio.
const enabled = process.env.BLOX_LIVE_SYNC === '1';
const greeter = resolve(__dirname, '../../test-fixtures/game/src/ReplicatedStorage/Greeter.luau');

describe.skipIf(!enabled)('live Rojo file sync', () => {
  it('propagates a WSL edit into Studio (execute_luau reads .Source)', async () => {
    const original = readFileSync(greeter, 'utf8');
    const marker = `SYNC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
    try {
      writeFileSync(greeter, original.replace('return Greeter', `-- ${marker}\nreturn Greeter`));
      // Retry absorbs both the MCP attach race and the Rojo sync settle.
      let found = false;
      for (let i = 0; i < 6 && !found; i++) {
        const r = await probeExecuteLuau(
          studioLauncher(),
          'return game.ReplicatedStorage.Greeter.Source',
          undefined,
          { probeAttempts: 10, probeDelayMs: 500 },
        );
        found = r.attached && r.text.includes(marker);
        if (!found) await new Promise((res) => setTimeout(res, 1000));
      }
      expect(found).toBe(true);
    } finally {
      writeFileSync(greeter, original);
    }
  }, 60_000);
});
