export interface RunReport {
  prompt: string;
  changedFiles: string[];
  commitSha: string | null;
  numTurns: number;
  costUsd: number;
  status: 'success' | 'error';
  stopReason?: string;
  detail?: string;
  mode?: 'auto' | 'ask';
  effort?: string;
  sessionId?: string | null;
  gatedActions?: { tool: string; input: Record<string, unknown> }[];
  deniedByUser?: string[];
  assetDecisions?: { tool: string; decision: 'approve' | 'reject'; source: 'dock' | 'timeout'; feedback?: string }[];
}

export function formatReport(r: RunReport): string {
  const lines = [
    `blox run — ${r.status}`,
    `prompt: ${r.prompt}`,
    ...(r.mode ? [`mode: ${r.mode}${r.effort ? `  effort: ${r.effort}` : ''}`] : []),
    `turns: ${r.numTurns}  cost: $${r.costUsd.toFixed(4)}`,
    ...(r.stopReason ? [`stop: ${r.stopReason}`] : []),
    ...(r.gatedActions && r.gatedActions.length
      ? [
          `blocked (needs approval):`,
          ...r.gatedActions.map((g) => `  ${g.tool}`),
          ...(r.sessionId ? [`session: ${r.sessionId}`] : []),
          `→ re-run with --auto to allow these actions`,
        ]
      : []),
    ...(r.deniedByUser && r.deniedByUser.length
      ? [`denied by user:`, ...r.deniedByUser.map((t) => `  ${t}`)]
      : []),
    ...(r.assetDecisions && r.assetDecisions.length
      ? [
          `assets:`,
          ...r.assetDecisions.map(
            (a) =>
              `  ${a.tool} — ${a.decision}` +
              (a.source === 'timeout' ? ' (unreviewed: gate timed out)' : '') +
              (a.feedback ? `  feedback: ${a.feedback}` : ''),
          ),
        ]
      : []),
    `changed files (${r.changedFiles.length}):`,
    ...r.changedFiles.map((f) => `  ${f}`),
    r.commitSha ? `commit: ${r.commitSha}` : 'commit: (none)',
  ];
  if (r.detail) lines.push(`detail: ${r.detail}`);
  return lines.join('\n');
}
