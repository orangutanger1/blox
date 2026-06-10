import { describe, it, expect } from 'vitest';
import { buildQueryOptions } from '../../src/agent/buildOptions.js';
import { runAgent } from '../../src/agent/runAgent.js';
import { createMockStudioBridge } from '../../src/bridge/mockBridge.js';
import { loadConfig } from '../../src/config.js';
import type { ProjectDigest } from '../../src/context/digest.js';

const RUN = process.env.BLOX_E2E === '1';

describe.runIf(RUN)('--ask gates asset generation (live)', () => {
  it('stops gated when the agent reaches generate_mesh', async () => {
    const config = loadConfig(process.cwd(), { mode: 'ask', maxTurns: 8, maxBudgetUsd: 1 });
    const digest: ProjectDigest = { name: 'g', tree: [], scripts: [], groups: [] };
    const options = buildQueryOptions(config, createMockStudioBridge(), digest);
    const r = await runAgent(
      'Generate a mesh of a small rock and insert it into Workspace. Use the generate_mesh tool.',
      options,
    );
    expect(r.stopReason).toBe('gated');
    expect(r.gatedActions.some((g) => g.tool.includes('generate'))).toBe(true);
    expect(typeof r.sessionId).toBe('string');
  }, 120_000);
});
