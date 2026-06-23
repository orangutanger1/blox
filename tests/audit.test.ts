import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEntry, readWindowSpend, auditPath, type AuditEntry } from '../src/audit.js';

function entry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: new Date().toISOString(),
    user: 'dev@example.com',
    model: 'claude-opus-4-8',
    turns: 3,
    costUsd: 1.5,
    status: 'success',
    commit: 'abc1234',
    prompt: 'do a thing',
    ...over,
  };
}

describe('audit ledger', () => {
  it('appends entries as one JSON line each, creating the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    appendAuditEntry(dir, entry());
    appendAuditEntry(dir, entry({ costUsd: 2 }));
    const lines = readFileSync(auditPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).costUsd).toBe(1.5);
  });

  it('readWindowSpend sums in-window and excludes out-of-window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    const now = new Date('2026-06-23T12:00:00Z');
    appendAuditEntry(dir, entry({ ts: '2026-06-22T12:00:00Z', costUsd: 10 })); // 1 day ago
    appendAuditEntry(dir, entry({ ts: '2026-05-01T12:00:00Z', costUsd: 99 })); // >30 days ago
    expect(readWindowSpend(dir, 30, now)).toBe(10);
  });

  it('returns 0 for a missing ledger and skips malformed lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    expect(readWindowSpend(dir, 30)).toBe(0);
    appendAuditEntry(dir, entry({ costUsd: 5 }));
    // corrupt the file with a junk line
    appendFileSync(auditPath(dir), 'not json\n');
    expect(readWindowSpend(dir, 30)).toBe(5);
  });
});
