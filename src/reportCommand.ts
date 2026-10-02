import { loadConfig } from './config.js';
import { renderUsageTable, reportOutput } from './usageReport.js';
import { effectiveAuthMode, fetchRelayUsage, loadAuthStore, type AuthStore } from './auth.js';
import { readAuditEntries } from './audit.js';

// `blox report`: this project's ledger, or the team relay's in relay mode
// (--local forces the project ledger, --relay the relay).
export async function runReportCommand(opts: {
  projectPath: string;
  since: number | null;
  json: boolean;
  source: 'auto' | 'local' | 'relay';
  store?: AuthStore;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const store = opts.store ?? loadAuthStore();
  const useRelay = opts.source === 'relay' || (opts.source === 'auto' && effectiveAuthMode(store) === 'relay');
  if (!useRelay) return runReport(opts);
  if (!store.relay) throw new Error('no team relay linked (`blox auth relay <url>`)');
  const s = await fetchRelayUsage(store.relay, opts.since, opts.fetchImpl);
  return opts.json ? JSON.stringify(s, null, 2) : `${renderUsageTable(s)}\nrelay: ${store.relay.url}`;
}

export function runReport(opts: {
  projectPath: string;
  since: number | null;
  json: boolean;
  now?: Date;
}): string {
  const config = loadConfig(opts.projectPath, { projectPath: opts.projectPath });
  return reportOutput(readAuditEntries(config.projectPath), {
    now: opts.now ?? new Date(),
    sinceDays: opts.since,
    rollingBudget: config.policy?.rollingBudget ?? null,
    json: opts.json,
  });
}
