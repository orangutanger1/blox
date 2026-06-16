import { describe, it, expect, afterEach } from 'vitest';
import { classifyStop, summarizeResult, buildPromptInput, computeIdleAbortMs } from '../src/agent/runAgent.js';

describe('computeIdleAbortMs', () => {
  afterEach(() => { delete process.env.BLOX_IDLE_ABORT_SECONDS; });
  it('defaults to 120s when unset', () => {
    expect(computeIdleAbortMs()).toBe(120_000);
  });
  it('honors a positive override', () => {
    process.env.BLOX_IDLE_ABORT_SECONDS = '45';
    expect(computeIdleAbortMs()).toBe(45_000);
  });
  it('0 disables (returns 0)', () => {
    process.env.BLOX_IDLE_ABORT_SECONDS = '0';
    expect(computeIdleAbortMs()).toBe(0);
  });
  it('falls back to default on garbage', () => {
    process.env.BLOX_IDLE_ABORT_SECONDS = 'nope';
    expect(computeIdleAbortMs()).toBe(120_000);
  });
});

describe('buildPromptInput', () => {
  it('returns the bare string when there is no image', () => {
    expect(buildPromptInput('do a thing')).toBe('do a thing');
  });

  it('returns a one-message stream with [text, image] when an image is present', async () => {
    const input = buildPromptInput('match this UI', { mediaType: 'image/png', base64: 'QUJD' });
    expect(typeof input).not.toBe('string');
    const msgs = [];
    for await (const m of input as AsyncIterable<unknown>) msgs.push(m);
    expect(msgs).toHaveLength(1);
    const m = msgs[0] as { type: string; message: { role: string; content: unknown[] } };
    expect(m.type).toBe('user');
    expect(m.message.role).toBe('user');
    expect(m.message.content).toEqual([
      { type: 'text', text: 'match this UI' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });
});

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

describe('summarizeResult — dock-denied split', () => {
  it('moves dock-denied tools out of gatedActions into deniedByUser', () => {
    const r = summarizeResult(
      {
        ...base,
        permission_denials: [
          { tool_name: 'mcp__Roblox_Studio__generate_mesh', tool_input: { prompt: 'rock' } },
          { tool_name: 'mcp__Roblox_Studio__start_stop_play', tool_input: {} },
        ],
      },
      ['mcp__Roblox_Studio__start_stop_play'],
    );
    expect(r.gatedActions).toEqual([{ tool: 'mcp__Roblox_Studio__generate_mesh', input: { prompt: 'rock' } }]);
    expect(r.deniedByUser).toEqual(['mcp__Roblox_Studio__start_stop_play']);
    expect(r.stopReason).toBe('gated'); // one denial remains unresolved
  });

  it('does not force gated/error when every denial was a dock decision', () => {
    const r = summarizeResult(
      {
        ...base,
        permission_denials: [{ tool_name: 'mcp__Roblox_Studio__generate_mesh', tool_input: {} }],
      },
      ['mcp__Roblox_Studio__generate_mesh'],
    );
    expect(r.status).toBe('success');
    expect(r.stopReason).toBe('completed');
    expect(r.gatedActions).toEqual([]);
    expect(r.deniedByUser).toEqual(['mcp__Roblox_Studio__generate_mesh']);
  });
});

describe('summarizeResult — duplicate denials', () => {
  it('consumes one dockDenied entry per matching denial (multiset)', () => {
    const r = summarizeResult(
      {
        ...base,
        permission_denials: [
          { tool_name: 'mcp__Roblox_Studio__generate_mesh', tool_input: { prompt: 'a' } },
          { tool_name: 'mcp__Roblox_Studio__generate_mesh', tool_input: { prompt: 'b' } },
        ],
      },
      ['mcp__Roblox_Studio__generate_mesh'],
    );
    expect(r.deniedByUser).toEqual(['mcp__Roblox_Studio__generate_mesh']);
    expect(r.gatedActions).toEqual([{ tool: 'mcp__Roblox_Studio__generate_mesh', input: { prompt: 'b' } }]);
    expect(r.stopReason).toBe('gated');
  });
});
