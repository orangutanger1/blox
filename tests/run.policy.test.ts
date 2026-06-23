import { describe, it, expect, vi } from 'vitest';
import { runOnce } from '../src/run.js';
import { PolicyError } from '../src/policy.js';
import type { BloxConfig } from '../src/config.js';

function cfg(over: Partial<BloxConfig> = {}): BloxConfig {
  return {
    projectPath: '/game', model: 'deepseek', maxTurns: 40, maxBudgetUsd: 5,
    mode: 'auto', panel: { port: 35768, gateTimeoutSeconds: 120 },
    policy: { models: ['claude-opus-4-8'] },
    ...over,
  } as BloxConfig;
}

describe('runOnce policy gate', () => {
  it('throws PolicyError before running the agent when policy is violated', async () => {
    const runAgent = await import('../src/agent/runAgent.js');
    const spy = vi.spyOn(runAgent, 'runAgent');
    await expect(
      runOnce(cfg(), 'do a thing', { bridge: {} as never, digest: {} as never }),
    ).rejects.toBeInstanceOf(PolicyError);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
