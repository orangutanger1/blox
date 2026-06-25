import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEntry, readWindowSpend, readAuditEntries, auditPath, appendJsonl, readJsonl, type AuditEntry } from '../src/audit.js';

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

describe('readAuditEntries', () => {
  it('returns [] when the ledger is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    expect(readAuditEntries(dir)).toEqual([]);
  });

  it('parses good lines and skips malformed ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'blox-'));
    appendAuditEntry(dir, entry({ costUsd: 1 }));
    appendFileSync(auditPath(dir), 'not json\n');
    appendAuditEntry(dir, entry({ costUsd: 2 }));
    const got = readAuditEntries(dir);
    expect(got.map((e) => e.costUsd)).toEqual([1, 2]);
  });
});

describe('jsonl generics', () => {
  it('appendJsonl + readJsonl round-trips and skips malformed lines', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'blox-')), 'x.jsonl');
    appendJsonl(f, { a: 1 });
    appendFileSync(f, 'garbage\n');
    appendJsonl(f, { a: 2 });
    expect(readJsonl<{ a: number }>(f).map((e) => e.a)).toEqual([1, 2]);
  });
  it('readJsonl returns [] for an absent file', () => {
    expect(readJsonl('/no/such/file.jsonl')).toEqual([]);
  });
});
