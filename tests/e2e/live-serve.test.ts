import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { ensureServe, stopServe, serveUrl, rojoServePort } from '../../src/sync/serve.js';
import { checkRojoServe } from '../../src/sync/serveCheck.js';

// Requires: real rojo on PATH, NO serve already on the port. No Studio/plugin needed.
const enabled = process.env.BLOX_LIVE_SERVE === '1';
const project = resolve(__dirname, '../../test-fixtures/game');

describe.skipIf(!enabled)('blox-managed rojo serve lifecycle', () => {
  it('spawns a real serve, becomes reachable, then tears it down', async () => {
    const url = serveUrl(rojoServePort());
    const pre = await checkRojoServe(url);
    expect(pre.reachable).toBe(false); // test requires no pre-existing serve

    const session = await ensureServe(project, { attempts: 20, delayMs: 500 });
    try {
      expect(session.mode).toBe('spawned');
      const up = await checkRojoServe(url);
      expect(up.reachable).toBe(true);
    } finally {
      await stopServe(session);
    }

    // Port is free again after teardown (retry a few times for OS release).
    let down = false;
    for (let i = 0; i < 6 && !down; i++) {
      down = !(await checkRojoServe(url)).reachable;
      if (!down) await new Promise((r) => setTimeout(r, 500));
    }
    expect(down).toBe(true);
  }, 60_000);
});
