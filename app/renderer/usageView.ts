import type { UsageSummary } from '../shared/panelClient.js';

const usd = (n: number) => `$${n.toFixed(2)}`;

export function usageHtml(s: UsageSummary | null): string {
  if (!s) return '<p>usage unavailable</p>';
  const win = s.window.days != null ? `last ${s.window.days}d` : 'all time';
  const cap =
    s.capUsd != null && s.capPct != null
      ? `used ${usd(s.totalUsd)} / cap ${usd(s.capUsd)} (${Math.round(s.capPct * 100)}%)`
      : `used ${usd(s.totalUsd)}`;
  // ponytail: b.key is interpolated raw — safe while the ledger is a local,
  // team-committed file. P5-c: when the relay syncs ledger data from a server,
  // that data is untrusted; HTML-escape b.key here before rendering.
  const rows = (bs: { key: string; costUsd: number; runs?: number }[]) =>
    bs.map((b) => `<tr><td>${b.key}</td><td>${usd(b.costUsd)}</td><td>${b.runs ?? ''}</td></tr>`).join('');
  return `
    <h3>Usage — ${win}</h3>
    <p>${cap} · ${s.runCount} runs, ${s.errorCount} errors</p>
    <table><thead><tr><th>User</th><th>Cost</th><th>Runs</th></tr></thead><tbody>${rows(s.byUser)}</tbody></table>
    <table><thead><tr><th>Model</th><th>Cost</th><th></th></tr></thead><tbody>${rows(s.byModel)}</tbody></table>
  `;
}
