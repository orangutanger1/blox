import { describe, it, expect } from 'vitest';
import { classifyStop, summarizeResult } from '../src/agent/runAgent.js';

describe('classifyStop', () => {
  it('maps SDK result subtypes to stop reasons', () => {
    expect(classifyStop('success')).toBe('completed');
    expect(classifyStop('error_max_turns')).toBe('maxTurns');
    expect(classifyStop('error_max_budget_usd')).toBe('budget');
    expect(classifyStop('error_during_execution')).toBe('error');
    expect(classifyStop('anything_else')).toBe('error');
  });
});

const base = {
  subtype: 'success',
  num_turns: 3,
  total_cost_usd: 0.5,
  session_id: 'sess-123',
  permission_denials: [],
};

describe('summarizeResult', () => {
  it('passes through a clean success with the session id', () => {
    const r = summarizeResult(base);
    expect(r.status).toBe('success');
    expect(r.stopReason).toBe('completed');
    expect(r.sessionId).toBe('sess-123');
    expect(r.gatedActions).toEqual([]);
  });

  it('derives a gated stop from permission_denials and forces error status', () => {
    const r = summarizeResult({
      ...base,
      permission_denials: [
        { tool_name: 'mcp__Roblox_Studio__generate_mesh', tool_use_id: 't1', tool_input: { prompt: 'rock' } },
      ],
    });
    expect(r.stopReason).toBe('gated');
    expect(r.status).toBe('error');
    expect(r.gatedActions).toEqual([{ tool: 'mcp__Roblox_Studio__generate_mesh', input: { prompt: 'rock' } }]);
  });

  it('maps budget/turn subtypes when there are no denials', () => {
    expect(summarizeResult({ ...base, subtype: 'error_max_budget_usd' }).stopReason).toBe('budget');
    expect(summarizeResult({ ...base, subtype: 'error_max_turns' }).stopReason).toBe('maxTurns');
  });
});
