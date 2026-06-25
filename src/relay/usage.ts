import type { UsageTokens } from './pricing.js';

function pick(u: Record<string, unknown> | undefined): Partial<UsageTokens> {
  if (!u) return {};
  const n = (k: string) => (typeof u[k] === 'number' ? (u[k] as number) : undefined);
  return { input: n('input_tokens'), output: n('output_tokens'), cacheRead: n('cache_read_input_tokens'), cacheWrite: n('cache_creation_input_tokens') };
}

export function usageFromJson(body: unknown): UsageTokens {
  const u = pick((body as { usage?: Record<string, unknown> } | null)?.usage);
  return { input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 };
}

export function usageFromSse(rawSse: string): UsageTokens {
  const out: UsageTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const line of rawSse.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let evt: unknown;
    try { evt = JSON.parse(line.slice(5).trim()); } catch { continue; }
    const e = evt as { type?: string; message?: { usage?: Record<string, unknown> }; usage?: Record<string, unknown> };
    if (e.type === 'message_start') {
      const u = pick(e.message?.usage);
      if (u.input != null) out.input = u.input;
      if (u.cacheRead != null) out.cacheRead = u.cacheRead;
      if (u.cacheWrite != null) out.cacheWrite = u.cacheWrite;
    } else if (e.type === 'message_delta') {
      const u = pick(e.usage);
      if (u.output != null) out.output = u.output;
    }
  }
  return out;
}
