import { describe, it, expect } from 'vitest';
import { formatTestRun, type TestRunResult } from '../src/testing/runner.js';
import { formatTask, type TaskState } from '../src/state/store.js';

const run = (tests: TestRunResult['tests']): TestRunResult => ({
  ok: tests.every((t) => t.status === 'pass'), total: tests.length, passed: tests.filter((t) => t.status === 'pass').length,
  failed: tests.filter((t) => t.status !== 'pass').length, tests, fileErrors: [], durationMs: 5, ranAt: '2026-10-01T00:00:00Z',
});

describe('compact tool output', () => {
  it('lists failures in full and passes on one line', () => {
    const out = formatTestRun(run([
      { file: 'tests/a.spec.luau', name: 'opens', status: 'pass', context: 'server' },
      { file: 'tests/a.spec.luau', name: 'closes', status: 'fail', context: 'server', message: 'a.spec.luau:9: expected true' },
    ] as TestRunResult['tests']));
    expect(out).toContain('FAIL [server] tests/a.spec.luau › closes\n        a.spec.luau:9: expected true');
    expect(out).toContain('ok (1): opens');
    expect(out.split('\n')).toHaveLength(4);
  });
  it('shows what specs printed, per context', () => {
    const r = { ...run([{ file: 'tests/a.spec.luau', name: 'soak', status: 'pass', context: 'server' }] as TestRunResult['tests']), output: [{ context: 'server' as const, line: 'soak 40 dogs: 0.5 ms' }] };
    expect(formatTestRun(r)).toContain('  output [server]: soak 40 dogs: 0.5 ms');
  });
  it('compact task shows passing criteria as ids only and omits the goal', () => {
    const task: TaskState = {
      goal: 'door works', notes: [], blockers: [], updatedAt: '',
      criteria: [
        { id: 'AC1', text: 'opens', tests: ['opens'], status: 'pending' },
        { id: 'AC2', text: 'closes', tests: ['closes'], status: 'pending' },
      ],
    };
    const lt = { ranAt: 'x', tests: [{ file: 'f', name: 'opens', status: 'pass' }, { file: 'f', name: 'closes', status: 'fail' }] };
    const out = formatTask(task, lt, { compact: true });
    expect(out).not.toContain('goal:');
    expect(out).toContain('criteria: 1/2 passing (AC1)');
    expect(out).toContain('[!] AC2: closes');
    expect(out).not.toContain('AC1: opens');
    expect(formatTask(task, lt)).toContain('goal: door works');
  });
});
