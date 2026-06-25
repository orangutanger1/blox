import { describe, it, expect } from 'vitest';
import { costUsd, type UsageTokens } from '../src/relay/pricing.js';

const price = { 'claude-opus-4-8': { in: 5, out: 25 } };
const u = (over: Partial<UsageTokens> = {}): UsageTokens =>
  ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...over });

describe('costUsd', () => {
  it('prices input + output per Mtok', () => {
    const r = costUsd(u({ input: 1_000_000, output: 1_000_000 }), 'claude-opus-4-8', price);
    expect(r.usd).toBeCloseTo(30); // 1*5 + 1*25
    expect(r.unknownPrice).toBe(false);
  });

  it('applies cache multipliers (read 0.1x, write 1.25x) to the input rate', () => {
    const r = costUsd(u({ cacheRead: 1_000_000, cacheWrite: 1_000_000 }), 'claude-opus-4-8', price);
    expect(r.usd).toBeCloseTo(0.1 * 5 + 1.25 * 5); // 0.5 + 6.25 = 6.75
  });

  it('flags an unknown model and costs 0', () => {
    const r = costUsd(u({ input: 1_000_000 }), 'mystery-model', price);
    expect(r.usd).toBe(0);
    expect(r.unknownPrice).toBe(true);
  });
});
