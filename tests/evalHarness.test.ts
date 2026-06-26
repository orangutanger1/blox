import { describe, it, expect } from 'vitest';
import { scoreTask, runEvalSuite, type EvalTask, type EvalRunResult } from '../src/eval/harness.js';

const run = (over: Partial<EvalRunResult> = {}): EvalRunResult => ({
  status: 'success',
  numTurns: 3,
  costUsd: 0.05,
  ...over,
});

describe('scoreTask', () => {
  it('passes a successful run against the default success expectation', () => {
    const r = scoreTask({ name: 't', prompt: 'p' }, run());
    expect(r.passed).toBe(true);
    expect(r.reasons).toEqual([]);
    expect(r.name).toBe('t');
  });

  it('fails when the status does not match the expectation', () => {
    const r = scoreTask({ name: 't', prompt: 'p' }, run({ status: 'error' }));
    expect(r.passed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/status/);
  });

  it('honors an explicit expectStatus: error', () => {
    const r = scoreTask({ name: 't', prompt: 'p', expectStatus: 'error' }, run({ status: 'error' }));
    expect(r.passed).toBe(true);
  });

  it('fails when cost exceeds maxCostUsd', () => {
    const r = scoreTask({ name: 't', prompt: 'p', maxCostUsd: 0.01 }, run({ costUsd: 0.05 }));
    expect(r.passed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/cost/);
  });

  it('fails when turns exceed maxTurns', () => {
    const r = scoreTask({ name: 't', prompt: 'p', maxTurns: 2 }, run({ numTurns: 9 }));
    expect(r.passed).toBe(false);
    expect(r.reasons.join(' ')).toMatch(/turns/);
  });

  it('collects multiple failure reasons at once', () => {
    const r = scoreTask({ name: 't', prompt: 'p', maxCostUsd: 0.01, maxTurns: 2 }, run({ status: 'error', costUsd: 1, numTurns: 9 }));
    expect(r.passed).toBe(false);
    expect(r.reasons.length).toBe(3);
  });
});

describe('runEvalSuite', () => {
  const tasks: EvalTask[] = [
    { name: 'a', prompt: 'pa' },
    { name: 'b', prompt: 'pb', maxCostUsd: 0.01 },
  ];

  it('runs every task and aggregates pass/fail + total cost', async () => {
    const summary = await runEvalSuite(tasks, async (task) =>
      task.name === 'a' ? run({ costUsd: 0.02 }) : run({ costUsd: 0.5 }),
    );
    expect(summary.results.map((r) => r.name)).toEqual(['a', 'b']);
    expect(summary.passed).toBe(1); // a passes, b blows its cost ceiling
    expect(summary.failed).toBe(1);
    expect(summary.totalCostUsd).toBeCloseTo(0.52);
  });

  it('records a runner throw as a failed task rather than aborting the suite', async () => {
    const summary = await runEvalSuite(tasks, async (task) => {
      if (task.name === 'a') throw new Error('boom');
      return run({ costUsd: 0.005 }); // b stays under its 0.01 ceiling → passes
    });
    expect(summary.passed).toBe(1);
    expect(summary.failed).toBe(1);
    const a = summary.results.find((r) => r.name === 'a')!;
    expect(a.passed).toBe(false);
    expect(a.reasons.join(' ')).toMatch(/boom/);
  });
});
