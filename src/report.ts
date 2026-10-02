// Who pays for a run, so a cost figure isn't misread. Subscription runs report
// the API-equivalent price of their tokens (not charged; they count against
// plan limits); the others are real charges.
export type Billing = 'subscription' | 'apiKey' | 'relay' | 'provider';

export const BILLING_NOTE: Record<Billing, string> = {
  subscription: 'subscription (cost is API-equivalent, not charged)',
  apiKey: 'API key (billed)',
  relay: 'team relay (billed to the team key)',
  provider: 'model provider (billed)',
};

export interface RunReport {
  prompt: string;
  changedFiles: string[];
  commitSha: string | null;
  numTurns: number;
  costUsd: number;
  costUnknown?: boolean;
  billing?: Billing;
  model?: string;
  tokens?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  status: 'success' | 'error';
  stopReason?: string;
  detail?: string;
  mode?: 'auto' | 'ask';
  effort?: string;
  sessionId?: string | null;
  gatedActions?: { tool: string; input: Record<string, unknown> }[];
  deniedByUser?: string[];
  nonGatedDenials?: string[];
  assetDecisions?: { tool: string; decision: 'approve' | 'reject'; source: 'dock' | 'timeout'; feedback?: string }[];
}

export function formatReport(r: RunReport): string {
  const lines = [
    `blox run — ${r.status}`,
    `prompt: ${r.prompt}`,
    ...(r.mode ? [`mode: ${r.mode}${r.effort ? `  effort: ${r.effort}` : ''}`] : []),
    `turns: ${r.numTurns}  cost: ${r.costUnknown ? 'unknown' : `$${r.costUsd.toFixed(4)}`}`,
    ...(r.billing ? [`billing: ${BILLING_NOTE[r.billing]}`] : []),
    ...(r.model ? [`model: ${r.model}`] : []),
    ...(r.tokens
      ? [`tokens: input=${r.tokens.input} cache_read=${r.tokens.cacheRead} cache_write=${r.tokens.cacheWrite} output=${r.tokens.output}`]
      : []),
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
    ...(r.nonGatedDenials && r.nonGatedDenials.length
      ? [`blocked (non-fatal, agent continued):`, ...r.nonGatedDenials.map((t) => `  ${t}`)]
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
    // Resume hint. The gated block already prints `session: <id>` with its own
    // re-run guidance, so suppress the duplicate there.
    ...(r.sessionId && !(r.gatedActions && r.gatedActions.length)
      ? [`resume: blox --resume ${r.sessionId} "<follow-up>"`]
      : []),
  ];
  if (r.detail) lines.push(`detail: ${r.detail}`);
  return lines.join('\n');
}
