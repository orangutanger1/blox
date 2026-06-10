import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pullScripts } from '../../src/onboard/pull.js';
import { planLayout } from '../../src/onboard/layout.js';
import { writePlan } from '../../src/onboard/write.js';
import { studioLauncher } from '../../src/bridge/mcpBridge.js';
import { buildDigest } from '../../src/context/digest.js';

// Requires: a live Studio attached with a place open + MCP server enabled.
// Gated; self-skips without the env flag.
// Run: BLOX_LIVE_ONBOARD=1 npx vitest run tests/e2e/live-onboard.test.ts
const RUN = process.env.BLOX_LIVE_ONBOARD === '1';

describe.runIf(RUN)('blox init against a live Studio', () => {
  it('pulls scripts, writes a Rojo project, and buildDigest succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-live-onboard-'));
    const scripts = await pullScripts(studioLauncher());
    expect(scripts.length).toBeGreaterThan(0);
    const plan = planLayout(scripts, 'suffix', 'live');
    const result = await writePlan(dir, plan, { force: false });
    expect(result.written.length).toBeGreaterThan(0);
    expect(() => buildDigest(dir)).not.toThrow();
  }, 120_000);
});
