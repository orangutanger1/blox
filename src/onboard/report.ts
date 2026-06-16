// src/onboard/report.ts
import type { Conflict, Renamed } from './layout.js';

export interface OnboardReportData {
  written: string[];
  baselineSha: string | null;
  renamed: Renamed[];
  conflicts: Conflict[];
}

export function formatOnboardReport(d: OnboardReportData): string {
  if (d.conflicts.length > 0) {
    return [
      `blox init — conflicts (nothing written):`,
      ...d.conflicts.map((c) => `  ${c.fullName} → ${c.path}`),
      `→ rename the duplicate(s) in Studio and re-run, or re-run with --on-conflict suffix`,
    ].join('\n');
  }
  if (d.written.length === 0) {
    return 'blox init — nothing to onboard (no scripts found in the DataModel)';
  }
  const lines = [
    `blox init — onboarded ${d.written.length} scripts`,
    ...(d.renamed.length ? [`renamed ${d.renamed.length} to avoid collisions:`, ...d.renamed.map((r) => `  ${r.from} → ${r.to}`)] : []),
    `baseline: ${d.baselineSha ?? '(no commit)'}`,
    `→ next: \`blox doctor\` to verify Studio, then either:`,
    `    • CLI:  \`rojo serve\` + click Connect in Studio's Rojo plugin, then \`blox "<prompt>"\``,
    `    • dock: \`blox panel serve\` + open the blox Studio panel (BYO models via CCR run here)`,
  ];
  return lines.join('\n');
}
