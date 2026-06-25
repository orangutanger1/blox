import type { Policy } from '../config.js';
import { readRelayEntries } from './ledger.js';

export type RelayReject = { status: 403; error: string };

export function enforceRelay(args: {
  model: string;
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
    for (const e of readRelayEntries(args.ledgerPath)) {
      const t = Date.parse(e.ts);
      if (!Number.isNaN(t) && t >= cutoff && typeof e.costUsd === 'number') spent += e.costUsd;
    }
    if (spent >= p.rollingBudget.maxUsd) {
      return { status: 403, error: `team rolling budget reached: $${spent.toFixed(2)} spent in the last ${p.rollingBudget.windowDays}d meets/exceeds the $${p.rollingBudget.maxUsd} cap` };
    }
  }
  return null;
}
