import type { AuditEntry } from './audit.js';

export interface UsageBucket {
  key: string;
  costUsd: number;
  runs: number;
}

export interface UsageSummary {
  window: { days: number | null; since: string | null };
  totalUsd: number;
  capUsd: number | null;
  capPct: number | null;
  runCount: number;
  errorCount: number;
  byUser: UsageBucket[];
  byModel: UsageBucket[];
}

function bucketsOf(entries: { key: string; cost: number }[]): UsageBucket[] {
  const m = new Map<string, UsageBucket>();
  for (const { key, cost } of entries) {
    const b = m.get(key) ?? { key, costUsd: 0, runs: 0 };
    b.costUsd += cost;
    b.runs += 1;
    m.set(key, b);
  }
  // cost desc, then key asc for a stable order
  return [...m.values()].sort((a, b) => b.costUsd - a.costUsd || a.key.localeCompare(b.key));
}

export function aggregateUsage(
  entries: AuditEntry[],
  opts: { now: Date; windowDays?: number | null; capUsd?: number | null },
): UsageSummary {
  const windowDays = opts.windowDays ?? null;
  const capUsd = opts.capUsd ?? null;
  const cutoff = windowDays != null ? opts.now.getTime() - windowDays * 24 * 60 * 60 * 1000 : null;

  const inWindow = entries.filter((e) => {
    if (cutoff == null) return true; // all-time keeps everything, even unparseable ts
    const t = Date.parse(e.ts);
    return !Number.isNaN(t) && t >= cutoff;
  });

  const cost = (e: AuditEntry) => (typeof e.costUsd === 'number' ? e.costUsd : 0);
  const totalUsd = inWindow.reduce((s, e) => s + cost(e), 0);

  return {
    window: { days: windowDays, since: cutoff != null ? new Date(cutoff).toISOString() : null },
    totalUsd,
    capUsd,
    capPct: capUsd ? totalUsd / capUsd : null,
    runCount: inWindow.length,
    errorCount: inWindow.filter((e) => e.status === 'error').length,
    byUser: bucketsOf(inWindow.map((e) => ({ key: e.user || '(unknown)', cost: cost(e) }))),
    byModel: bucketsOf(inWindow.map((e) => ({ key: e.model || '(unknown)', cost: cost(e) }))),
  };
}

const usd = (n: number) => `$${n.toFixed(2)}`;

function bar(pct: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(pct * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

export function renderUsageTable(s: UsageSummary): string {
  const lines: string[] = [];
  const win = s.window.days != null ? `last ${s.window.days}d` : 'all time';
  lines.push(`blox usage — ${win}`);
  if (s.capUsd != null && s.capPct != null) {
    const pct = Math.round(s.capPct * 100);
    lines.push(`  used ${usd(s.totalUsd)} / cap ${usd(s.capUsd)}  ${bar(s.capPct)}  ${pct}%`);
  } else {
    lines.push(`  used ${usd(s.totalUsd)}`);
  }
  lines.push('');
  lines.push('By user');
  for (const b of s.byUser) lines.push(`  ${b.key}  ${usd(b.costUsd)}  ${b.runs} runs`);
  lines.push('');
  lines.push('By model');
  for (const b of s.byModel) lines.push(`  ${b.key}  ${usd(b.costUsd)}`);
  lines.push('');
  lines.push(`${s.runCount} runs, ${s.errorCount} errors in window`);
  return lines.join('\n');
}
