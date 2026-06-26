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

describe('formatReport — autonomy', () => {
  it('renders mode + effort lines when present', () => {
    const out = formatReport({
      prompt: 'p',
      changedFiles: [],
      commitSha: null,
      numTurns: 1,
      costUsd: 0,
      status: 'success',
      mode: 'ask',
      effort: 'xhigh',
    });
    expect(out).toContain('mode: ask');
    expect(out).toContain('effort: xhigh');
  });

  it('lists blocked actions, the session id, and the re-run hint on a gated stop', () => {
    const out = formatReport({
      prompt: 'make a rock',
      changedFiles: [],
      commitSha: null,
      numTurns: 2,
      costUsd: 0.1,
      status: 'error',
      stopReason: 'gated',
      mode: 'ask',
      sessionId: 'sess-9',
      gatedActions: [{ tool: 'mcp__Roblox_Studio__generate_mesh', input: { prompt: 'rock' } }],
    });
    expect(out).toContain('blocked (needs approval):');
    expect(out).toContain('mcp__Roblox_Studio__generate_mesh');
    expect(out).toContain('session: sess-9');
    expect(out).toContain('--auto');
  });

  it('prints a resume hint with the session id on an ordinary run', () => {
    const out = formatReport({
      prompt: 'build a tower',
      changedFiles: [],
      commitSha: 'abc',
      numTurns: 3,
      costUsd: 0.2,
      status: 'success',
      sessionId: 'sess-77',
    });
    expect(out).toContain('--resume sess-77');
  });

  it('omits the resume hint when there is no session id', () => {
    const out = formatReport({
      prompt: 'x',
      changedFiles: [],
      commitSha: null,
      numTurns: 1,
      costUsd: 0,
      status: 'success',
    });
    expect(out).not.toContain('--resume');
  });

  it('does not duplicate the resume hint on a gated run (session already shown)', () => {
    const out = formatReport({
      prompt: 'make a rock',
      changedFiles: [],
      commitSha: null,
      numTurns: 2,
      costUsd: 0.1,
      status: 'error',
      stopReason: 'gated',
      sessionId: 'sess-9',
      gatedActions: [{ tool: 'mcp__Roblox_Studio__generate_mesh', input: {} }],
    });
    expect(out).not.toContain('--resume');
  });
});

describe('formatReport — deniedByUser', () => {
  it('lists user-denied actions without the re-run hint', () => {
    const out = formatReport({
      prompt: 'p',
      changedFiles: [],
      commitSha: null,
      numTurns: 1,
      costUsd: 0.1,
      status: 'success',
      deniedByUser: ['mcp__Roblox_Studio__generate_mesh'],
    });
    expect(out).toContain('denied by user:');
    expect(out).toContain('  mcp__Roblox_Studio__generate_mesh');
    expect(out).not.toContain('re-run with --auto');
  });
});

describe('formatReport — assetDecisions', () => {
  const baseReport: RunReport = {
    prompt: 'p',
    changedFiles: [],
    commitSha: null,
    numTurns: 1,
    costUsd: 0,
    status: 'success',
  };

  it('renders the assets section with feedback and timeout note', () => {
    const out = formatReport({
      ...baseReport,
      assetDecisions: [
        { tool: 'mcp__Roblox_Studio__generate_mesh', decision: 'approve', source: 'dock' },
        { tool: 'mcp__Roblox_Studio__generate_mesh', decision: 'reject', source: 'dock', feedback: 'too tall' },
        { tool: 'mcp__Roblox_Studio__wait_job_finished', decision: 'approve', source: 'timeout' },
      ],
    });
    expect(out).toContain('assets:');
    expect(out).toContain('  mcp__Roblox_Studio__generate_mesh — approve');
    expect(out).toContain('  mcp__Roblox_Studio__generate_mesh — reject  feedback: too tall');
    expect(out).toContain('  mcp__Roblox_Studio__wait_job_finished — approve (unreviewed: gate timed out)');
  });

  it('omits the assets section when empty', () => {
    expect(formatReport({ ...baseReport, assetDecisions: [] })).not.toContain('assets:');
  });
});
