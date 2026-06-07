export interface RunReport {
  prompt: string;
  changedFiles: string[];
  commitSha: string | null;
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  stopReason?: string;
  detail?: string;
}

export function formatReport(r: RunReport): string {
  const lines = [
    `blox run — ${r.status}`,
    `prompt: ${r.prompt}`,
    `turns: ${r.numTurns}  cost: $${r.costUsd.toFixed(4)}`,
    ...(r.stopReason ? [`stop: ${r.stopReason}`] : []),
    `changed files (${r.changedFiles.length}):`,
    ...r.changedFiles.map((f) => `  ${f}`),
    r.commitSha ? `commit: ${r.commitSha}` : 'commit: (none)',
  ];
  if (r.detail) lines.push(`detail: ${r.detail}`);
  return lines.join('\n');
}
