import { describe, it, expect, vi } from 'vitest';

// The SDK yields an error result and then throws (observed: "Reached maximum
// budget"). The run must keep that result instead of losing turns/cost.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => (async function* () {
    yield { type: 'result', subtype: 'error_max_budget_usd', num_turns: 8, total_cost_usd: 0.51, session_id: 's1' };
    throw new Error('Claude Code returned an error result: Reached maximum budget ($0.5)');
  })(),
}));

describe('runAgent', () => {
  it('keeps an error result the SDK yielded before throwing', async () => {
    const { runAgent } = await import('../src/agent/runAgent.js');
    const r = await runAgent('x', {} as never);
    expect(r).toMatchObject({ numTurns: 8, costUsd: 0.51, stopReason: 'budget', status: 'error' });
  });
});
