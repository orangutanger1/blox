import type { Policy } from '../config.js';
import { readRelayEntries } from './ledger.js';

export type RelayReject = { status: 403; error: string };

export function enforceRelay(args: {
  model: string;
  member?: string;
  policy?: Policy;
  ledgerPath: string;
  now?: Date;
}): RelayReject | null {
  const p = args.policy;
  if (!p) return null;

  if (p.models && !p.models.includes(args.model)) {
    return { status: 403, error: `model "${args.model}" is not in the team allowlist [${p.models.join(', ')}]` };
  }

  if (p.rollingBudget) {
    const now = args.now ?? new Date();
    const cutoff = now.getTime() - p.rollingBudget.windowDays * 24 * 60 * 60 * 1000;
    let spent = 0;
    let mine = 0;
    for (const e of readRelayEntries(args.ledgerPath)) {
      const t = Date.parse(e.ts);
      if (Number.isNaN(t) || t < cutoff || !Number.isFinite(e.costUsd)) continue;
      spent += e.costUsd;
      if (e.user === args.member) mine += e.costUsd;
    }
    const days = p.rollingBudget.windowDays;
    if (spent >= p.rollingBudget.maxUsd) {
      return { status: 403, error: `team rolling budget reached: $${spent.toFixed(2)} spent in the last ${days}d meets/exceeds the $${p.rollingBudget.maxUsd} cap` };
    }
    const cap = p.rollingBudget.perMemberUsd;
    if (cap != null && args.member != null && mine >= cap) {
      return { status: 403, error: `your rolling budget reached: $${mine.toFixed(2)} spent in the last ${days}d meets/exceeds the $${cap} per-member cap` };
    }
  }
  return null;
}
