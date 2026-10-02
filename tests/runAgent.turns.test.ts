import { describe, it, expect, vi } from 'vitest';

// The SDK yields one assistant message per content block and its num_turns
// counts about one per tool call. A turn is one model request: distinct ids.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => (async function* () {
    for (const id of ['m1', 'm1', 'm1', 'm2', 'm2', 'm3']) yield { type: 'assistant', message: { id, content: [] } };
    yield { type: 'result', subtype: 'success', num_turns: 6, total_cost_usd: 0.1, session_id: 's1' };
  })(),
}));

describe('runAgent turn count', () => {
  it('counts model requests, not SDK turns', async () => {
    const { runAgent } = await import('../src/agent/runAgent.js');
    const statuses: number[] = [];
    const r = await runAgent('x', {} as never, { sink: { emit: (e) => { if (e.type === 'status') statuses.push(e.turns); } } });
    expect(r.numTurns).toBe(3);
    expect(statuses).toEqual([1, 2, 3]);
  });
});
