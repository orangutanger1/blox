import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReport } from '../src/reportCommand.js';
import { appendAuditEntry } from '../src/audit.js';

describe('runReport', () => {
  it('reads the project ledger and renders a table', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    appendAuditEntry(dir, {
      ts: new Date().toISOString(), user: 'a@x.com', model: 'claude-opus-4-8',
      turns: 1, costUsd: 3, status: 'success', commit: null, prompt: 'p',
    });
    const out = runReport({ projectPath: dir, since: null, json: false, now: new Date() });
    expect(out).toContain('a@x.com');
    expect(out).toContain('$3.00');
  });

  it('honors --json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    appendAuditEntry(dir, {
      ts: new Date().toISOString(), user: 'a@x.com', model: 'm',
      turns: 1, costUsd: 2, status: 'success', commit: null, prompt: 'p',
    });
    const out = runReport({ projectPath: dir, since: null, json: true, now: new Date() });
    expect(JSON.parse(out).totalUsd).toBe(2);
  });
});
