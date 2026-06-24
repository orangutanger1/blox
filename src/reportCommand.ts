import { loadConfig } from './config.js';
import { reportOutput } from './usageReport.js';
import { readAuditEntries } from './audit.js';

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
