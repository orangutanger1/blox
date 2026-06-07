import { describe, it, expect } from 'vitest';
import { formatReport, type RunReport } from '../src/report.js';

describe('formatReport', () => {
  it('renders a success report with files and commit', () => {
    const r: RunReport = {
      prompt: 'add a comment',
      changedFiles: ['src/ReplicatedStorage/Greeter.luau'],
      commitSha: 'abc123',
      numTurns: 3,
      costUsd: 0.0123,
      status: 'success',
    };
    const out = formatReport(r);
    expect(out).toContain('blox run — success');
    expect(out).toContain('add a comment');
    expect(out).toContain('src/ReplicatedStorage/Greeter.luau');
    expect(out).toContain('commit: abc123');
    expect(out).toContain('$0.0123');
  });

  it('shows "(none)" when there is no commit', () => {
    const r: RunReport = {
      prompt: 'noop',
      changedFiles: [],
      commitSha: null,
      numTurns: 1,
      costUsd: 0,
      status: 'success',
    };
    expect(formatReport(r)).toContain('commit: (none)');
  });

  it('renders the stop reason when present', () => {
    const r: RunReport = {
      prompt: 'x',
      changedFiles: [],
      commitSha: null,
      numTurns: 2,
      costUsd: 0,
      status: 'error',
      stopReason: 'budget',
    };
    expect(formatReport(r)).toContain('stop: budget');
  });
});
