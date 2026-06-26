import { describe, it, expect, vi } from 'vitest';
import { runOnce } from '../src/run.js';
import type { BloxConfig } from '../src/config.js';

function cfg(over: Partial<BloxConfig> = {}): BloxConfig {
  return {
    projectPath: '/game', model: 'claude-opus-4-8', maxTurns: 40, maxBudgetUsd: 5,
    mode: 'auto', panel: { port: 35768, gateTimeoutSeconds: 120 },
    ...over,
  } as BloxConfig;
}

// Capture the promptCtx runOnce hands to buildQueryOptions, then short-circuit
// the rest of the pipeline (sync/commit) by throwing from runAgent.
async function capturePromptCtx(deps: Record<string, unknown>) {
  const buildMod = await import('../src/agent/buildOptions.js');
  const runMod = await import('../src/agent/runAgent.js');
  let captured: Record<string, unknown> | undefined;
  const buildSpy = vi.spyOn(buildMod, 'buildQueryOptions').mockImplementation(
    ((_c, _b, _d, _g, ctx) => {
      captured = ctx as Record<string, unknown>;
      return {} as never;
    }) as never,
  );
  const runSpy = vi.spyOn(runMod, 'runAgent').mockRejectedValue(new Error('stop'));
  try {
    await runOnce(cfg(), 'do a thing', { bridge: {} as never, digest: {} as never, ...deps }).catch(() => {});
  } finally {
    buildSpy.mockRestore();
    runSpy.mockRestore();
  }
  return captured;
}

describe('runOnce — resume/continue threading', () => {
  it('forwards deps.resume into the prompt context', async () => {
    const ctx = await capturePromptCtx({ resume: 'sess-42' });
    expect(ctx?.resume).toBe('sess-42');
  });

  it('forwards deps.continueSession into the prompt context', async () => {
    const ctx = await capturePromptCtx({ continueSession: true });
    expect(ctx?.continueSession).toBe(true);
  });

  it('leaves both unset for a fresh run', async () => {
    const ctx = await capturePromptCtx({});
    expect(ctx?.resume).toBeUndefined();
    expect(ctx?.continueSession).toBeUndefined();
  });
});
