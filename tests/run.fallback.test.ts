import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runOnce } from '../src/run.js';
import { formatReport } from '../src/report.js';
import { usageLimitText } from '../src/agent/runAgent.js';
import type { BloxConfig } from '../src/config.js';

const limited = {
  numTurns: 5, costUsd: 0.3, status: 'error' as const, stopReason: 'usage-limit' as const, detail: "You've hit your limit · resets 5pm",
  sessionId: null, gatedActions: [], deniedByUser: [], nonGatedDenials: [],
};

async function spies() {
  const buildMod = await import('../src/agent/buildOptions.js');
  const runMod = await import('../src/agent/runAgent.js');
  const oaMod = await import('../src/agent/openaiRunner.js');
  const syncMod = await import('../src/sync/rojo.js');
  const gitMod = await import('../src/git/commit.js');
  vi.spyOn(gitMod, 'commitChanges').mockResolvedValue({ sha: null, files: [] } as never);
  return {
    b: vi.spyOn(buildMod, 'buildQueryOptions').mockReturnValue({} as never),
    r: vi.spyOn(runMod, 'runAgent').mockResolvedValue(limited),
    o: vi.spyOn(oaMod, 'runOpenAiAgent').mockResolvedValue({ ...limited, numTurns: 9, costUsd: 0.01, status: 'success', stopReason: 'completed', detail: 'success' }),
    s: vi.spyOn(syncMod, 'syncProject').mockResolvedValue({ ok: true, detail: 'ok' } as never),
  };
}
const cfg = (extra: Partial<BloxConfig> = {}) =>
  ({ projectPath: mkdtempSync(join(tmpdir(), 'blox-fb-')), model: 'claude-opus-5-5', runner: 'claude', maxTurns: 40, maxBudgetUsd: 5, mode: 'auto', ...extra }) as BloxConfig;
const deps = { bridge: { toolCtx: {} } as never, digest: {} as never, authMode: 'subscription' as const };

afterEach(() => vi.restoreAllMocks());

describe('usage-limit fallback', () => {
  it('finishes on the fallback model through the openai runner', async () => {
    const { o } = await spies();
    const rep = await runOnce(cfg({ fallbackModel: 'openrouter,openai/gpt-6-luna' }), 'make a door', deps);
    expect(o).toHaveBeenCalledOnce();
    expect(o.mock.calls[0][0]).toMatch(/ran out of usage[^]*Task: make a door$/);
    expect(o.mock.calls[0][1]).toMatchObject({ model: 'openrouter,openai/gpt-6-luna', runner: 'openai' });
    expect(rep).toMatchObject({ model: 'openrouter,openai/gpt-6-luna', billing: 'provider', numTurns: 9, fallbackFrom: { model: 'claude-opus-5-5', turns: 5 } });
    expect(formatReport(rep)).toContain('fallback: claude-opus-5-5 stopped after 5 turns');
  });
  it('without a fallback model, stops and says how to set one', async () => {
    const { o } = await spies();
    const rep = await runOnce(cfg(), 'x', deps);
    expect(o).not.toHaveBeenCalled();
    expect(rep).toMatchObject({ stopReason: 'usage-limit', billing: 'subscription' });
    expect(rep.detail).toMatch(/--fallback-model/);
  });
  it('never falls back in relay mode or past the policy allowlist', async () => {
    const { o } = await spies();
    await runOnce(cfg({ fallbackModel: 'm' }), 'x', { ...deps, authMode: 'relay' });
    const rep = await runOnce(cfg({ fallbackModel: 'm', policy: { models: ['claude-opus-5-5'] } }), 'x', deps);
    expect(o).not.toHaveBeenCalled();
    expect(rep.detail).toMatch(/fallback m refused/);
  });
});

describe('usageLimitText', () => {
  it('recognizes the SDK limit shapes and nothing else', () => {
    expect(usageLimitText({ type: 'result', result: "You've hit your limit · resets 5pm" })).toMatch(/hit your limit/);
    expect(usageLimitText({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: "You've reached your weekly limit" }] } })).toMatch(/weekly/);
    expect(usageLimitText({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } })).toMatch(/limit/);
    expect(usageLimitText({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', overageStatus: 'allowed' } })).toBeNull();
    expect(usageLimitText({ type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: 'API Error: 429 overloaded' }] } })).toBeNull();
    expect(usageLimitText({ type: 'result', result: 'done' })).toBeNull();
  });
});
