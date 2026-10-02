export interface ModelPrice { in: number; out: number }
export interface UsageTokens { input: number; output: number; cacheRead: number; cacheWrite: number }

// USD per 1M tokens. Model-specific data lives here (and in config overrides),
// never in the tools or agent guide. Unknown models price as 0 + unknownPrice.
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-fable-5-1': { in: 10, out: 50 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
  'claude-fable-5': { in: 10, out: 50 },
};

export function costUsd(
  u: UsageTokens,
  model: string,
  pricing: Record<string, ModelPrice>,
): { usd: number; unknownPrice: boolean } {
  const p = pricing[model];
  if (!p) return { usd: 0, unknownPrice: true };
  const inUsd = ((u.input + u.cacheRead * 0.1 + u.cacheWrite * 1.25) / 1_000_000) * p.in;
  const outUsd = (u.output / 1_000_000) * p.out;
  return { usd: inUsd + outUsd, unknownPrice: false };
}
