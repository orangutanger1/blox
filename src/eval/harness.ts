// Eval harness for benchmarking blox runs against a fixed task suite. The
// SCORING and AGGREGATION are pure and live-Studio-free (unit-tested with an
// injected runner). The real runner — wiring each task to runOnce against a
// live Studio + model — is the live-gated part: a benchmark inherently makes
// real model calls and needs a connected Studio to mean anything.
//
// Use it to objectively tune routedMaxTurns per model and prove model quality
// instead of guessing.

export interface EvalTask {
  name: string;
  prompt: string;
  expectStatus?: 'success' | 'error'; // default 'success'
  maxCostUsd?: number; // optional cost ceiling
  maxTurns?: number; // optional turn ceiling
}

export interface EvalRunResult {
  status: 'success' | 'error';
  numTurns: number;
  costUsd: number;
}

export interface EvalResult extends EvalRunResult {
  name: string;
  passed: boolean;
  reasons: string[]; // empty when passed
}

export interface EvalSummary {
  results: EvalResult[];
  passed: number;
  failed: number;
  totalCostUsd: number;
}

// Pure pass/fail scoring: status must match the expectation, and any optional
// cost/turn ceiling must hold. Reasons accumulate so a run can report every way
// it missed at once.
export function scoreTask(task: EvalTask, run: EvalRunResult): EvalResult {
  const reasons: string[] = [];
  const expect = task.expectStatus ?? 'success';
  if (run.status !== expect) reasons.push(`status ${run.status} ≠ expected ${expect}`);
  if (task.maxCostUsd !== undefined && run.costUsd > task.maxCostUsd) {
    reasons.push(`cost $${run.costUsd.toFixed(4)} > max $${task.maxCostUsd.toFixed(4)}`);
  }
  if (task.maxTurns !== undefined && run.numTurns > task.maxTurns) {
    reasons.push(`turns ${run.numTurns} > max ${task.maxTurns}`);
  }
  return { name: task.name, ...run, passed: reasons.length === 0, reasons };
}

export type EvalRunner = (task: EvalTask) => Promise<EvalRunResult>;

// Run every task through the injected runner, score each, and aggregate. A
// runner throw is captured as a failed result (with the error message) so one
// bad task never aborts the suite.
export async function runEvalSuite(tasks: EvalTask[], runner: EvalRunner): Promise<EvalSummary> {
  const results: EvalResult[] = [];
  for (const task of tasks) {
    try {
      results.push(scoreTask(task, await runner(task)));
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      results.push({
        name: task.name,
        status: 'error',
        numTurns: 0,
        costUsd: 0,
        passed: false,
        reasons: [`runner threw: ${msg}`],
      });
    }
  }
  return {
    results,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    totalCostUsd: results.reduce((s, r) => s + r.costUsd, 0),
  };
}

export function formatEvalSummary(summary: EvalSummary): string {
  const lines = [`blox eval — ${summary.passed}/${summary.results.length} passed`];
  for (const r of summary.results) {
    lines.push(
      `  ${r.passed ? 'PASS' : 'FAIL'} ${r.name} — ${r.status}, ${r.numTurns} turns, $${r.costUsd.toFixed(4)}` +
        (r.reasons.length ? `\n      ${r.reasons.join('; ')}` : ''),
    );
  }
  lines.push(`total cost: $${summary.totalCostUsd.toFixed(4)}`);
  return lines.join('\n');
}
